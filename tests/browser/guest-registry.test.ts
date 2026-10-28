import { describe, expect, it } from "vitest";
import {
  GuestRegistry,
  type GuestWebContentsLike,
} from "../../electron/domains/ai/browser/guest-registry";

/** 可编程 fake guest：事件可手动触发 */
function fakeGuest(id: number, url = "https://example.com/") {
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  const guest: GuestWebContentsLike & {
    emit(event: string, ...args: unknown[]): void;
    alive: boolean;
  } = {
    id,
    alive: true,
    getURL: () => url,
    isDestroyed: () => !guest.alive,
    on: (event, listener) => {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
    },
    emit: (event, ...args) => {
      for (const l of listeners.get(event) ?? []) l(...args);
    },
  };
  return guest;
}

describe("GuestRegistry", () => {
  it("trackGuest 登记；did-navigate 更新 url；destroyed 移除并解绑会话", () => {
    const registry = new GuestRegistry();
    const guest = fakeGuest(11);
    registry.trackGuest(guest);
    expect(registry.list()).toEqual([
      { id: 11, url: "https://example.com/", sessionId: null },
    ]);
    guest.emit("did-navigate", { url: "https://example.com/next" });
    expect(registry.list()[0].url).toBe("https://example.com/next");
    registry.bindSession(7, 11);
    expect(registry.forSession(7)?.id).toBe(11);
    guest.alive = false;
    guest.emit("destroyed");
    expect(registry.list()).toHaveLength(0);
    expect(registry.forSession(7)).toBeNull();
  });

  it("bindSession：未知 id false；重绑覆盖；他话独占", () => {
    const registry = new GuestRegistry();
    registry.trackGuest(fakeGuest(21));
    registry.trackGuest(fakeGuest(22));
    expect(registry.bindSession(1, 999)).toBe(false);
    expect(registry.bindSession(1, 21)).toBe(true);
    expect(registry.bindSession(2, 21)).toBe(true); // 21 改绑 2
    expect(registry.forSession(1)).toBeNull();
    expect(registry.forSession(2)?.id).toBe(21);
    expect(registry.bindSession(1, 22)).toBe(true); // 1 绑 22
    expect(registry.list().find((g) => g.id === 21)?.sessionId).toBe(2);
    // 会话 2 改指 22：原 guest 21 的 entry.sessionId 残留须清空
    //（否则 list() 显示 21 仍归会话 2，与会话 2 → 22 的实际绑定矛盾）
    expect(registry.bindSession(2, 22)).toBe(true);
    expect(registry.forSession(2)?.id).toBe(22);
    expect(registry.list().find((g) => g.id === 21)?.sessionId).toBeNull();
  });

  it("forSession 返回快照（后续 trackGuest 不污染已取引用语义）", () => {
    const registry = new GuestRegistry();
    registry.trackGuest(fakeGuest(31));
    registry.bindSession(3, 31);
    const entry = registry.forSession(3);
    registry.trackGuest(fakeGuest(32));
    expect(entry?.id).toBe(31);
    expect(registry.forSession(3)?.id).toBe(31);
  });
});
