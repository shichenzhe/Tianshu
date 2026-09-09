/**
 * memory-inflight 共享在途互斥单测（spec §5.2「定时与手动不并发」）：
 * 占用互斥 / 持有者释放 / abort 清槽。模块级单槽状态——各用例收口
 * 清空（release / abort）保证互不污染。
 */
import { describe, expect, it } from "vitest";

import {
  abortInflight,
  acquire,
  isInflight,
  release,
} from "../../electron/domains/ai/personalization/memory-inflight";

describe("memory-inflight（共享在途互斥）", () => {
  it("acquire 后再 acquire 失败（返回 null），isInflight 为真", () => {
    const owner = acquire() as AbortController;
    expect(owner).toBeInstanceOf(AbortController);
    expect(acquire()).toBeNull();
    expect(isInflight()).toBe(true);
    release(owner);
  });

  it("release 后可重新 acquire，isInflight 复位", () => {
    const owner = acquire() as AbortController;
    release(owner);
    expect(isInflight()).toBe(false);
    expect(acquire()).toBeInstanceOf(AbortController);
    // 收口：清空留给后续用例
    abortInflight();
  });

  it("非持有者 release 不生效（防 quit 清槽后旧执行误清新占用）", () => {
    const owner = acquire() as AbortController;
    release(new AbortController());
    expect(isInflight()).toBe(true);
    expect(acquire()).toBeNull();
    release(owner);
    expect(isInflight()).toBe(false);
  });

  it("abortInflight 中止在途 signal 并清空槽位，可立即重新占用", () => {
    const owner = acquire() as AbortController;
    abortInflight();
    expect(owner.signal.aborted).toBe(true);
    expect(isInflight()).toBe(false);
    const next = acquire() as AbortController;
    expect(next).not.toBe(owner);
    release(next);
  });

  it("abortInflight 空闲时无副作用", () => {
    abortInflight();
    expect(isInflight()).toBe(false);
  });
});
