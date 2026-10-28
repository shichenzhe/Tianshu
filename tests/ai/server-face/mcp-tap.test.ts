// A4 MCP 批（spec 2026-10-26 §3）：mcp-tap 用例——save 掩码三态 fail-closed
// （类比 providers-tap 测试）/url 非 http(s) 拒/stdio save 拒/detail 不回
// args·env（stdio 仅摘要）/statuses 形状。内存仓储替身直测，错误码经
// code 属性钉。
import { describe, expect, it } from "vitest";
import { REDACTED_SECRET } from "@tianshu/protocol";

import { createMcpsFace } from "../../../electron/domains/server-face/mcp-tap";
import type { McpRepoSubset } from "../../../electron/domains/server-face/mcp-tap";
import type {
  McpServerRecord,
  McpServerStatus,
} from "../../../src-react/domains/ai/api/mcp.api";

const UID = 7;
const NOW = "2026-10-26T00:00:00.000Z";

function record(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    id: 1,
    name: "hub-a",
    transport: "http",
    url: "https://mcp.example.com/sse",
    headers: '{"X-Key":"secret-a"}',
    env: '{"TOKEN":"secret-env"}',
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** 内存仓储替身（McpRepository 结构子集；行与 record 字符串透传同口径） */
class McpRepoDouble {
  rows: McpServerRecord[];
  lastUpdate: unknown = null;
  lastCreate: unknown = null;
  reconnectCalls: number[] = [];
  deleteCalls: number[] = [];

  constructor(rows: McpServerRecord[] = [record()]) {
    this.rows = rows;
  }

  async list(userId: number): Promise<McpServerRecord[]> {
    void userId;
    return this.rows;
  }

  async setEnabled(): Promise<void> {}

  async statuses(): Promise<McpServerStatus[]> {
    return [
      { id: 1, name: "hub-a", state: "connected", toolCount: 3 },
      { id: 2, name: "hub-b", state: "error", toolCount: 0, error: "boom" },
    ];
  }

  async create(p: Record<string, unknown>): Promise<McpServerRecord> {
    this.lastCreate = p;
    return { ...record(), ...p } as McpServerRecord;
  }

  async update(p: { id: number }): Promise<McpServerRecord> {
    this.lastUpdate = p;
    const row = this.rows.find((r) => r.id === p.id);
    if (!row) throw new Error("MCP_SERVER_MISSING");
    return { ...row, ...p } as McpServerRecord;
  }

  async delete(id: number): Promise<void> {
    if (!this.rows.some((r) => r.id === id))
      throw new Error("MCP_SERVER_MISSING");
    this.deleteCalls.push(id);
  }

  async reconnect(id: number): Promise<void> {
    if (!this.rows.some((r) => r.id === id))
      throw new Error("MCP_SERVER_MISSING");
    this.reconnectCalls.push(id);
  }
}

function makeFace(rows?: McpServerRecord[]) {
  const repo = new McpRepoDouble(rows);
  const face = createMcpsFace(repo as unknown as McpRepoSubset);
  return { face, repo };
}

describe("mcp-tap（A4 MCP 批）", () => {
  it("save 更新：headers 含掩码按未传（保留现值）", async () => {
    const { face, repo } = makeFace();
    const detail = await face.save(
      {
        id: 1,
        name: "hub-a2",
        url: "https://mcp.example.com/v2",
        headers: { "X-Key": REDACTED_SECRET },
      },
      UID,
    );
    expect(repo.lastUpdate).toMatchObject({
      id: 1,
      name: "hub-a2",
      url: "https://mcp.example.com/v2",
      headers: '{"X-Key":"secret-a"}',
      transport: "http",
      enabled: true,
    });
    // 响应 detail 恒掩码——不回泄真实头
    expect(detail.headers).toEqual({ "X-Key": REDACTED_SECRET });
    expect(JSON.stringify(detail)).not.toContain("secret-a");
  });

  it("save 更新三态：undefined 保留 / null 清除", async () => {
    const { face, repo } = makeFace();
    await face.save({ id: 1, name: "n", url: "https://x.test" }, UID);
    expect((repo.lastUpdate as { headers: unknown }).headers).toBe(
      '{"X-Key":"secret-a"}',
    );
    await face.save(
      { id: 1, name: "n", url: "https://x.test", headers: null },
      UID,
    );
    expect((repo.lastUpdate as { headers: unknown }).headers).toBeNull();
  });

  it("save 新建：无 id 走 create，transport 恒 http；响应恒掩码", async () => {
    const { face, repo } = makeFace([]);
    const detail = await face.save(
      { name: "new-hub", url: "https://new.test/sse", enabled: false },
      UID,
    );
    expect(repo.lastCreate).toMatchObject({
      name: "new-hub",
      transport: "http",
      url: "https://new.test/sse",
      enabled: false,
    });
    expect(detail).toMatchObject({
      name: "new-hub",
      transport: "http",
      args: [],
      env: {},
    });
  });

  it("save url 非 http(s) 拒 MCP_INVALID", async () => {
    const { face, repo } = makeFace();
    try {
      await face.save({ id: 1, name: "n", url: "ftp://x" }, UID);
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe("MCP_INVALID");
    }
    expect(repo.lastUpdate).toBeNull();
  });

  it("save stdio 类型拒 MCP_STDIO_FORBIDDEN（宿主机进程执行面）", async () => {
    const { face, repo } = makeFace([
      record({
        id: 5,
        transport: "stdio",
        command: "npx",
        args: '["-y","pkg"]',
        url: undefined,
        headers: undefined,
        env: undefined,
      }),
    ]);
    try {
      await face.save({ id: 5, name: "s", url: "https://x.test" }, UID);
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe("MCP_STDIO_FORBIDDEN");
    }
    expect(repo.lastUpdate).toBeNull();
  });

  it("save 更新不存在/越权报 MCP_NOT_FOUND", async () => {
    const { face } = makeFace();
    try {
      await face.save({ id: 99, name: "n", url: "https://x.test" }, UID);
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe("MCP_NOT_FOUND");
    }
  });

  it("detail：HTTP 类型 args 透传、env/headers 恒掩码", async () => {
    const { face } = makeFace([
      record({
        args: '["--verbose","--x"]',
        env: '{"API_KEY":"sk-live","EMPTY":""}',
        headers: '{"X-A":"v"}',
      }),
    ]);
    const detail = await face.detail(1, UID);
    expect(detail).toMatchObject({
      id: 1,
      transport: "http",
      args: ["--verbose", "--x"],
      env: { API_KEY: REDACTED_SECRET, EMPTY: "" },
      headers: { "X-A": REDACTED_SECRET },
    });
    expect(JSON.stringify(detail)).not.toContain("sk-live");
  });

  it("detail：stdio 类型仅摘要字段，args/env/headers 不回传", async () => {
    const { face } = makeFace([
      record({
        id: 5,
        transport: "stdio",
        command: "npx",
        args: '["-y","pkg"]',
        env: '{"API_KEY":"sk-live"}',
        url: undefined,
        headers: undefined,
      }),
    ]);
    const detail = await face.detail(5, UID);
    expect(detail).toEqual({
      id: 5,
      name: "hub-a",
      transport: "stdio",
      command: "npx",
      url: null,
      enabled: true,
      args: [],
      env: {},
      headers: {},
    });
    expect(JSON.stringify(detail)).not.toContain("sk-live");
  });

  it("detail 不存在报 MCP_NOT_FOUND（不泄露存在性）", async () => {
    const { face } = makeFace();
    try {
      await face.detail(42, UID);
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe("MCP_NOT_FOUND");
    }
  });

  it("statuses 形状映射（state/toolCount/error 可选段）", async () => {
    const { face } = makeFace();
    const statuses = await face.statuses(UID);
    expect(statuses).toEqual([
      { id: 1, name: "hub-a", state: "connected", toolCount: 3 },
      { id: 2, name: "hub-b", state: "error", toolCount: 0, error: "boom" },
    ]);
  });

  it("delete/reconnect 透传 repo 联动；不存在报 MCP_NOT_FOUND", async () => {
    const { face, repo } = makeFace();
    await face.remove(1, UID);
    await face.reconnect(1, UID);
    expect(repo.deleteCalls).toEqual([1]);
    expect(repo.reconnectCalls).toEqual([1]);
    try {
      await face.remove(99, UID);
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe("MCP_NOT_FOUND");
    }
  });

  it("list/setEnabled 阶段 0 语义保留（裁剪不透 env/headers）", async () => {
    const { face } = makeFace();
    const list = await face.list(UID);
    expect(list[0]).toEqual({
      id: 1,
      name: "hub-a",
      transport: "http",
      command: null,
      url: "https://mcp.example.com/sse",
      enabled: true,
    });
    expect(JSON.stringify(list)).not.toContain("secret");
    await face.setEnabled(1, false, UID);
  });
});
