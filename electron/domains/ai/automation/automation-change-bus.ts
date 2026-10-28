/**
 * 任务级变更扇出总线（移动端 CRUD 批）：原 notifyTasksChanged/notifyChanged
 * 三处全窗广播的进程级扩展——订阅者（face 事件桥）经 onAutomationChanged
 * 收 automation.changed 推远程控制端。独立小模块破 repo ↔ event-bus
 * 循环依赖（rolldown 打包后模块顺序不可依赖——各消费方单向下引本模块）。
 * taskId 未知时传 0（列表级刷新信号，消费端以重拉为准——协议
 * AutomationChangedPayload.taskId 必带的占位语义）。
 */
import { BrowserWindow } from "electron";
import Log from "../../../commons/Log";
import { AUTOMATION_CHANGED_EVENT } from "../../../../src-react/domains/ai/automation/api/automation.api";

type AutomationChangedListener = (payload: { taskId: number }) => void;

const listeners = new Set<AutomationChangedListener>();

/** 订阅任务级变更（face 桥装配；返回退订函数） */
export function onAutomationChanged(fn: AutomationChangedListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 任务变更广播：渲染层全窗 AUTOMATION_CHANGED_EVENT + 进程级订阅者扇出
 * （订阅者异常隔离——face 桥故障不得打断本地通知链） */
export function emitAutomationChanged(taskId = 0): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(AUTOMATION_CHANGED_EVENT);
  }
  for (const fn of [...listeners]) {
    try {
      fn({ taskId });
    } catch (e) {
      Log.warn("automation 变更订阅者抛错（已隔离）", e);
    }
  }
}
