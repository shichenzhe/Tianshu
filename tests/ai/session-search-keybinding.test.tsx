// @vitest-environment jsdom
/**
 * ⌘F 会话内搜索快捷键测试（二期批 7）：
 * - AI 会话视图（?session= 有值）⌘F → session-search open=true 且
 *   preventDefault（拦截浏览器默认查找）
 * - 无选中会话（?session= 缺省）→ 不打开（防 open 残留到下次进
 *   ChatView 时空开）
 * - 输入框聚焦 → 不劫持（焦点上下文优先，避免打断输入；分发层裸键
 *   守卫不拦修饰键组合，本命令单独收严）
 * useAiLayoutKeybindings 经 MemoryRouter 挂载，window keydown 真派发
 * （darwin ⌘=metaKey 口径，同 keybinding-dispatcher-hook.test.tsx）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// localStorage stub：keybindings 覆盖存储/store persist 模块加载即读取
vi.hoisted(() => {
  const memory = new Map<string, string>();
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
    clear: () => memory.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
});

vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));
// IPC 隔离：全屏/停止等命令在本测试不触发，invoke 兜底拒绝不扰断言
vi.mock("@/lib/ipc", () => ({
  invoke: () => Promise.reject(new Error("noop")),
  on: () => () => {},
  send: () => {},
}));

import { useAiLayoutKeybindings } from "../../src-react/domains/ai/layout/hooks/use-ai-layout-keybindings";
import { useSessionSearchStore } from "../../src-react/domains/ai/store/session-search.store";

/** 挂载快捷键 hook 的替身组件（需 Router/QueryClient 上下文） */
function KeybindingProbe() {
  useAiLayoutKeybindings();
  return null;
}

function mountAt(initialEntry: string) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <KeybindingProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 桩 userAgent 为 mac（⌘=metaKey 口径；jsdom 原值两不沾） */
function stubDarwinUserAgent() {
  Object.defineProperty(window.navigator, "userAgent", {
    value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    configurable: true,
  });
}

/** 派发 ⌘F 并返回事件（可断言 defaultPrevented） */
function fireCmdF(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "f",
    metaKey: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  localStorage.clear();
  stubDarwinUserAgent();
  useSessionSearchStore.getState().setOpen(false);
});

afterEach(cleanup);

describe("⌘F 会话内搜索（批 7）", () => {
  it("AI 会话视图（?session= 有值）→ 打开搜索并 preventDefault", () => {
    mountAt("/module/ai?session=12");

    const event = fireCmdF();

    expect(useSessionSearchStore.getState().open).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it("无选中会话（?session= 缺省）→ 不打开", () => {
    mountAt("/module/ai");

    fireCmdF();

    expect(useSessionSearchStore.getState().open).toBe(false);
  });

  it("输入框聚焦 → 不劫持（open 不变）；失焦后恢复触发", () => {
    mountAt("/module/ai?session=12");
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();

    fireCmdF();
    expect(useSessionSearchStore.getState().open).toBe(false);

    textarea.blur();
    fireCmdF();
    expect(useSessionSearchStore.getState().open).toBe(true);

    textarea.remove();
  });
});
