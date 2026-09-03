import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  truncateHistory,
} from "../../electron/domains/ai/chat/history-truncate";

const msg = (text: string) => ({
  blocks: JSON.stringify([{ type: "text", text }]),
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

  it("超窗从最老丢弃", () => {
    const list = [msg("x".repeat(1000)), msg("y"), msg("z")];
    const kept = truncateHistory(list, 100);
    expect(kept).toEqual([msg("y"), msg("z")]);
  });

  it("单条超窗也至少保留最近一条", () => {
    const list = [msg("x".repeat(1000))];
    expect(truncateHistory(list, 10)).toEqual(list);
  });
});
