import { describe, expect, it, vi } from "vitest";

import { subscribeToast, toast } from "./toast-bus";

describe("toast 总线（轻提示系统）", () => {
  it("toast.info/warning/error 按等级分发到订阅者；退订后不再收", () => {
    const received: Array<{ kind: string; message: string }> = [];
    const cb = vi.fn((p: { kind: string; message: string }) => received.push(p));
    const off = subscribeToast(cb);

    toast.info("已受理");
    toast.warning("读取失败");
    toast.error("发送失败");

    expect(cb).toHaveBeenCalledTimes(3);
    expect(received).toEqual([
      { kind: "info", message: "已受理" },
      { kind: "warning", message: "读取失败" },
      { kind: "error", message: "发送失败" },
    ]);

    off();
    toast.error("再发一条");
    expect(cb).toHaveBeenCalledTimes(3); // 退订后零触达
  });

  it("回调内退订不跳队（快照遍历）——其余订阅者仍收到", () => {
    const seen: string[] = [];
    let offA: () => void = () => {};
    const a = vi.fn(() => {
      offA();
    });
    const b = vi.fn((p: { message: string }) => seen.push(p.message));
    offA = subscribeToast(a);
    subscribeToast(b);

    toast.info("一次");
    expect(a).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["一次"]); // b 未被 a 的回调内退订波及
  });
});
