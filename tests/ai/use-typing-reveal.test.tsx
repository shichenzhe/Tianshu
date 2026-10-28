// @vitest-environment jsdom
/**
 * 吐字平滑 hook：rAF 驱动逐步显示（stub rAF 手动步进免真实帧等待）、
 * 吐完停帧（不再排帧）、enabled=false / prefers-reduced-motion 直通原文。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTypingReveal } from "../../src-react/domains/ai/chat/hooks/use-typing-reveal";

/** 手动 rAF 队列：flush 逐帧执行回调（now 递增 40ms 满足间隔节流） */
let rafQueue: Array<(now: number) => void>;
let rafNow: number;

beforeEach(() => {
  rafQueue = [];
  rafNow = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: (now: number) => void) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function stepFrames(count: number): void {
  for (let i = 0; i < count; i++) {
    const queue = rafQueue;
    rafQueue = [];
    rafNow += 40;
    for (const cb of queue) {
      cb(rafNow);
    }
  }
}

describe("useTypingReveal", () => {
  it("enabled：初始不全量显示，逐帧增长且不超目标，吐完停帧", () => {
    const target = "x".repeat(50);
    const { result } = renderHook(() => useTypingReveal(target, true));
    expect(result.current.length).toBeLessThan(target.length);
    let lastLen = result.current.length;
    for (
      let round = 0;
      round < 80 && result.current.length < target.length;
      round++
    ) {
      act(() => stepFrames(1));
      expect(result.current.length).toBeGreaterThanOrEqual(lastLen);
      expect(result.current.length).toBeLessThanOrEqual(target.length);
      lastLen = result.current.length;
    }
    expect(result.current).toBe(target);
    // 吐完停帧：排空队列后不再有新帧请求
    act(() => stepFrames(3));
    expect(rafQueue).toHaveLength(0);
  });

  it("enabled=false：直通原文且不排帧", () => {
    const { result } = renderHook(() => useTypingReveal("hello world", false));
    expect(result.current).toBe("hello world");
    expect(rafQueue).toHaveLength(0);
  });

  it("目标增长（流式追加）后继续吐字", () => {
    const { result, rerender } = renderHook(
      ({ text }) => useTypingReveal(text, true),
      { initialProps: { text: "x".repeat(30) } },
    );
    act(() => stepFrames(20));
    const grown = "x".repeat(80);
    rerender({ text: grown });
    expect(result.current.length).toBeLessThanOrEqual(grown.length);
    act(() => stepFrames(80));
    expect(result.current).toBe(grown);
  });

  it("prefers-reduced-motion：直通原文不排帧", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const { result } = renderHook(() => useTypingReveal("abc", true));
    expect(result.current).toBe("abc");
    expect(rafQueue).toHaveLength(0);
  });
});
