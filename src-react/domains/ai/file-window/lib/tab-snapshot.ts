/**
 * tabs 快照序列化（WorkBuddy sessionState 对齐）：resource/title/
 * contentKind/dirty/sessionId/aiPanelOpen 入快照；id/busy/baselineMtime/
 * saveStatus/externalChanged 不入——restore 重建 id、清运行态，saveStatus
 * 按恢复后 contentKind 的可编辑性重算（spec §5.1：只读类恒 hidden，不搬
 * 序列化前的运行态徽标）。
 */
import type { FileWindowTab } from "../store/file-window.store";
import type { FileWindowResource } from "../model/resource";
import { saveStatusOfKind } from "./content-kind";

export interface TabSnapshotItem {
  resource: FileWindowResource;
  title: string;
  contentKind: string;
  dirty: boolean;
  sessionId?: number;
  aiPanelOpen: boolean;
}

export function serializeTabs(tabs: FileWindowTab[]): TabSnapshotItem[] {
  return tabs.map((t) => ({
    resource: t.resource,
    title: t.title,
    contentKind: t.contentKind,
    dirty: t.dirty,
    sessionId: t.sessionId,
    aiPanelOpen: t.aiPanelOpen,
  }));
}

export function restoreTabs(items: TabSnapshotItem[]): FileWindowTab[] {
  return items.map((item, i) => {
    // 快照 contentKind 权威（Task 14 library 细化后随快照保持；
    // workspace 与 contentKindOfResource 确定性一致），saveStatus 由它派生
    const kind = item.contentKind as FileWindowTab["contentKind"];
    return {
      id: `fw-tab-${i + 1}`,
      resource: item.resource,
      title: item.title,
      contentKind: kind,
      dirty: item.dirty,
      saveStatus: saveStatusOfKind(kind, item.dirty),
      busy: null,
      sessionId: item.sessionId,
      baselineMtime: null,
      externalChanged: false,
      aiPanelOpen: item.aiPanelOpen,
    };
  });
}
