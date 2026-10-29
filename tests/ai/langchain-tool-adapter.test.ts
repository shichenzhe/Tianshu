// tests/ai/langchain-tool-adapter.test.ts
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("../../electron/domains/ai/agent/tool-gate", () => ({
  runToolCall: vi.fn(
    async (_d, _a, _id, input: unknown) => `ok:${JSON.stringify(input)}`,
  ),
}));

import { runToolCall } from "../../electron/domains/ai/agent/tool-gate";
import { toLangChainTools } from "../../electron/domains/ai/orchestration/langchain-tool-adapter";
import type { ToolDefinition } from "../../electron/domains/ai/agent/file-tools";

const agent = {
  sessionId: 7,
  fullAccess: () => false,
  isToolAllowed: async () => false,
  requestApproval: async () => false,
} as never;

const zodTool: ToolDefinition = {
  name: "read",
  description: "d",
  kind: "read",
  parameters: z.object({ path: z.string() }),
  execute: async () => "",
};
const mcpTool: ToolDefinition = {
  name: "mcp__x__y",
  description: "mcp d",
  kind: "read",
  parameters: { type: "object", properties: { q: { type: "string" } } },
  execute: async () => "",
};

describe("toLangChainTools", () => {
  it("zod 工具走 runToolCall 且参数透传", async () => {
    const [t] = toLangChainTools([zodTool], agent, {});
    const out = await t.invoke({ path: "a.txt" });
    expect(out).toBe('ok:{"path":"a.txt"}');
    expect(runToolCall).toHaveBeenCalled();
  });
  it("MCP（JSON Schema）工具 func 收 JSON 字符串并解析透传", async () => {
    const [, t] = toLangChainTools([zodTool, mcpTool], agent, {});
    const out = await t.invoke(JSON.stringify({ q: "hi" }));
    expect(out).toBe('ok:{"q":"hi"}');
  });
  it("MCP 工具非法 JSON 回喂错误文案不抛出", async () => {
    const [, t] = toLangChainTools([zodTool, mcpTool], agent, {});
    const out = await t.invoke("not-json");
    expect(String(out)).toContain("错误");
  });
  it("onToolCall 回调 ok 判定（错误: 前缀 = 失败）", async () => {
    vi.mocked(runToolCall).mockResolvedValueOnce("错误: x");
    const calls: Array<{ name: string; ok: boolean }> = [];
    const [t] = toLangChainTools([zodTool], agent, {
      onToolCall: (c) => calls.push(c),
    });
    await t.invoke({ path: "b" });
    expect(calls).toEqual([{ name: "read", ok: false }]);
  });
  it("同毫秒并发同名调用 toolCallId 唯一（防审批键/轨迹串线）", async () => {
    const frozen = vi.spyOn(Date, "now").mockReturnValue(1791029000000);
    try {
      const [t] = toLangChainTools([zodTool], agent, {});
      await Promise.all([t.invoke({ path: "a" }), t.invoke({ path: "b" })]);
      const ids = vi
        .mocked(runToolCall)
        .mock.calls.slice(-2)
        .map((c) => c[2]);
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
    } finally {
      frozen.mockRestore();
    }
  });
});
