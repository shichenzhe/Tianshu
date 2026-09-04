import { afterEach, describe, expect, it } from "vitest";
import {
  McpManager,
  parseMcpRow,
  type McpClientLike,
  type McpServerConfig,
} from "../../electron/domains/ai/agent/mcp-manager";
import {
  registry,
  unregisterTools,
} from "../../electron/domains/ai/agent/tool-registry";
import type { ToolDefinition } from "../../electron/domains/ai/agent/file-tools";

const server: McpServerConfig = {
  id: 1,
  name: "srv",
  transport: "stdio",
  command: "npx",
  args: ["-y", "fake-mcp"],
};

const ctx = () => ({ workspacePath: "/tmp/ws", sessionId: 1 });

afterEach(() => unregisterTools("mcp__"));

/** 按顺序出队 fake client 的工厂（额外创建即抛错） */
function fakeClient(tools: object[] = [], opts?: { throwOnCall?: boolean }) {
  let closeCount = 0;
  const client: McpClientLike = {
    listTools: async () =>
      ({ tools }) as ReturnType<McpClientLike["listTools"]>,
    callTool: async () => {
      if (opts?.throwOnCall) throw new Error("connection closed");
      return { content: [{ type: "text", text: "ok" }] };
    },
    close: async () => {
      closeCount++;
    },
  };
  return { client, closeCount: () => closeCount };
}

/** listTools 挂起直至 gate resolve 的 fake client（connect 竞态守卫用） */
function gatedClient(tools: object[], gate: Promise<void>) {
  let closeCount = 0;
  const client: McpClientLike = {
    listTools: () =>
      gate.then(() => ({ tools }) as ReturnType<McpClientLike["listTools"]>),
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    close: async () => {
      closeCount++;
    },
  };
  return { client, closeCount: () => closeCount };
}

function makeManager(
  clients: McpClientLike[],
  rows: McpServerConfig[] = [],
  failFirst = false,
) {
  let call = 0;
  const manager = new McpManager({
    createClient: async () => {
      call++;
      if (failFirst && call === 1) throw new Error("spawn failed");
      const next = clients.shift();
      if (!next) throw new Error("no more fake clients");
      return next;
    },
    prisma: { mcpServer: { findMany: async () => rows } },
  });
  return { manager, createCalls: () => call };
}

const mcpDefs = (): ToolDefinition[] =>
  registry.getDefinitions().filter((d) => d.name.startsWith("mcp__"));

describe("McpManager.connect", () => {
  it("连接成功注册 mcp__ 前缀工具并更新状态", async () => {
    const { client } = fakeClient([
      {
        name: "tool_a",
        description: "A 工具",
        inputSchema: { type: "object" },
      },
      { name: "tool_b" },
    ]);
    const { manager } = makeManager([client]);

    await manager.connect(server);

    const names = mcpDefs().map((d) => d.name);
    expect(names).toEqual(["mcp__srv__tool_a", "mcp__srv__tool_b"]);
    expect(manager.getStatuses()).toEqual([
      {
        id: 1,
        name: "srv",
        state: "connected",
        toolCount: 2,
        error: undefined,
      },
    ]);
  });

  it("readOnlyHint true→read、false→write、缺失→write", async () => {
    const { client } = fakeClient([
      { name: "ro", annotations: { readOnlyHint: true } },
      { name: "rw", annotations: { readOnlyHint: false } },
      { name: "plain" },
    ]);
    const { manager } = makeManager([client]);

    await manager.connect(server);

    expect(mcpDefs().map((d) => ({ name: d.name, kind: d.kind }))).toEqual([
      { name: "mcp__srv__ro", kind: "read" },
      { name: "mcp__srv__rw", kind: "write" },
      { name: "mcp__srv__plain", kind: "write" },
    ]);
  });

  it("inputSchema 透传 parameters，缺失时回退 zod 空对象", async () => {
    const schema = {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    };
    const { client } = fakeClient([
      { name: "with_schema", inputSchema: schema },
      { name: "no_schema" },
    ]);
    const { manager } = makeManager([client]);

    await manager.connect(server);

    expect(registry.find("mcp__srv__with_schema")!.parameters).toEqual(schema);
    expect(registry.find("mcp__srv__no_schema")!.parameters).toBeDefined();
  });

  it("description 缺失回退“MCP 工具 <name>”", async () => {
    const { client } = fakeClient([{ name: "t", description: "自带描述" }]);
    const { manager } = makeManager([client]);

    await manager.connect(server);

    expect(registry.find("mcp__srv__t")!.description).toBe("自带描述");
  });
});

