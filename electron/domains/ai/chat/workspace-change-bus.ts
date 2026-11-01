/**
 * 空间级变更扇出总线（2026-11-01 批③，automation-change-bus 同构）：
 * session.repo 写面（本地 UI invoke 与 face tap 远程写面共用 repo 单点
 * 埋点）创建/更新/删除成功后 emit——双消费者：渲染层全窗
 * WORKSPACE_CHANGED_EVENT（React Query ["workspaces"] 失效）+ face 事件桥
 * （workspace.changed 外发远程控制端重拉）。独立小模块破 repo ↔ bus
 * 循环依赖（rolldown 打包后模块顺序不可依赖——各消费方单向下引本模块）。
 * 列表级刷新信号语义（automation.changed taskId 0 同款），不带实体 id。
 */
import { BrowserWindow } from "electron";
import Log from "../../../commons/Log";
import { WORKSPACE_CHANGED_EVENT } from "../../../../src-react/domains/ai/api/workspace.api";

type WorkspaceChangedListener = () => void;

const listeners = new Set<WorkspaceChangedListener>();

/** 订阅空间级变更（face 桥装配；返回退订函数） */
export function onWorkspaceChanged(fn: WorkspaceChangedListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 空间变更广播：渲染层全窗 WORKSPACE_CHANGED_EVENT + 进程级订阅者扇出
 *  （订阅者异常隔离——face 桥故障不得打断本地通知链） */
export function emitWorkspaceChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(WORKSPACE_CHANGED_EVENT);
  }
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (e) {
      Log.warn("workspace 变更订阅者抛错（已隔离）", e);
    }
  }
}
