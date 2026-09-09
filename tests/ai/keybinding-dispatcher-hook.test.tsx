// @vitest-environment jsdom
/**
 * 分发 hook 集成测试（jsdom + renderHook）：window keydown → 命中即执行
 * 处理器并 preventDefault；消费者优先（已 preventDefault 的事件不分发）；
 * 输入框聚焦时裸键命令被挡；localStorage 覆盖变更无重渲染即时生效；
 * 未登记处理器的命令（发送键）命中不 preventDefault
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";

// localStorage stub：与 tests/lib/keybindings.test.ts 同款内存 stub
vi.hoisted(() => {
  const memory = new Map<string, string>();
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
});

import { useKeybindingDispatcher } from "../../src-react/domains/ai/layout/hooks/use-keybinding-dispatcher";

/** 桩 userAgent 为 mac（⌘=metaKey 口径；jsdom 原值两不沾） */
function stubDarwinUserAgent() {
  Object.defineProperty(window.navigator, "userAgent", {
    value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    configurable: true,
  });
}

/** 派发真实 keydown 并返回事件（可断言 defaultPrevented；可取消才能 prevent） */
function fireKeydown(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  localStorage.clear();
  stubDarwinUserAgent();
});

afterEach(() => {
  cleanup();
});

describe("useKeybindingDispatcher", () => {
  it("命中登记命令：执行处理器并 preventDefault", () => {
    const openSettings = vi.fn();
    renderHook(() =>
      useKeybindingDispatcher({ openSettings, toggleSidebar: vi.fn() }),
    );
    const event = fireKeydown({ key: ",", metaKey: true });
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("消费者优先：已被 preventDefault 的事件不再分发", () => {
    const stopGeneration = vi.fn();
    renderHook(() => useKeybindingDispatcher({ stopGeneration }));
    // 模拟组件先行消费：capture 阶段 preventDefault（window 捕获先于
    // 冒泡阶段的分发器监听）
    window.addEventListener("keydown", (event) => event.preventDefault(), {
      capture: true,
      once: true,
    });
    const event = fireKeydown({ key: "Escape" });
    expect(event.defaultPrevented).toBe(true);
    expect(stopGeneration).not.toHaveBeenCalled();
  });

  it("未登记处理器的命令命中不 preventDefault（发送键属输入框内部）", () => {
    const openSettings = vi.fn();
    renderHook(() => useKeybindingDispatcher({ openSettings }));
    const event = fireKeydown({ key: "Enter" });
    expect(event.defaultPrevented).toBe(false);
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("输入框聚焦：修饰键命令仍执行，裸键命令被挡", () => {
    const sendMessage = vi.fn();
    const toggleSidebar = vi.fn();
    renderHook(() => useKeybindingDispatcher({ sendMessage, toggleSidebar }));
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();

    fireKeydown({ key: "b", metaKey: true });
    expect(toggleSidebar).toHaveBeenCalledTimes(1);

    fireKeydown({ key: "Enter" });
    expect(sendMessage).not.toHaveBeenCalled();

    textarea.remove();
  });

  it("覆盖变更即时生效：localStorage 直改后新键命中、原键落空（无重渲染）", () => {
    const openSettings = vi.fn();
    renderHook(() => useKeybindingDispatcher({ openSettings }));

    fireKeydown({ key: ",", metaKey: true });
    expect(openSettings).toHaveBeenCalledTimes(1);

    localStorage.setItem(
      "tianshu-keybindings",
      JSON.stringify({ openSettings: "cmd+k" }),
    );
    fireKeydown({ key: ",", metaKey: true });
    fireKeydown({ key: "k", metaKey: true });
    expect(openSettings).toHaveBeenCalledTimes(2);
  });

  it("卸载即移除监听", () => {
    const openSettings = vi.fn();
    const { unmount } = renderHook(() =>
      useKeybindingDispatcher({ openSettings }),
    );
    unmount();
    fireKeydown({ key: ",", metaKey: true });
    expect(openSettings).not.toHaveBeenCalled();
  });
});
