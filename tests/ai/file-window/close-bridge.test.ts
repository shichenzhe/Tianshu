// @vitest-environment jsdom
/**
 * 关闭握手 + 快照持久化（spec §4.4/§4.1）：
 * - useCloseBridge：close-request → resolveDirtyTabs ok=confirmClose /
 *   cancelled=cancelClose；空窗自动关仅 restored 后 tabs 归零触发
 *   （bootstrap 完成前误关守卫）
 * - bootstrapWindow：快照恢复（dirty 重置 false/nextId 同步/activeTabId
 *   权威、初始投递跳过重放）+ 无快照直接投递 + 追加投递开 tab 两路径
 * - useSessionSnapshot：store 变更防抖 500ms 落 setSessionState（终态合并）
 * mock 骨架参照 brief；invoke 走 lib/ipc mock，事件走 window.ipcRenderer
 * 全局桩（listeners Map 按 channel 存注册回调）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

const invokeMock = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(
  () => new Map<string, (payload: unknown) => void>(),
);
vi.mock("../../../src-react/lib/ipc", () => ({ invoke: invokeMock }));
vi.stubGlobal("ipcRenderer", {
  on: (ch: string, cb: (e: unknown, p: unknown) => void) => {
    listeners.set(ch, cb as (p: unknown) => void);
    return () => listeners.delete(ch);
  },
});

import { useFileWindowStore } from "../../../src-react/domains/ai/file-window/store/file-window.store";
import { useCloseBridge } from "../../../src-react/domains/ai/file-window/hooks/use-window-close-bridge";
import {
  bootstrapWindow,
  useSessionSnapshot,
} from "../../../src-react/domains/ai/file-window/hooks/use-session-snapshot";

/** deliver/close-request 事件触发（存的是 preload 注册的原回调） */
const deliver = (payload: unknown) =>
  listeners.get("fileWindow:deliver")?.(undefined, payload);
const closeRequest = () =>
  listeners.get("fileWindow:close-request")?.(undefined);
const invokedChannels = () => invokeMock.mock.calls.map(([ch]) => ch as string);

beforeEach(() => {
  useFileWindowStore.getState().reset();
  invokeMock.mockReset().mockResolvedValue(null);
  listeners.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useCloseBridge 关闭握手", () => {
  it("close-request → resolveDirtyTabs ok → confirmClose", async () => {
    const resolveDirtyTabs = vi.fn().mockResolvedValue("ok");
    renderHook(() => useCloseBridge({ windowId: "fw-1", resolveDirtyTabs }));
    closeRequest();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("fileWindow:confirmClose", {
        windowId: "fw-1",
      }),
    );
  });

  it("close-request → cancelled → cancelClose（不误关）", async () => {
    const resolveDirtyTabs = vi.fn().mockResolvedValue("cancelled");
    renderHook(() => useCloseBridge({ windowId: "fw-1", resolveDirtyTabs }));
    closeRequest();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("fileWindow:cancelClose", {
        windowId: "fw-1",
      }),
    );
    expect(invokedChannels()).not.toContain("fileWindow:confirmClose");
  });

  it("最后一个 tab 关闭（已 restored）→ 空窗自动关 confirmClose", async () => {
    renderHook(() =>
      useCloseBridge({
        windowId: "fw-1",
        resolveDirtyTabs: vi.fn().mockResolvedValue("ok"),
      }),
    );
    const s = useFileWindowStore.getState();
    s.setRestored();
    const { tabId } = s.openTab({
      kind: "workspace",
      workspaceId: 7,
      path: "a.md",
    });
    s.closeTab(tabId);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("fileWindow:confirmClose", {
        windowId: "fw-1",
      }),
    );
  });

  it("未 restored 时关掉最后一个 tab 不自动关（防 bootstrap 前误关）", async () => {
    const { unmount } = renderHook(() =>
      useCloseBridge({
        windowId: "fw-1",
        resolveDirtyTabs: vi.fn().mockResolvedValue("ok"),
      }),
    );
    const s = useFileWindowStore.getState();
    const { tabId } = s.openTab({
      kind: "workspace",
      workspaceId: 7,
      path: "a.md",
    });
    s.closeTab(tabId);
    await new Promise((r) => setTimeout(r, 20));
    expect(invokedChannels()).not.toContain("fileWindow:confirmClose");
    unmount();
  });

  it("空投递 bootstrap 完成（restored 且 tabs 恒 0）不触发空窗自动关——预热窗安全不变量（T20）", async () => {
    // 预热窗最坏情形：收到空 deliver 并完成 bootstrap（restored=true、
    // tabs 从未 >0）——自动关守卫 prev.tabs.length > 0 不满足，不误关
    renderHook(() =>
      useCloseBridge({
        windowId: "fw-1",
        resolveDirtyTabs: vi.fn().mockResolvedValue("ok"),
      }),
    );
    const off = bootstrapWindow("fw-1");
    deliver({ resources: [] });
    await waitFor(() =>
      expect(useFileWindowStore.getState().restored).toBe(true),
    );
    expect(useFileWindowStore.getState().tabs).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(invokedChannels()).not.toContain("fileWindow:confirmClose");
    off();
  });
});

