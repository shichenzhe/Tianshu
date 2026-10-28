// 参数摘要纯函数：仅显示非默认项（spec §3.1 摘要规则）
import { describe, expect, it } from "vitest";
import { buildModelSummary } from "../../src-react/domains/ai/provider/lib/model-summary";

const DEFAULTS = { contextWindow: 131072, maxTokens: 65536 };

describe("buildModelSummary", () => {
  it("全默认/全空 → 空数组", () => {
    expect(buildModelSummary({})).toEqual([]);
    expect(
      buildModelSummary({
        contextWindow: DEFAULTS.contextWindow,
        maxTokens: DEFAULTS.maxTokens,
      }),
    ).toEqual([]);
  });

  it("非默认上下文/输出 → K/M 缩写段", () => {
    expect(
      buildModelSummary({ contextWindow: 32768, maxTokens: 8192 }),
    ).toEqual([
      { key: "context", value: "32K" },
      { key: "output", value: "8K" },
    ]);
    expect(buildModelSummary({ contextWindow: 1048576 })).toEqual([
      { key: "context", value: "1M" },
    ]);
  });

  it("温度/topP 任意设置即显示（无默认值概念）", () => {
    expect(buildModelSummary({ temperature: 0.7 })).toEqual([
      { key: "temperature", value: "0.7" },
    ]);
    expect(buildModelSummary({ topP: 0.9, temperature: 1 })).toEqual([
      { key: "temperature", value: "1" },
      { key: "topP", value: "0.9" },
    ]);
  });
});