describe("McpManager.startupConnectAll", () => {
  it("createClient 抛错记 error 状态且不抛出、toolCount 0", async () => {
    const { client } = fakeClient([{ name: "ok_tool" }]);
    const second: McpServerConfig = { ...server, id: 2, name: "srv2" };
    const { manager, createCalls } = makeManager(
      [client],
      [server, second],
      true,
    );

    await expect(manager.startupConnectAll()).resolves.toBeUndefined();

    const statuses = manager.getStatuses();
    expect(statuses).toEqual([
      {
        id: 1,
        name: "srv",
        state: "error",
        toolCount: 0,
        error: "spawn failed",
      },
      {
        id: 2,
        name: "srv2",
        state: "connected",
        toolCount: 1,
        error: undefined,
      },
    ]);
    expect(createCalls()).toBe(2);
  });
});

describe("McpManager.setEnabled", () => {
  it("false → 注销工具、关闭连接、状态 disabled", async () => {
    const { client, closeCount } = fakeClient([{ name: "t" }]);
    const { manager } = makeManager([client]);
    await manager.connect(server);

    await manager.setEnabled(server, false);

    expect(mcpDefs()).toEqual([]);
    expect(closeCount()).toBe(1);
    expect(manager.getStatuses()).toEqual([
      { id: 1, name: "srv", state: "disabled", toolCount: 0, error: undefined },
    ]);
  });

  it("false 且 close 抛错被忽略，仍置 disabled", async () => {
    let closed = 0;
    const { client } = fakeClient([{ name: "t" }]);
    (client as McpClientLike).close = async () => {
      closed++;
      throw new Error("close failed");
    };
    const { manager } = makeManager([client]);
    await manager.connect(server);

    await expect(manager.setEnabled(server, false)).resolves.toBeUndefined();

    expect(closed).toBe(1);
    expect(manager.getStatuses()[0].state).toBe("disabled");
  });

  it("true → 重新连接并注册", async () => {
    const { client: client2 } = fakeClient([{ name: "t2" }]);
    const manager2 = new McpManager({
      createClient: async () => client2,
      prisma: { mcpServer: { findMany: async () => [server] } },
    });
    await manager2.connect(server);
    await manager2.setEnabled(server, false);
    await manager2.setEnabled(server, true);

    expect(mcpDefs().map((d) => d.name)).toEqual(["mcp__srv__t2"]);
    expect(manager2.getStatuses()[0].state).toBe("connected");
  });
});

describe("MCP 工具 execute", () => {
  it("content 中 text 段以换行 join", async () => {
    const { client } = fakeClient([{ name: "t" }]);
    client.callTool = async () => ({
      content: [
        { type: "text", text: "第一行" },
        { type: "image", data: "..." },
        { type: "text", text: "第二行" },
      ],
    });
    const { manager } = makeManager([client]);
    await manager.connect(server);

    const result = await registry.find("mcp__srv__t")!.execute(ctx(), {
      q: "x",
    });
    expect(result).toBe("第一行\n第二行");
  });

  it("空 content 返回（无输出）", async () => {
    const { client } = fakeClient([{ name: "t" }]);
    client.callTool = async () => ({ content: [] });
    const { manager } = makeManager([client]);
    await manager.connect(server);

    expect(await registry.find("mcp__srv__t")!.execute(ctx(), {})).toBe(
      "(无输出)",
    );
  });

  it("callTool 抛错（断连）返回错误串而非抛出", async () => {
    const { client } = fakeClient([{ name: "t" }], { throwOnCall: true });
    const { manager } = makeManager([client]);
    await manager.connect(server);

    expect(await registry.find("mcp__srv__t")!.execute(ctx(), {})).toBe(
      "错误: MCP 服务不可用（srv）",
    );
  });
});

describe("McpManager.reconnect", () => {
  it("清旧工具后按新工具集重新注册", async () => {
    const first = fakeClient([{ name: "old_tool" }]);
    const second = fakeClient([{ name: "new_a" }, { name: "new_b" }]);
    const { manager, createCalls } = makeManager([first.client, second.client]);
    await manager.connect(server);

    await manager.reconnect(server);

    expect(mcpDefs().map((d) => d.name)).toEqual([
      "mcp__srv__new_a",
      "mcp__srv__new_b",
    ]);
    expect(createCalls()).toBe(2);
    expect(manager.getStatuses()[0].toolCount).toBe(2);
  });
});

