/**
 * 文件窗口 tab 状态（窗口本地单例——每个独立文件窗各自渲染进程一份，
 * 与 detail-panel.store 的 sessionId 分层不同；注释头风格/邻位激活/
 * reorder 落点修正语义照 detail-panel.store 模式）：
 * 去重键打开（dedupeKeyOf）、邻位激活关闭、busy 防重入、nextId 单调、
 * 关闭时空会话回收（T26，sessionCreatedHere 标记 → lib/session-recycle）。
 * contentKind/saveStatus 派生在 lib/content-kind，标题在 lib/tab-title。
 */
import { create } from "zustand";
import type { FileWindowResource } from "../model/resource";
import { contentKindOfResource, saveStatusOfKind } from "../lib/content-kind";
import { titleOfResource } from "../lib/tab-title";
import { recycleIfEmpty } from "../lib/session-recycle";

export type FileWindowContentKind =
  "md" | "text" | "csv" | "image" | "pdf" | "html" | "audiovideo";

export type FileWindowSaveStatus = "saved" | "unsaved" | "saving" | "hidden";

export interface FileWindowTab {
  id: string;
  resource: FileWindowResource;
  title: string;
  contentKind: FileWindowContentKind;
  dirty: boolean;
  saveStatus: FileWindowSaveStatus;
  /** 防重入：关闭确认/移动进行中（T4/T9 据此禁用按钮） */
  busy: null | "closing" | "moving";
  /** 会话绑定（「移到新窗口」时从 resource 上提，T11 消费） */
  sessionId?: number;
  /** 本窗惰建会话标记（T26，spec §15 项 2）：瞬态字段不入快照——关闭
   *  tab / 整窗时据此回收空会话（message:listBySession 空 → session:delete，
   *  WorkBuddy discardEmptyConversation 同款）；移窗迁移不携带（接收窗
   *  语义上非「本窗创建」，不回收） */
  sessionCreatedHere?: boolean;
  /** 磁盘基线 mtime（ms）：保存冲突检测（见 spec §5.2） */
  baselineMtime: number | null;
  /** 外部写盘标记（T12 瞬态字段，不入快照——serializeTabs 只挑字段）：
   *  脏 tab 收 workspace:fileChanged / 内容区检出「draft 非空+mtime 换血」
   *  置位，FileTabHeader 复用 T8 冲突条交用户裁决（重载磁盘/保留我的） */
  externalChanged?: boolean;
  /** AI 面板输入草稿（T28 瞬态字段，spec §16 项 5，不入快照）：切 tab/
   *  收起面板时 ChatInput 卸载前回存（onDraftUnmount），重挂回灌
   *  （initialDraft）——面板仅挂激活 tab，切 tab 即重挂会丢草稿 */
  inputDraft?: string;
  aiPanelOpen: boolean;
}

interface FileWindowStoreState {
  tabs: FileWindowTab[];
  activeTabId: string;
  /** 自增计数器：id 只增不复用（关后重开同资源得新 id） */
  nextId: number;
  /** 快照恢复完成标记（T9 bootstrap 置位；置位前空窗不触发自动关窗） */
  restored: boolean;
  openTab: (resource: FileWindowResource) => {
    tabId: string;
    created: boolean;
  };
  activate: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  reorderTabs: (fromId: string, toId: string) => void;
  patchTab: (tabId: string, partial: Partial<FileWindowTab>) => void;
  setRestored: () => void;
  reset: () => void;
}

export function dedupeKeyOf(resource: FileWindowResource): string {
  if (resource.kind === "workspace") {
    // 路径归一（T28 spec §16 项 3）：去重复分隔符与 ./ 前缀（"w:7:a.md"
    // 与 "w:7:./a.md" 收敛同键）；../ 不动——越界语义归后端沙箱判定
    const normalized = resource.path
      .replace(/\/+/g, "/")
      .replace(/^(\.\/)+/, "");
    return `w:${resource.workspaceId}:${normalized}`;
  }
  return `l:${resource.itemId}`;
}

