// tests/ai/typing-reveal.test.ts
/**
 * 流式吐字平滑纯函数（WorkBuddy streaming-text/buffer-core 移植）：
 * - advanceReveal：追上不推进（EMA 向 0 衰减）/ 落后 ≤2 一次性吐完 /
 *   EMA 步进 clamp 1-6 字符每帧 / 步进永不超目标
 * - avoidSurrogateSplit：emoji 代理对不截半——切点在高位代理后：有低位
 *   顺延纳入整对，无低位回退 1
 */
import { describe, expect, it } from "vitest";
import {
  advanceReveal,
  avoidSurrogateSplit,
  TYPING_REVEAL_CONFIG,
  type TypingRevealState,
} from "../../src-react/domains/ai/chat/lib/typing-reveal";

const state = (displayLength: number, emaLag = 0): TypingRevealState => ({
  displayLength,
  emaLag,
});

describe("advanceReveal", () => {
  it("目标未增长（lag<=0）不推进，emaLag 向 0 衰减", () => {
    const next = advanceReveal(
      state(10, 5),
      10,
      "x".repeat(10),
      TYPING_REVEAL_CONFIG,
    );
    expect(next.displayLength).toBe(10);
    expect(next.emaLag).toBeCloseTo(5 * (1 - 0.1));
  });

  it("落后 ≤ fastDrainThreshold（2）一次性吐完", () => {
    for (const lag of [1, 2]) {
      const next = advanceReveal(
        state(10 - lag),
        10,
        "x".repeat(10),
        TYPING_REVEAL_CONFIG,
      );
      expect(next.displayLength).toBe(10);
      expect(next.emaLag).toBe(0);
    }
  });

  it("落后大：EMA 步进启动（首帧 accel→1 字符）；目标暴增（网络突发大块）clamp 到 6/帧", () => {
    // 初态 emaLag=0、lag=100：accel 后 emaLag=30，step=floor(30/24)=1
    let next = advanceReveal(
      state(0),
      100,
      "x".repeat(100),
      TYPING_REVEAL_CONFIG,
    );
    expect(next.displayLength).toBe(1);
    expect(next.emaLag).toBeCloseTo(100 * 0.3);
    // 网络突发：目标从 100 跳到 500（一次到达大块）——lag=400 超过
    // emaLag 大幅 → accel 推高 emaLag=30+(400-30)*0.3=141 → step=6 封顶
    const before = next.displayLength;
    next = advanceReveal(next, 500, "x".repeat(500), TYPING_REVEAL_CONFIG);
    expect(next.emaLag).toBeGreaterThan(24 * 6 - 1);
    expect(next.displayLength - before).toBe(6);
    // 持续大 lag 下每帧仍封顶 6
    const before2 = next.displayLength;
    next = advanceReveal(next, 500, "x".repeat(500), TYPING_REVEAL_CONFIG);
    expect(next.displayLength - before2).toBeLessThanOrEqual(6);
  });

  it("步进永不超目标长度", () => {
    let next = state(0);
    for (let i = 0; i < 40; i++) {
      next = advanceReveal(next, 37, "x".repeat(37), TYPING_REVEAL_CONFIG);
    }
    expect(next.displayLength).toBeLessThanOrEqual(37);
  });
});

describe("avoidSurrogateSplit", () => {
  // "😀" 为代理对（2 code unit）
  const text = "ab😀cd";
  const surrogateStart = 2; // 高位代理下标

  it("切点在高位代理后且低位已存在 → 顺延纳入整对", () => {
    expect(avoidSurrogateSplit(text, surrogateStart + 1)).toBe(
      surrogateStart + 2,
    );
  });

  it("切点在高位代理后且低位未产出（边界）→ 回退 1", () => {
    expect(
      avoidSurrogateSplit(
        text.slice(0, surrogateStart + 1),
        surrogateStart + 1,
      ),
    ).toBe(surrogateStart);
  });

  it("普通字符切点原样返回；0 与超长 clamp", () => {
    expect(avoidSurrogateSplit("abcd", 2)).toBe(2);
    expect(avoidSurrogateSplit("abcd", 0)).toBe(0);
    expect(avoidSurrogateSplit("abcd", 99)).toBe(4);
  });
});