describe("bootstrapWindow 快照恢复/投递", () => {
  it("deliver + 快照：恢复 tabs（dirty 重置/nextId 同步/activeTabId 权威、初始投递不重放）", async () => {
    invokeMock.mockImplementation((ch: string) =>
      ch === "fileWindow:getSessionState"
        ? {
            tabs: [
              {
                resource: { kind: "workspace", workspaceId: 7, path: "a.md" },
                title: "a.md",
                contentKind: "md",
                dirty: true,
                aiPanelOpen: true,
              },
              {
                resource: { kind: "workspace", workspaceId: 7, path: "p.png" },
                title: "p.png",
                contentKind: "image",
                dirty: false,
                aiPanelOpen: false,
              },
            ],
            activeTabId: "fw-tab-2",
          }
        : null,
    );
    const off = bootstrapWindow("fw-1");
    deliver({
      resources: [{ kind: "workspace", workspaceId: 7, path: "a.md" }],
    });
    await waitFor(() =>
      expect(useFileWindowStore.getState().restored).toBe(true),
    );
    const s = useFileWindowStore.getState();
    expect(s.tabs.map((t) => t.id)).toEqual(["fw-tab-1", "fw-tab-2"]);
    // 草稿不入快照：dirty 一律重置，saveStatus 按恢复后可编辑性重算
    expect(s.tabs[0].dirty).toBe(false);
    expect(s.tabs[0].saveStatus).toBe("saved");
    expect(s.tabs[1].saveStatus).toBe("hidden");
    // 初始投递的 a.md 不重放激活：activeTabId 快照权威
    expect(s.activeTabId).toBe("fw-tab-2");
    // nextId 同步：后续 openTab 不铸重复 id
    const { tabId } = s.openTab({
      kind: "workspace",
      workspaceId: 7,
      path: "b.md",
    });
    expect(tabId).toBe("fw-tab-3");
    expect(useFileWindowStore.getState().nextId).toBe(4);
    off();
  });

  it("快照 activeTabId 为关前旧 id（重铸后不存在）→ 回落首个 tab 不错位", async () => {
    invokeMock.mockImplementation((ch: string) =>
      ch === "fileWindow:getSessionState"
        ? {
            tabs: [
              {
                resource: { kind: "workspace", workspaceId: 7, path: "b.md" },
                title: "b.md",
                contentKind: "md",
                dirty: false,
                aiPanelOpen: true,
              },
              {
                resource: { kind: "workspace", workspaceId: 7, path: "c.md" },
                title: "c.md",
                contentKind: "md",
                dirty: false,
                aiPanelOpen: true,
              },
            ],
            // 开 3 关 1 后关前旧 id：restoreTabs 重铸 fw-tab-1..2 后不存在
            activeTabId: "fw-tab-3",
          }
        : null,
    );
    const off = bootstrapWindow("fw-1");
    deliver({
      resources: [{ kind: "workspace", workspaceId: 7, path: "b.md" }],
    });
    await waitFor(() =>
      expect(useFileWindowStore.getState().restored).toBe(true),
    );
    const s = useFileWindowStore.getState();
    expect(s.tabs.map((t) => t.id)).toEqual(["fw-tab-1", "fw-tab-2"]);
    expect(s.activeTabId).toBe("fw-tab-1");
    off();
  });

  it("deliver 无快照：直接投递开 tab 并置 restored", async () => {
    const off = bootstrapWindow("fw-1");
    deliver({
      resources: [{ kind: "workspace", workspaceId: 7, path: "a.md" }],
    });
    await waitFor(() =>
      expect(useFileWindowStore.getState().restored).toBe(true),
    );
    expect(useFileWindowStore.getState().tabs).toHaveLength(1);
    off();
  });

  it("追加投递（已 restored）：deliver 开新 tab", async () => {
    const off = bootstrapWindow("fw-1");
    deliver({
      resources: [{ kind: "library", itemId: 3 }],
    });
    await waitFor(() =>
      expect(useFileWindowStore.getState().restored).toBe(true),
    );
    deliver({
      resources: [{ kind: "workspace", workspaceId: 7, path: "a.md" }],
    });
    await waitFor(() =>
      expect(useFileWindowStore.getState().tabs).toHaveLength(2),
    );
    off();
  });
});

describe("useSessionSnapshot 防抖落盘", () => {
  it("store 变更防抖 500ms 落 setSessionState（含序列化 tabs）", async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useSessionSnapshot("fw-1"));
    useFileWindowStore
      .getState()
      .openTab({ kind: "workspace", workspaceId: 7, path: "a.md" });
    expect(invokedChannels()).not.toContain("fileWindow:setSessionState");
    await vi.advanceTimersByTimeAsync(500);
    const call = invokeMock.mock.calls.find(
      ([ch]) => ch === "fileWindow:setSessionState",
    );
    expect(call?.[1]).toMatchObject({
      windowId: "fw-1",
      snapshot: {
        tabs: [
          {
            resource: { kind: "workspace", workspaceId: 7, path: "a.md" },
            title: "a.md",
            contentKind: "md",
            dirty: false,
            sessionId: undefined,
            aiPanelOpen: true,
          },
        ],
        activeTabId: "fw-tab-1",
      },
    });
    unmount();
  });

  it("防抖合并：连续变更只落一次终态快照", async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useSessionSnapshot("fw-1"));
    const s = useFileWindowStore.getState();
    s.openTab({ kind: "workspace", workspaceId: 7, path: "a.md" });
    s.openTab({ kind: "workspace", workspaceId: 7, path: "b.md" });
    await vi.advanceTimersByTimeAsync(500);
    const calls = invokeMock.mock.calls.filter(
      ([ch]) => ch === "fileWindow:setSessionState",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({
      snapshot: { activeTabId: "fw-tab-2" },
    });
    unmount();
  });
});