/** resource.sessionId 是「移到新窗口」搬运元数据（model/resource.ts 头注释）：
    落 tab 时上提为独立字段并从 resource 剥离——单一事实源，快照往返
    （tab.sessionId ↔ snapshot.sessionId）两侧字段稳定 */
function liftSessionId(resource: FileWindowResource): {
  resource: FileWindowResource;
  sessionId?: number;
} {
  if (resource.kind === "workspace") {
    const { workspaceId, path, sessionId } = resource;
    return { resource: { kind: "workspace", workspaceId, path }, sessionId };
  }
  const { itemId, sessionId } = resource;
  return { resource: { kind: "library", itemId }, sessionId };
}

function newTab(resource: FileWindowResource, id: number): FileWindowTab {
  const { resource: base, sessionId } = liftSessionId(resource);
  const kind = contentKindOfResource(base);
  return {
    id: `fw-tab-${id}`,
    resource: base,
    title: titleOfResource(base),
    contentKind: kind,
    dirty: false,
    saveStatus: saveStatusOfKind(kind, false),
    busy: null,
    sessionId,
    baselineMtime: null,
    externalChanged: false,
    aiPanelOpen: true,
  };
}

export const useFileWindowStore = create<FileWindowStoreState>((set, get) => ({
  tabs: [],
  activeTabId: "",
  nextId: 1,
  restored: false,
  openTab: (resource) => {
    const key = dedupeKeyOf(resource);
    const existing = get().tabs.find((t) => dedupeKeyOf(t.resource) === key);
    if (existing) {
      const { sessionId } = liftSessionId(resource);
      // 移窗接管（T28 spec §16 项 3）：命中既有 tab 时 resource 携带
      // sessionId 且与现值不同 → 覆盖（会话随资源迁来）；不带则保留现值
      const takeOver =
        sessionId !== undefined && sessionId !== existing.sessionId;
      set((s) => ({
        activeTabId: existing.id,
        ...(takeOver
          ? {
              tabs: s.tabs.map((t) =>
                t.id === existing.id ? { ...t, sessionId } : t,
              ),
            }
          : {}),
      }));
      return { tabId: existing.id, created: false };
    }
    const tab = newTab(resource, get().nextId);
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: tab.id,
      nextId: s.nextId + 1,
    }));
    return { tabId: tab.id, created: true };
  },
  activate: (tabId) => set({ activeTabId: tabId }),
  closeTab: (tabId) => {
    const prev = get();
    const idx = prev.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const doomed = prev.tabs[idx];
    const tabs = prev.tabs.filter((t) => t.id !== tabId);
    // 邻位补位：关中间/关首取右邻，关尾回落左邻，关空落 ""
    const activeTabId =
      prev.activeTabId === tabId
        ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? tabs[0]?.id ?? "")
        : prev.activeTabId;
    set({ tabs, activeTabId });
    // 空会话回收（T26）：本窗惰建且非移窗接管（moving 时 closeTab 是移窗
    // 接管——会话随 resource 迁往新窗仍被引用，禁止删）→ fire-and-forget
    // 判空回收（流式中/有消息/失败均静默跳过）
    if (
      doomed.sessionCreatedHere &&
      doomed.sessionId &&
      doomed.busy !== "moving"
    ) {
      void recycleIfEmpty(doomed.sessionId);
    }
  },
  reorderTabs: (fromId, toId) => {
    const { tabs } = get();
    const from = tabs.findIndex((t) => t.id === fromId);
    const to = tabs.findIndex((t) => t.id === toId);
    if (from === -1 || to === -1 || from === to) return;
    const next = [...tabs];
    const [moved] = next.splice(from, 1);
    // 落点语义「拖到目标上 = 放到目标位置（目标及其后顺移）」：
    // from<to 时目标已随删除左移一位，插 to-1 才落在目标原位——与
    // detail-panel.store reorderTab 一致（T4 复用 DetailTabBar onDrop 契约）
    next.splice(to > from ? to - 1 : to, 0, moved);
    set({ tabs: next });
  },
  patchTab: (tabId, partial) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...partial } : t)),
    })),
  setRestored: () => set({ restored: true }),
  reset: () => set({ tabs: [], activeTabId: "", nextId: 1, restored: false }),
}));
