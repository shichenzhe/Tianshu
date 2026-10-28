import { describe, expect, it } from "vitest";

import { TIME_GAP_MS, timeSeparatorKeys } from "./time-separators";

const iso = (min: number) => new Date(min * 60_000).toISOString();

describe("time-separators（微信范式时间分隔批）", () => {
  it("首条必标，间隔未超 5 分钟不标", () => {
    const marks = timeSeparatorKeys([
      { key: "a", createdAt: iso(0) },
      { key: "b", createdAt: iso(3) },
    ]);
    expect(marks.has("a")).toBe(true);
    expect(marks.has("b")).toBe(false);
  });

  it("间隔超 5 分钟标记", () => {
    const marks = timeSeparatorKeys([
      { key: "a", createdAt: iso(0) },
      { key: "b", createdAt: iso(6) },
    ]);
    expect(marks.has("b")).toBe(true);
  });

  it("非法 createdAt 跳过并重置锚点", () => {
    const marks = timeSeparatorKeys([
      { key: "a", createdAt: iso(0) },
      { key: "live", createdAt: undefined },
      { key: "b", createdAt: iso(1) },
    ]);
    expect(marks.has("b")).toBe(true); // live 重置锚点，b 成为新首条
    expect(TIME_GAP_MS).toBe(5 * 60 * 1000);
  });
});
