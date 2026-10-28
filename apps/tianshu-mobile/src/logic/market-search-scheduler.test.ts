import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarketSearchScheduler } from "./market-search-scheduler";

describe("MarketSearchScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("输入防抖：连续输入只发一次最新关键词", () => {
    const onSearch = vi.fn();
    const scheduler = new MarketSearchScheduler(onSearch, 300);
    scheduler.input("g");
    scheduler.input("gr");
    scheduler.input("gram");
    vi.advanceTimersByTime(300);
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith("gram", null);
  });

  it("切分类后立即发搜，读最新关键词", () => {
    const onSearch = vi.fn();
    const scheduler = new MarketSearchScheduler(onSearch, 300);
    scheduler.input("gram");
    vi.advanceTimersByTime(300);
    scheduler.select("writing");
    expect(onSearch).toHaveBeenLastCalledWith("gram", "writing");
    expect(onSearch).toHaveBeenCalledTimes(2);
  });

  it("输入防抖未决时切分类：立即用最新组合发搜，旧定时器不再补发", () => {
    const onSearch = vi.fn();
    const scheduler = new MarketSearchScheduler(onSearch, 300);
    scheduler.input("gram");
    // 防抖未决即切分类——旧实现下定时器到点会用创建时的旧分类补发
    scheduler.select("coding");
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith("", "coding");
    vi.advanceTimersByTime(1000);
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it("先切分类再输入：定时器到点读最新分类（非创建时快照）", () => {
    const onSearch = vi.fn();
    const scheduler = new MarketSearchScheduler(onSearch, 300);
    scheduler.select("writing");
    scheduler.input("gram");
    vi.advanceTimersByTime(300);
    expect(onSearch).toHaveBeenLastCalledWith("gram", "writing");
  });

  it("dispose 取消未决定时器", () => {
    const onSearch = vi.fn();
    const scheduler = new MarketSearchScheduler(onSearch, 300);
    scheduler.input("gram");
    scheduler.dispose();
    vi.advanceTimersByTime(1000);
    expect(onSearch).not.toHaveBeenCalled();
  });
});
