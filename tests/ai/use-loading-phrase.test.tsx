// @vitest-environment jsdom
/**
 * useLoadingPhrase hook 测试（fake timers）：1.5s 内 null、超时出句、
 * 3s 轮换不重复、active 结束复位
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

vi.mock("react-i18next", () => {
  // t 须为稳定引用（与真实 react-i18next 一致）：若每次渲染返回新函数，
  // hook 的 effect 依赖 [active, t] 会随渲染反复重挂定时器，轮换节奏失真
  const t = (key: string, opts?: Record<string, unknown>) =>
    opts?.returnObjects ? ["甲", "乙", "丙"] : key;
  return {
    useTranslation: () => ({ t }),
  };
});

import {
  pickPhrase,
  useLoadingPhrase,
} from "../../src-react/domains/ai/chat/hooks/use-loading-phrase";

describe("pickPhrase", () => {
  it("排除上一句后随机取；池仅一句时允许重复", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(pickPhrase(["甲", "乙", "丙"], "甲")).toBe("乙");
    expect(pickPhrase(["仅此一句"], "仅此一句")).toBe("仅此一句");
    vi.restoreAllMocks();
  });
});

describe("useLoadingPhrase", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
  });

  it("inactive → 恒为 null", () => {
    const { result } = renderHook(() => useLoadingPhrase(false));
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toBeNull();
  });

  it("active 1.5s 内为 null，超时后出句（池序随机=0 → 甲）", () => {
    const { result } = renderHook(() => useLoadingPhrase(true));
    act(() => vi.advanceTimersByTime(1499));
    expect(result.current).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe("甲");
  });

  it("每 3s 轮换且不与上一句重复（甲 → 乙）", () => {
    const { result } = renderHook(() => useLoadingPhrase(true));
    act(() => vi.advanceTimersByTime(1500));
    expect(result.current).toBe("甲");
    act(() => vi.advanceTimersByTime(3000));
    expect(result.current).toBe("乙");
  });

  it("active 变 false → 复位 null", () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useLoadingPhrase(active),
      { initialProps: { active: true } },
    );
    act(() => vi.advanceTimersByTime(1500));
    expect(result.current).toBe("甲");
    rerender({ active: false });
    expect(result.current).toBeNull();
  });
});
