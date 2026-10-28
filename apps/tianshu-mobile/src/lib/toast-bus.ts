/**
 * 轻提示总线（真机修复：原生 Alert 在 Expo Go/Android 上不可靠——不弹/
 * 迟弹/空标题形态异常）：纯逻辑零 RN 依赖，组件层 ToastHost 订阅渲染，
 * store/事件链等组件外消费面经 toast.* 发射（对齐桌面 Sonner 语义分级）。
 * action 支持（撤销删除批）：info/warning 可携带动作按钮（undo pattern
 * ——苹果 HIG 破坏性操作优先 undo 而非确认弹窗），有 action 时 ToastHost
 * 延长显示窗口。
 */

export type ToastKind = "info" | "warning" | "error";

/** 动作按钮（如撤销）：label 展示、onAction 点击回调（宿主收条即调） */
export interface ToastAction {
  label: string;
  onAction: () => void;
}

export interface ToastPayload {
  kind: ToastKind;
  message: string;
  action?: ToastAction;
}

type Listener = (payload: ToastPayload) => void;

const listeners = new Set<Listener>();

/** 订阅（返回退订函数） */
export function subscribeToast(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function emit(payload: ToastPayload): void {
  // 快照遍历：回调内退订不跳队
  for (const cb of [...listeners]) cb(payload);
}

/** 提示发射面（info 提示/warning 告警/error 报错；info/warning 可携带
 *  动作按钮——撤销等 undo 语义） */
export const toast = {
  info(message: string, action?: ToastAction): void {
    emit({ kind: "info", message, action });
  },
  warning(message: string, action?: ToastAction): void {
    emit({ kind: "warning", message, action });
  },
  error(message: string): void {
    emit({ kind: "error", message });
  },
};
