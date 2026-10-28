import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENDPOINTS, type PermissionRememberedItem } from "@tianshu/protocol";

const connMock = vi.hoisted(() => ({
  activeTransport: vi.fn(),
  activeConnId: "c1" as string | null,
  capabilities: ["chat"] as string[] | null,
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

import { usePermissionStore } from "./permission.store";

function makeTransport() {
  return { request: vi.fn() };
}

function rememberedDto(
  overrides: Partial<PermissionRememberedItem> = {},
): PermissionRememberedItem {
  return {
    id: 1,
    workspaceName: "默认空间",
    toolName: "bash",
    createdAt: "2026-10-26T00:00:00.000Z",
    ...overrides,
  };
}

function fullGrantDto(overrides: Record<string, unknown> = {}) {
  return { sessionId: 7, title: "调研任务", ...overrides };
}

function successBody(data: unknown) {
  return {
    status: 200,
    body: { code: "2000", success: true, data, message: "success" },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("permission.store", () => {
  beforeEach(() => {
    connMock.activeTransport.mockReset();
    connMock.activeConnId = "c1";
    connMock.capabilities = ["chat"];
    connMock.transport = null;
    connMock.activeTransport.mockImplementation(() => connMock.transport);
    usePermissionStore.getState().resetForTest();
  });

  it("load 并行拉双读面并解包 remembered+grants", async () => {
    const t = makeTransport();
    t.request
      .mockResolvedValueOnce(successBody([rememberedDto()]))
      .mockResolvedValueOnce(successBody({ grants: [fullGrantDto()] }));
    connMock.activeTransport.mockReturnValue(t);
    await usePermissionStore.getState().load();
    const s = usePermissionStore.getState();
    expect(s.remembered).toHaveLength(1);
    expect(s.fullGrants).toHaveLength(1);
    expect(s.initialized).toBe(true);
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.permission.listRemembered,
      null,
    );
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.permission.listFullGrants,
      null,
    );
  });

  it("load 解析失败（缺字段/形状非法）置 error", async () => {
    const t = makeTransport();
    t.request
      .mockResolvedValueOnce(successBody([{ id: 1 }]))
      .mockResolvedValueOnce(successBody({ grants: [] }));
    connMock.activeTransport.mockReturnValue(t);
    await usePermissionStore.getState().load();
    const s = usePermissionStore.getState();
    expect(s.error).toBe("Invalid permission response");
    expect(s.initialized).toBe(false);
  });

  it("grants 行缺 title/sessionId 非法时整体置 error", async () => {
    const t = makeTransport();
    t.request
      .mockResolvedValueOnce(successBody([]))
      .mockResolvedValueOnce(successBody({ grants: [{ sessionId: "x" }] }));
    connMock.activeTransport.mockReturnValue(t);
    await usePermissionStore.getState().load();
    expect(usePermissionStore.getState().error).toBe(
      "Invalid permission response",
    );
    expect(usePermissionStore.getState().initialized).toBe(false);
  });

  it("revokeRemembered 端点映射+载荷，成功本地移除行", async () => {
    const t = makeTransport();
    t.request
      .mockResolvedValueOnce(successBody([rememberedDto({ id: 1 })]))
      .mockResolvedValueOnce(successBody({ grants: [] }))
      .mockResolvedValueOnce(successBody(null));
    connMock.activeTransport.mockReturnValue(t);
    await usePermissionStore.getState().load();
    const ok = await usePermissionStore.getState().revokeRemembered(1);
    expect(ok).toBe(true);
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.permission.revokeRemembered,
      { id: 1 },
    );
    // 本地移除行，不整页重拉（全程仅 3 次请求：load 双读 + 本写）
    expect(usePermissionStore.getState().remembered).toHaveLength(0);
    expect(t.request).toHaveBeenCalledTimes(3);
  });

  it("revokeAllRemembered 透传撤销条数并清空本地列表", async () => {
    const t = makeTransport();
    t.request
      .mockResolvedValueOnce(
        successBody([rememberedDto({ id: 1 }), rememberedDto({ id: 2 })]),
      )
      .mockResolvedValueOnce(successBody({ grants: [] }))
      .mockResolvedValueOnce(successBody({ revoked: 2 }));
    connMock.activeTransport.mockReturnValue(t);
    await usePermissionStore.getState().load();
    const revoked = await usePermissionStore.getState().revokeAllRemembered();
    expect(revoked).toBe(2);
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.permission.revokeAllRemembered,
      null,
    );
    expect(usePermissionStore.getState().remembered).toHaveLength(0);
  });

  it("revokeAllFull 透传撤销条数并清空本地 grants", async () => {
    const t = makeTransport();
    t.request
      .mockResolvedValueOnce(successBody([]))
      .mockResolvedValueOnce(successBody({ grants: [fullGrantDto()] }))
      .mockResolvedValueOnce(successBody({ revoked: 1 }));
    connMock.activeTransport.mockReturnValue(t);
    await usePermissionStore.getState().load();
    const revoked = await usePermissionStore.getState().revokeAllFull();
    expect(revoked).toBe(1);
    expect(t.request).toHaveBeenCalledWith(
      "POST",
      ENDPOINTS.permission.revokeAllFull,
      null,
    );
    expect(usePermissionStore.getState().fullGrants).toHaveLength(0);
  });

  it("revokeAll 响应缺 revoked 字段置 error 返 null", async () => {
    const t = makeTransport();
    t.request
      .mockResolvedValueOnce(successBody([]))
      .mockResolvedValueOnce(successBody({ grants: [fullGrantDto()] }))
      .mockResolvedValueOnce(successBody(null));
    connMock.activeTransport.mockReturnValue(t);
    await usePermissionStore.getState().load();
    await expect(
      usePermissionStore.getState().revokeAllFull(),
    ).resolves.toBeNull();
    expect(usePermissionStore.getState().error).toBe(
      "Invalid permission response",
    );
    // 解析失败不清空本地态
    expect(usePermissionStore.getState().fullGrants).toHaveLength(1);
  });

  it("写操作串行且旧写完成不提前清除 saving", async () => {
    const t = makeTransport();
    connMock.activeTransport.mockReturnValue(t);
    const firstResponse = deferred<unknown>();
    const secondResponse = deferred<unknown>();
    t.request
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);
    const first = usePermissionStore.getState().revokeRemembered(1);
    const second = usePermissionStore.getState().revokeRemembered(2);
    await Promise.resolve();
    expect(t.request).toHaveBeenCalledTimes(1);
    expect(usePermissionStore.getState().saving).toBe(true);
    firstResponse.resolve(successBody(null));
    await first;
    await Promise.resolve();
    expect(t.request).toHaveBeenCalledTimes(2);
    expect(usePermissionStore.getState().saving).toBe(true);
    secondResponse.resolve(successBody(null));
    await second;
    expect(usePermissionStore.getState().saving).toBe(false);
  });

  it("wire 业务错 → 写面返回失败且 error 置位", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue({
      status: 200,
      body: { code: "5000", success: false, data: null, message: "撤销失败" },
    });
    connMock.activeTransport.mockReturnValue(t);
    const ok = await usePermissionStore.getState().revokeRemembered(1);
    expect(ok).toBe(false);
    expect(usePermissionStore.getState().error).toBe("撤销失败");
    await expect(
      usePermissionStore.getState().revokeAllRemembered(),
    ).resolves.toBeNull();
  });

  it("切连接后丢弃旧主机迟到的 load 响应", async () => {
    const transportA = makeTransport();
    const transportB = makeTransport();
    // load 双读面同 transport 并行两次调用：各读面独立 deferred
    const respA1 = deferred<unknown>();
    const respA2 = deferred<unknown>();
    const respB1 = deferred<unknown>();
    const respB2 = deferred<unknown>();
    transportA.request
      .mockReturnValueOnce(respA1.promise)
      .mockReturnValueOnce(respA2.promise);
    transportB.request
      .mockReturnValueOnce(respB1.promise)
      .mockReturnValueOnce(respB2.promise);
    connMock.transport = transportA;
    const loadA = usePermissionStore.getState().load();
    connMock.activeConnId = "c2";
    connMock.transport = transportB;
    const loadB = usePermissionStore.getState().load();
    respB1.resolve(successBody([rememberedDto({ workspaceName: "B空间" })]));
    respB2.resolve(successBody({ grants: [] }));
    await loadB;
    respA1.resolve(successBody([rememberedDto({ workspaceName: "A空间" })]));
    respA2.resolve(successBody({ grants: [] }));
    await loadA;
    expect(usePermissionStore.getState().remembered[0]?.workspaceName).toBe(
      "B空间",
    );
  });

  it("无 chat 能力/无连接时不发请求", async () => {
    const t = makeTransport();
    t.request.mockResolvedValue(successBody([]));
    connMock.activeTransport.mockReturnValue(t);
    connMock.capabilities = ["provider"];
    await usePermissionStore.getState().load();
    const ok = await usePermissionStore.getState().revokeRemembered(1);
    expect(t.request).not.toHaveBeenCalled();
    expect(ok).toBe(false);
    expect(usePermissionStore.getState().initialized).toBe(false);
    connMock.capabilities = ["chat"];
    connMock.activeConnId = null;
    await usePermissionStore.getState().load();
    expect(t.request).not.toHaveBeenCalled();
  });
});
