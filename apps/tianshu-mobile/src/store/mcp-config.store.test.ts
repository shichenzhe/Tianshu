import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENDPOINTS } from "@tianshu/protocol";

const connMock = vi.hoisted(() => ({
  activeTransport: vi.fn(),
  activeConnId: "c1" as string | null,
  capabilities: ["chat", "mcp"] as string[] | null,
  transport: null as null | { request: ReturnType<typeof vi.fn> },
  useConnectionsStore: {
    getState: () => ({
      activeConnId: connMock.activeConnId,
      capabilitiesByConn: connMock.activeConnId
        ? { [connMock.activeConnId]: connMock.capabilities }
        : {},
    }),
    subscribe: () => () => {},
  },
}));

vi.mock("./connections.store", () => ({
  activeTransport: connMock.activeTransport,
  useConnectionsStore: connMock.useConnectionsStore,
}));

import { pollMcpStatusesTick, useMcpConfigStore } from "./mcp-config.store";

function makeTransport() {
  return { request: vi.fn() };
}

function successBody(data: unknown) {
  return {
    status: 200,
    body: { code: "2000", success: true, data, message: "success" },
  };
}

function failureBody(code: string, message: string) {
  return { status: 200, body: { code, success: false, data: null, message } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const QUERY_ROW = {
  id: 1,
  name: "文件服务",
  transport: "http",
  command: null,
  url: "https://mcp.example.com",
  enabled: true,
};

const STDIO_ROW = {
  id: 2,
  name: "本地命令",
  transport: "stdio",
  command: "npx",
  url: null,
  enabled: false,
};

const STATUS_ITEM = {
  id: 1,
  name: "文件服务",
  state: "connected",
  toolCount: 3,
};

const DETAIL_HTTP = {
  id: 1,
  name: "文件服务",
  transport: "http",
  command: null,
  url: "https://mcp.example.com",
  enabled: true,
  args: [],
  env: {},
  headers: { "X-Key": "__REDACTED__" },
};

describe("mcp-config.store", () => {
  beforeEach(() => {
    connMock.activeTransport.mockReset();
    connMock.activeConnId = "c1";
    connMock.capabilities = ["chat", "mcp"];
    connMock.transport = null;
    connMock.activeTransport.mockImplementation(() => connMock.transport);
    useMcpConfigStore.getState().resetForTest();
  });

  it("load 走 mcp/query + mcp/statuses 按 id 合并运行态", async () => {
    const t = makeTransport();
    t.request.mockImplementation((_m: string, path: string) => {
      if (path === ENDPOINTS.mcp.query) {
        return Promise.resolve(successBody([QUERY_ROW, STDIO_ROW]));
      }
      return Promise.resolve(successBody([STATUS_ITEM]));
    });
    connMock.activeTransport.mockReturnValue(t);
    await useMcpConfigStore.getState().load();
    const s = useMcpConfigStore.getState();
    expect(s.rows).toHaveLength(2);
    expect(s.rows[0].status?.state).toBe("connected");
    expect(s.rows[0].status?.toolCount).toBe(3);
    // stdio 行无对应 status → null（行仍可见可管理）
    expect(s.rows[1].status).toBeNull();
    expect(s.initialized).toBe(true);
    expect(t.request).toHaveBeenCalledWith("POST", ENDPOINTS.mcp.query, null);
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.mcp.statuses,
      null,
    );
  });

  it("statuses 失败（旧被控端）行保留 null 运行态不阻断列表", async () => {
    const t = makeTransport();
    t.request.mockImplementation((_m: string, path: string) => {
      if (path === ENDPOINTS.mcp.query) {
        return Promise.resolve(successBody([QUERY_ROW]));
      }
      return Promise.resolve(failureBody("404", "unknown endpoint"));
    });
    connMock.activeTransport.mockReturnValue(t);
    await useMcpConfigStore.getState().load();
    const s = useMcpConfigStore.getState();
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].status).toBeNull();
    expect(s.initialized).toBe(true);
  });

  it("refreshStatuses 只刷新运行态不重拉列表", async () => {
    const t = makeTransport();
    t.request.mockImplementation((_m: string, path: string) => {
      if (path === ENDPOINTS.mcp.query) {
        return Promise.resolve(successBody([QUERY_ROW]));
      }
      return Promise.resolve(
        successBody([{ ...STATUS_ITEM, state: "error", error: "超时" }]),
      );
    });
    connMock.activeTransport.mockReturnValue(t);
    await useMcpConfigStore.getState().load();
    t.request.mockClear();
    await useMcpConfigStore.getState().refreshStatuses();
    expect(
      t.request.mock.calls.some((call) => call[1] === ENDPOINTS.mcp.query),
    ).toBe(false);
    expect(useMcpConfigStore.getState().rows[0].status?.state).toBe("error");
  });

  it("refreshStatuses 并发触发共享 in-flight 守卫不叠加请求", async () => {
    const t = makeTransport();
    const statusesResponse = deferred<unknown>();
    t.request.mockImplementation((_m: string, path: string) => {
      if (path === ENDPOINTS.mcp.query) {
        return Promise.resolve(successBody([QUERY_ROW]));
      }
      return Promise.resolve(successBody([STATUS_ITEM]));
    });
    connMock.activeTransport.mockReturnValue(t);
    await useMcpConfigStore.getState().load();
    t.request.mockClear();
    // load 完成后 statuses 切换为挂起响应：并发触发只发一次请求
    t.request.mockImplementation((_m: string, path: string) => {
      if (path === ENDPOINTS.mcp.query) {
        return Promise.resolve(successBody([QUERY_ROW]));
      }
      return statusesResponse.promise;
    });
    const first = useMcpConfigStore.getState().refreshStatuses();
    const second = useMcpConfigStore.getState().refreshStatuses();
    await Promise.resolve();
    // 进行中的刷新被跳过：statuses 只发一次
    expect(
      t.request.mock.calls.filter((call) => call[1] === ENDPOINTS.mcp.statuses),
    ).toHaveLength(1);
    statusesResponse.resolve(successBody([STATUS_ITEM]));
    await Promise.all([first, second]);
    // 守卫释放后下一次刷新正常发出
    await useMcpConfigStore.getState().refreshStatuses();
    expect(
      t.request.mock.calls.filter((call) => call[1] === ENDPOINTS.mcp.statuses),
    ).toHaveLength(2);
  });

  it("轮询 tick 纯调用触发刷新且 tick 间不叠加并发", async () => {
    const t = makeTransport();
    const statusesResponse = deferred<unknown>();
    t.request.mockImplementation((_m: string, path: string) => {
      if (path === ENDPOINTS.mcp.query) {
        return Promise.resolve(successBody([QUERY_ROW]));
      }
      return Promise.resolve(successBody([STATUS_ITEM]));
    });
    connMock.activeTransport.mockReturnValue(t);
    await useMcpConfigStore.getState().load();
    t.request.mockClear();
    // load 完成后 statuses 切换为挂起响应：并发 tick 只发一次请求
    t.request.mockImplementation((_m: string, path: string) => {
      if (path === ENDPOINTS.mcp.query) {
        return Promise.resolve(successBody([QUERY_ROW]));
      }
      return statusesResponse.promise;
    });
    pollMcpStatusesTick();
    pollMcpStatusesTick();
    await Promise.resolve();
    expect(
      t.request.mock.calls.filter((call) => call[1] === ENDPOINTS.mcp.statuses),
    ).toHaveLength(1);
    statusesResponse.resolve(successBody([STATUS_ITEM]));
    await new Promise((resolve) => setImmediate(resolve));
    // 慢响应完成后下一 tick 恢复轮询
    pollMcpStatusesTick();
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      t.request.mock.calls.filter((call) => call[1] === ENDPOINTS.mcp.statuses),
    ).toHaveLength(2);
  });

  it("loadDetail 走 mcp/detail 透传掩码形状", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody(DETAIL_HTTP));
    connMock.activeTransport.mockReturnValue(t);
    const detail = await useMcpConfigStore.getState().loadDetail(1);
    expect(t.request).toHaveBeenCalledWith("POST", ENDPOINTS.mcp.detail, {
      id: 1,
    });
    expect(detail?.headers).toEqual({ "X-Key": "__REDACTED__" });
    expect(detail?.transport).toBe("http");
  });

  it("saveHttp 走 mcp/save 且写后重拉列表", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody(null));
    connMock.activeTransport.mockReturnValue(t);
    const payload = {
      name: "文件服务",
      url: "https://mcp.example.com",
      headers: { "X-Key": "real" },
    };
    const ok = await useMcpConfigStore.getState().saveHttp(payload);
    expect(ok).toBe(true);
    const writeCall = t.request.mock.calls.find(
      (call) => call[1] === ENDPOINTS.mcp.save,
    );
    expect(writeCall?.[2]).toEqual(payload);
    const listCall = t.request.mock.calls.find(
      (call) => call[1] === ENDPOINTS.mcp.query,
    );
    expect(listCall).toBeDefined();
  });

  it("remove 走 mcp/delete 且写后重拉", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody(null));
    connMock.activeTransport.mockReturnValue(t);
    const ok = await useMcpConfigStore.getState().remove(1);
    expect(ok).toBe(true);
    expect(t.request).toHaveBeenCalledWith("POST", ENDPOINTS.mcp.delete, {
      id: 1,
    });
  });

  it("reconnect 走 mcp/reconnect 且只刷新运行态", async () => {
    const t = makeTransport();
    t.request.mockImplementation((_m: string, path: string) => {
      if (path === ENDPOINTS.mcp.reconnect) {
        return Promise.resolve(successBody(null));
      }
      return Promise.resolve(successBody([QUERY_ROW]));
    });
    connMock.activeTransport.mockReturnValue(t);
    const ok = await useMcpConfigStore.getState().reconnect(1);
    expect(ok).toBe(true);
    expect(t.request).toHaveBeenCalledWith("POST", ENDPOINTS.mcp.reconnect, {
      id: 1,
    });
    // reconnect 后 refreshStatuses：statuses 调用出现、query 不重复
    expect(
      t.request.mock.calls.filter((call) => call[1] === ENDPOINTS.mcp.statuses),
    ).toHaveLength(1);
    expect(
      t.request.mock.calls.filter((call) => call[1] === ENDPOINTS.mcp.query),
    ).toHaveLength(0);
  });

  it("setEnabled 走 mcp/setEnabled 写面；patchEnabled 乐观补丁", async () => {
    const t = makeTransport();
    t.request.mockImplementation((_m: string, path: string) => {
      if (path === ENDPOINTS.mcp.query) {
        return Promise.resolve(successBody([QUERY_ROW]));
      }
      if (path === ENDPOINTS.mcp.statuses) {
        return Promise.resolve(successBody([]));
      }
      return Promise.resolve(successBody(null));
    });
    connMock.activeTransport.mockReturnValue(t);
    useMcpConfigStore.getState().patchEnabled(1, false);
    // 补丁作用于现有行——空列表时无行可补
    expect(
      useMcpConfigStore.getState().rows.find((r) => r.id === 1),
    ).toBeUndefined();
    await useMcpConfigStore.getState().load();
    t.request.mockClear();
    useMcpConfigStore.getState().patchEnabled(1, false);
    expect(
      useMcpConfigStore.getState().rows.find((r) => r.id === 1)?.enabled,
    ).toBe(false);
    const ok = await useMcpConfigStore.getState().setEnabled(1, true);
    expect(ok).toBe(true);
    expect(t.request).toHaveBeenCalledWith("POST", ENDPOINTS.mcp.setEnabled, {
      id: 1,
      enabled: true,
    });
  });

  it("写面串行且旧写完成不提前清除 saving", async () => {
    const t = makeTransport();
    connMock.activeTransport.mockReturnValue(t);
    const firstResponse = deferred<unknown>();
    const secondResponse = deferred<unknown>();
    t.request
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);
    const first = useMcpConfigStore.getState().remove(1);
    const second = useMcpConfigStore.getState().remove(2);
    await Promise.resolve();
    expect(t.request).toHaveBeenCalledTimes(1);
    expect(useMcpConfigStore.getState().saving).toBe(true);
    firstResponse.resolve(successBody(null));
    await first;
    await Promise.resolve();
    expect(t.request).toHaveBeenCalledTimes(2);
    secondResponse.resolve(successBody(null));
    await second;
    expect(useMcpConfigStore.getState().saving).toBe(false);
  });

  it("无 mcp 能力/无连接时不发请求且写面返回 false", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody([QUERY_ROW]));
    connMock.activeTransport.mockReturnValue(t);
    connMock.capabilities = ["chat"];
    await useMcpConfigStore.getState().load();
    const ok = await useMcpConfigStore.getState().remove(1);
    expect(t.request).not.toHaveBeenCalled();
    expect(ok).toBe(false);
    expect(useMcpConfigStore.getState().initialized).toBe(false);
  });

  it("MCP_STDIO_FORBIDDEN 业务错置 error（code 优先）", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(
      failureBody("MCP_STDIO_FORBIDDEN", "stdio 请用桌面端编辑"),
    );
    connMock.activeTransport.mockReturnValue(t);
    const ok = await useMcpConfigStore.getState().saveHttp({
      id: 2,
      name: "本地命令",
      url: "https://x.example.com",
    });
    expect(ok).toBe(false);
    expect(useMcpConfigStore.getState().error).toBe("MCP_STDIO_FORBIDDEN");
  });

  it("切连接后丢弃旧主机迟到的 load 响应", async () => {
    const transportA = makeTransport();
    const transportB = makeTransport();
    const responseA = deferred<unknown>();
    const responseB = deferred<unknown>();
    transportA.request.mockReturnValue(responseA.promise);
    transportB.request.mockReturnValue(responseB.promise);
    connMock.transport = transportA;
    const loadA = useMcpConfigStore.getState().load();
    connMock.activeConnId = "c2";
    connMock.transport = transportB;
    const loadB = useMcpConfigStore.getState().load();
    responseB.resolve(successBody([{ ...QUERY_ROW, name: "B服务" }]));
    await loadB;
    responseA.resolve(successBody([QUERY_ROW]));
    await loadA;
    expect(useMcpConfigStore.getState().rows[0]?.name).toBe("B服务");
  });
});
