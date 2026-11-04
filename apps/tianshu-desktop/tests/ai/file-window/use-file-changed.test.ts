// @vitest-environment jsdom
/**
 * useFileChanged（T12 + T14 修复轮）：外部写盘事件消费——
 * - workspace:fileChanged：同路径非脏 tab 静默 invalidate 精确键
 *   ["fw-file", wsId, path] 重载；脏 tab 置 externalChanged（冲突条接
 *   手）不 invalidate（saving 亚帧跳过——保存自广播防闪冲突条）；不匹配
 *   不动作；卸载退订
 * - fileWindow:libraryChanged（T14 修复轮）：AI 直改库文件 → 同 itemId
 *   library tab 同一分流（非脏 invalidate 条目/内容两键；脏置
 *   externalChanged 交冲突条——保存时 updatedAt 基线兜底）
 * mock 骨架同 close-bridge.test.ts（listeners Map 按 channel 存注册回调；
 * 事件触发按 preload 契约传 (event, payload) 两参）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";

const listeners = new Map<string, (e: unknown, p: unknown) => void>();
vi.stubGlobal("ipcRenderer", {
  on: (ch: string, cb: (e: unknown, p: unknown) => void) => {
    listeners.set(ch, cb);
    return () => listeners.delete(ch);
  },
});

import { useFileWindowStore } from "../../../src-react/domains/ai/file-window/store/file-window.store";
import { useFileChanged } from "../../../src-react/domains/ai/file-window/hooks/use-file-changed";

/** fileChanged 事件触发（存的是 hook 注册的原回调，按 preload 契约两参） */
const fileChanged = (payload: unknown) =>
  listeners.get("workspace:fileChanged")?.(undefined, payload);

/** libraryChanged 事件触发（T14 修复轮） */
const libraryChanged = (payload: unknown) =>
  listeners.get("fileWindow:libraryChanged")?.(undefined, payload);

beforeEach(() => {
  useFileWindowStore.getState().reset();
  listeners.clear();
});

afterEach(() => cleanup());

function openWsTab(path = "a.md", workspaceId = 7): string {
  return useFileWindowStore
    .getState()
    .openTab({ kind: "workspace", workspaceId, path }).tabId;
}

describe("useFileChanged", () => {
  it("非脏同路径 tab → invalidate 精确键，dirty/externalChanged 不动", async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    openWsTab();
    renderHook(() => useFileChanged(client));
    fileChanged({ workspaceId: 7, path: "a.md" });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith({
      queryKey: ["fw-file", 7, "a.md"],
    });
    expect(useFileWindowStore.getState().tabs[0].dirty).toBe(false);
    expect(useFileWindowStore.getState().tabs[0].externalChanged).toBeFalsy();
  });

  it("脏 tab → externalChanged 标记（不 invalidate）", async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const tabId = openWsTab();
    useFileWindowStore.getState().patchTab(tabId, { dirty: true });
    renderHook(() => useFileChanged(client));
    fileChanged({ workspaceId: 7, path: "a.md" });
    await waitFor(() =>
      expect(useFileWindowStore.getState().tabs[0].externalChanged).toBe(true),
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("保存中（saving）自广播亚帧 → 跳过：不置 externalChanged 不闪冲突条", async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const tabId = openWsTab();
    // 写回广播先于写回 patch 到达的亚帧：tab 仍 dirty+saving
    useFileWindowStore
      .getState()
      .patchTab(tabId, { dirty: true, saveStatus: "saving" });
    renderHook(() => useFileChanged(client));
    fileChanged({ workspaceId: 7, path: "a.md" });
    await new Promise((r) => setTimeout(r, 20));
    expect(useFileWindowStore.getState().tabs[0].externalChanged).toBeFalsy();
    expect(spy).not.toHaveBeenCalled();
  });

  it("路径或 workspaceId 不匹配 → 不动作", async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    openWsTab();
    renderHook(() => useFileChanged(client));
    fileChanged({ workspaceId: 7, path: "b.md" });
    fileChanged({ workspaceId: 8, path: "a.md" });
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).not.toHaveBeenCalled();
    expect(useFileWindowStore.getState().tabs[0].externalChanged).toBeFalsy();
  });

  it("卸载退订：unmount 后事件不再 invalidate", async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    openWsTab();
    const { unmount } = renderHook(() => useFileChanged(client));
    unmount();
    fileChanged({ workspaceId: 7, path: "a.md" });
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("useFileChanged × fileWindow:libraryChanged（T14 修复轮）", () => {
  function openLibTab(itemId = 3): string {
    return useFileWindowStore.getState().openTab({ kind: "library", itemId })
      .tabId;
  }

  it("非脏同 itemId library tab → invalidate 条目/内容两键（前缀匹配）", async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    openLibTab(3);
    renderHook(() => useFileChanged(client));
    libraryChanged({ itemId: 3 });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith({
      queryKey: ["fw-library-item", 3],
    });
    expect(spy).toHaveBeenCalledWith({
      queryKey: ["fw-library-content", 3],
    });
    expect(useFileWindowStore.getState().tabs[0].externalChanged).toBeFalsy();
  });

  it("脏 tab → externalChanged 标记（不 invalidate；保存时 updatedAt 基线兜底）", async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const tabId = openLibTab();
    useFileWindowStore.getState().patchTab(tabId, { dirty: true });
    renderHook(() => useFileChanged(client));
    libraryChanged({ itemId: 3 });
    await waitFor(() =>
      expect(useFileWindowStore.getState().tabs[0].externalChanged).toBe(true),
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("itemId 不匹配 / workspace tab → 不动作", async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    openLibTab(3);
    openWsTab("a.md");
    renderHook(() => useFileChanged(client));
    libraryChanged({ itemId: 8 });
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).not.toHaveBeenCalled();
    expect(useFileWindowStore.getState().tabs[0].externalChanged).toBeFalsy();
  });
});
