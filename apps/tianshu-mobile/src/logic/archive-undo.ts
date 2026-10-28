import type { SessionBrief } from "@/store/sessions.store";

/**
 * 归档撤销编排（B5：微信/Gmail 范式——点归档立即执行 + 底部 toast 带
 * 「撤销」，窗口到点落定（行移除），点撤销走反操作还原）。
 * 纯逻辑零 RN 依赖：定时器模块级存续（页面卸载窗口不丢），写操作/提示
 * 经注入 ports 收口——store 动作与 toast 发射在调用方装配，便于单测替身。
 */

/** 撤销窗口（ms）：与 ToastHost 带 action 的 info 在显时长（2.5s+2.5s 延长）对齐 */
export const ARCHIVE_UNDO_WINDOW_MS = 5000;

export interface ArchiveUndoPorts {
  /** 归档写操作（sessions.store.update archived:true） */
  archive(id: number): Promise<boolean>;
  /** 撤销反操作（sessions.store.update archived:false） */
  unarchive(id: number): Promise<boolean>;
  /** 窗口到点落定（sessions.store.settleArchive——本地移除暂存行） */
  settle(id: number): void;
  /** 撤销提示条（toast info + action 按钮；文案调用方注入） */
  notify(
    message: string,
    undoLabel: string,
    onUndo: () => void,
  ): void;
  /** 失败提示（toast error；文案调用方注入） */
  notifyError(message: string): void;
}

/** 提示文案（i18n 在调用方解析后注入——纯逻辑不依赖 i18n） */
export interface ArchiveUndoLabels {
  /** 归档成功提示条文案（如「已归档」） */
  archived: string;
  /** 撤销按钮文案（common:undo） */
  undo: string;
  /** 失败文案（chat:actionFailed） */
  failed: string;
}

/** 模块级定时器表：会话 id → 落定定时器（同会话重复归档先清旧窗） */
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function clearWindow(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

/** 撤销归档（toast action 回调/对暂存行的归档按钮复用）：清窗口 + 反操作 */
export function undoArchive(
  id: number,
  ports: ArchiveUndoPorts,
  labels: ArchiveUndoLabels,
): void {
  clearWindow(id);
  void ports.unarchive(id).then((ok) => {
    if (!ok) ports.notifyError(labels.failed);
  });
}

/** 归档入口：立即执行 → 弹撤销条 → 5s 到点 settle 落定 */
export function archiveWithUndo(
  session: Pick<SessionBrief, "id">,
  ports: ArchiveUndoPorts,
  labels: ArchiveUndoLabels,
): void {
  const id = session.id;
  clearWindow(id);
  void ports.archive(id).then((ok) => {
    if (!ok) {
      ports.notifyError(labels.failed);
      return;
    }
    ports.notify(labels.archived, labels.undo, () =>
      undoArchive(id, ports, labels),
    );
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        ports.settle(id);
      }, ARCHIVE_UNDO_WINDOW_MS),
    );
  });
}

/** 测试专用：清空模块级定时器（防跨用例泄漏） */
export function resetArchiveUndoForTest(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}
