import { describe, expect, it } from "vitest";
import {
  estimateMessageTokens,
  estimateTokens,
  truncateHistory,
} from "../../electron/domains/ai/chat/history-truncate";

const msg = (text: string) => ({
  blocks: JSON.stringify([{ type: "text", text }]),
});

const toolCallMsg = (output: string) => ({
  blocks: JSON.stringify([
    {
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "read_file",
      args: { path: "src/a.ts" },
      state: "done",
      output,
    },
  ]),
});

describe("历史截断", () => {
  it("estimateTokens 中文按长度一半向上取整", () => {
    expect(estimateTokens("abcd")).toBe(2);
    expect(estimateTokens("abc")).toBe(2);
  });

  it("无窗口不截断", () => {
    const list = [msg("a"), msg("b"), msg("c")];
    expect(truncateHistory(list, undefined)).toHaveLength(3);
  });

  it("未超预算全量保留（前缀稳定，只追加）", () => {
    const list = [msg("a"), msg("b"), msg("c")];
    expect(truncateHistory(list, 10)).toHaveLength(3);
  });

  it("超预算一次截到滞回带（80%），多丢头部消息换多轮前缀稳定", () => {
    // 10 条各 10 token，budget 90：total 100 超窗 → 目标 72 → 保留 7 条
    const list = Array.from({ length: 10 }, () => msg("t".repeat(20)));
    const kept = truncateHistory(list, 90);
    expect(kept).toHaveLength(7);
    expect(kept).toEqual(list.slice(3));
  });

  it("reserveTokens 先扣除输出与固定开销，预算从剩余窗口计算", () => {
    const list = [msg("a"), msg("b"), msg("c")];
    // budget = max(1, 10 - 8) = 2 → total 3 超窗 → 目标 1.6 → 仅保最近一条
    expect(truncateHistory(list, 10, { reserveTokens: 8 })).toEqual([msg("c")]);
  });

  it("超窗从最老丢弃", () => {
    const list = [msg("x".repeat(1000)), msg("y"), msg("z")];
    const kept = truncateHistory(list, 100);
    expect(kept).toEqual([msg("y"), msg("z")]);
  });

  it("单条超窗也至少保留最近一条", () => {
    const list = [msg("x".repeat(1000))];
    expect(truncateHistory(list, 10)).toEqual(list);
  });

  it("tool_call 块的 args 与输出计入 token 估算", () => {
    // 4000 字符输出 → ceil((argsLen + 4000) / 2) + 20 ≈ 2029
    expect(
      estimateMessageTokens(toolCallMsg("x".repeat(4000)).blocks),
    ).toBeGreaterThan(2000);
  });

  it("超窗时丢弃工具密集的最老消息，至少保留最近一条", () => {
    const list = [toolCallMsg("x".repeat(4000)), msg("y"), msg("z")];
    expect(truncateHistory(list, 100)).toEqual([msg("y"), msg("z")]);
    // 单条工具消息超窗仍保留（keep-at-least-one 语义不变）
    const single = [toolCallMsg("x".repeat(4000))];
    expect(truncateHistory(single, 10)).toEqual(single);
  });
});