describe("McpManager 连接竞态守卫与旧连接释放", () => {
  it("connect 挂起中停用 → 恢复后结果作废：不注册、状态保持 disabled、新 client 被 close", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const late = gatedClient([{ name: "late_tool" }], gate);
    const { manager } = makeManager([late.client]);

    const connecting = manager.connect(server);
    // listTools 挂起中停用：代际前移 + 置 disabled
    await manager.setEnabled(server, false);
    release();
    await connecting;

    expect(mcpDefs()).toEqual([]);
    expect(manager.getStatuses()[0]).toEqual({
      id: 1,
      name: "srv",
      state: "disabled",
      toolCount: 0,
      error: undefined,
    });
    expect(late.closeCount()).toBe(1);
  });

  it("connect 挂起中重连 → 旧代际结果作废（其 client 被 close），新代际正常注册", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stale = gatedClient([{ name: "stale_tool" }], gate);
    const fresh = fakeClient([{ name: "fresh_tool" }]);
    const { manager } = makeManager([stale.client, fresh.client]);

    const first = manager.connect(server);
    // 第二次 connect 立即代际前移并完成注册（其 listTools 不挂起）
    await manager.reconnect(server);
    release();
    await first;

    expect(mcpDefs().map((d) => d.name)).toEqual(["mcp__srv__fresh_tool"]);
    expect(stale.closeCount()).toBe(1);
    expect(fresh.closeCount()).toBe(0);
    expect(manager.getStatuses()[0]).toMatchObject({
      state: "connected",
      toolCount: 1,
    });
  });

  it("reconnect 成功路径：旧 client 尽力关闭且旧工具清空、新工具注册", async () => {
    const first = fakeClient([{ name: "old_tool" }]);
    const second = fakeClient([{ name: "new_tool" }]);
    const { manager } = makeManager([first.client, second.client]);
    await manager.connect(server);
    expect(first.closeCount()).toBe(0);

    await manager.reconnect(server);

    expect(first.closeCount()).toBe(1);
    expect(second.closeCount()).toBe(0);
    expect(mcpDefs().map((d) => d.name)).toEqual(["mcp__srv__new_tool"]);
    expect(manager.getStatuses()[0].toolCount).toBe(1);
  });

  it("挂起中停用后 createClient 才失败 → 不以 error 覆盖 disabled 状态", async () => {
    let rejectClient!: (e: Error) => void;
    // 首个 createClient 永不成功：停用后才拒绝，命中「过期 connect 的 catch」路径
    const failLater = new Promise<never>((_, reject) => {
      rejectClient = reject;
    });
    let calls = 0;
    const manager = new McpManager({
      createClient: async () => {
        calls++;
        if (calls === 1) return failLater;
        return {
          listTools: async () => ({ tools: [{ name: "t2" }] }),
          callTool: async () => ({ content: [] }),
          close: async () => {},
        };
      },
      prisma: { mcpServer: { findMany: async () => [] } },
    });

    const first = manager.connect(server);
    await manager.setEnabled(server, false);
    rejectClient(new Error("spawn failed"));
    await first;

    // 过期 connect 的失败不覆盖 disabled 状态
    expect(manager.getStatuses()[0].state).toBe("disabled");
    expect(mcpDefs()).toEqual([]);

    // 状态未被污染：后续重连照常成功
    await manager.reconnect(server);
    expect(manager.getStatuses()[0]).toMatchObject({
      state: "connected",
      toolCount: 1,
    });
    expect(mcpDefs().map((d) => d.name)).toEqual(["mcp__srv__t2"]);
  });
});

describe("parseMcpRow", () => {
  it("解析 JSON 字符串列为对象/数组", () => {
    const config = parseMcpRow({
      id: 3,
      name: "fs",
      transport: "http",
      command: null,
      args: '["-y","mcp"]',
      env: '{"KEY":"v"}',
      url: "http://localhost:3000/mcp",
      headers: '{"Authorization":"Bearer x"}',
      enabled: true,
    });
    expect(config).toEqual({
      id: 3,
      name: "fs",
      transport: "http",
      url: "http://localhost:3000/mcp",
      args: ["-y", "mcp"],
      env: { KEY: "v" },
      headers: { Authorization: "Bearer x" },
    });
  });

  it("非法 JSON 容错为 undefined", () => {
    const config = parseMcpRow({
      id: 4,
      name: "bad",
      transport: "stdio",
      command: "uvx",
      args: "{broken",
      env: "nope",
      url: null,
      headers: null,
      enabled: true,
    });
    expect(config.args).toBeUndefined();
    expect(config.env).toBeUndefined();
    expect(config.headers).toBeUndefined();
    expect(config.command).toBe("uvx");
  });
});
