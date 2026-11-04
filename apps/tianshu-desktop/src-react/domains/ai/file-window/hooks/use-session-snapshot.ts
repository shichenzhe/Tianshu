/**
 * 快照持久化（spec §4.1）：store 变更防抖 500ms setSessionState；
 * bootstrap 取快照 restoreTabs（恢复后 setRestored）。deliver 事件
 * （主进程投递 resources）同文件消费——统一窗口入口编排：
 * - 未 restored 且快照有 tabs：快照权威恢复，初始投递 resources 不重放
 *   （openTab 去重兜底）；草稿不入快照，dirty 一律重置 false
 * - 未 restored 且无快照：直接投递开 tab（新窗冷启动）
 * - 已 restored：追加投递（「向已开窗口发资源」）开新 tab
 */
import { useEffect } from "react";
import FileWindowApi, { type DeliverPayload } from "../api/file-window.api";
import {
  restoreTabs,
  serializeTabs,
  type TabSnapshotItem,
} from "../lib/tab-snapshot";
import { useFileWindowStore } from "../store/file-window.store";

interface SessionSnapshot {
  tabs: TabSnapshotItem[];
  activeTabId: string;
}

async function handleDeliver(
  windowId: string,
  payload: DeliverPayload,
): Promise<void> {
  if (useFileWindowStore.getState().restored) {
    payload.resources.forEach((r) => useFileWindowStore.getState().openTab(r));
    return;
  }
  let snap: SessionSnapshot | null = null;
  try {
    snap = (await FileWindowApi.restoreSessionState(
      windowId,
    )) as SessionSnapshot | null;
  } catch {
    snap = null; // 取快照失败按无快照兜底：退回投递开 tab
  }
  const items = snap?.tabs ?? [];
  if (snap && items.length > 0) {
    // 快照有 tabs：初始投递不重放（openTab 去重兜底）；dirty 一律重置
    // false（草稿不在快照内，true 会误导 ⌘S/关闭确认），saveStatus 由
    // restoreTabs 按重置后可编辑性重算
    const tabs = restoreTabs(items.map((item) => ({ ...item, dirty: false })));
    // activeTabId 随重建 id 重索引：快照存的是关前旧 id（restoreTabs 重铸
    // fw-tab-1..N，如开 3 关 1 后恢复即错位），不存在则回落首个 tab
    const activeTabId = tabs.some((t) => t.id === snap.activeTabId)
      ? snap.activeTabId
      : (tabs[0]?.id ?? "");
    useFileWindowStore.setState({
      tabs,
      activeTabId,
      // nextId 同步：后续 openTab 不铸重复 id
      nextId: tabs.length + 1,
    });
  } else {
    payload.resources.forEach((r) => useFileWindowStore.getState().openTab(r));
  }
  useFileWindowStore.getState().setRestored();
}

export function bootstrapWindow(windowId: string): () => void {
  // 事件串行化：恢复中的异步 getSessionState 期间再投递不丢也不乱序；
  // 每环自吞异常——单环 reject 不静默阻断后续投递
  let queue: Promise<void> = Promise.resolve();
  return FileWindowApi.onDeliver((payload) => {
    queue = queue.then(() =>
      handleDeliver(windowId, payload).catch(() => {
        // 本环处理失败（如 openTab 抛错）：跳过继续下一投递
      }),
    );
  });
}

export function useSessionSnapshot(windowId: string): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = useFileWindowStore.subscribe((s) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void FileWindowApi.saveSessionState(windowId, {
          tabs: serializeTabs(s.tabs),
          activeTabId: s.activeTabId,
        }).catch(() => {
          // 快照尽力而为：失败不影响窗口功能
        });
      }, 500);
    });
    return () => {
      clearTimeout(timer);
      unsub();
    };
  }, [windowId]);
}
