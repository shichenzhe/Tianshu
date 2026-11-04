import { describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";

// guest-registry-ipc 经 browser-session 传递依赖 Log（→ electron 顶层
// app.getPath），照 mcp-manager.test 先例 mock 替换
vi.mock("../../electron/commons/Log", () => ({
  default: { error: vi.fn() },
}));

import { GuestRegistry } from "../../electron/domains/ai/browser/guest-registry";
import { toGuestLike } from "../../electron/domains/ai/browser/guest-registry-ipc";

/** fake WebContents：按 Electron 原生事件签名驱动（did-navigate 为
 *  (event, url)，event 为 { preventDefault } 之类的事件对象） */
function fakeContents(id: number) {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const contents = {
    id,
    getURL: () => "https://example.com/start",
    isDestroyed: () => false,
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const l of listeners.get(event) ?? []) l(...args);
    },
  };
  return contents as unknown as WebContents & typeof contents;
}

describe("guest-registry-ipc toGuestLike（did-navigate 归一化）", () => {
  it("did-navigate 原生 (event, url) 转形为 ({ url }) 供 registry 读取", () => {
    const registry = new GuestRegistry();
    const contents = fakeContents(41);
    registry.trackGuest(toGuestLike(contents));
    contents.emit(
      "did-navigate",
      { preventDefault: () => {} },
      "https://example.com/next",
    );
    expect(registry.list()[0]?.url).toBe("https://example.com/next");
  });

  it("destroyed 直通：registry 清登记与会话绑定", () => {
    const registry = new GuestRegistry();
    const contents = fakeContents(42);
    registry.trackGuest(toGuestLike(contents));
    registry.bindSession(9, 42);
    contents.emit("destroyed");
    expect(registry.list()).toHaveLength(0);
    expect(registry.forSession(9)).toBeNull();
  });
});
