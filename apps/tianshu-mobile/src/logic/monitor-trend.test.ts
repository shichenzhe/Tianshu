import { describe, expect, it } from "vitest";

import { trendBarHeights } from "./monitor-trend";

describe("trendBarHeights", () => {
  it("按窗口内最大 input/output token 值归一双柱高度", () => {
    expect(
      trendBarHeights(
        [
          { inputTokens: 100, outputTokens: 50 },
          { inputTokens: 25, outputTokens: 75 },
        ],
        80,
      ),
    ).toEqual([
      { input: 80, output: 40 },
      { input: 20, output: 60 },
    ]);
  });

  it("非零窗口中的零值与小值也以 2px 保底", () => {
    expect(
      trendBarHeights(
        [
          { inputTokens: 100, outputTokens: 0 },
          { inputTokens: 0, outputTokens: 1 },
        ],
        100,
      ),
    ).toEqual([
      { input: 100, output: 2 },
      { input: 2, output: 2 },
    ]);
  });

  it("全零窗口返回全 2px，空窗口返回空数组", () => {
    expect(
      trendBarHeights(
        [
          { inputTokens: 0, outputTokens: 0 },
          { inputTokens: 0, outputTokens: 0 },
        ],
        80,
      ),
    ).toEqual([
      { input: 2, output: 2 },
      { input: 2, output: 2 },
    ]);
    expect(trendBarHeights([], 80)).toEqual([]);
  });
});
