/**
 * 项目级变更扇出总线（2026-11-01 批③，automation-change-bus 同构）：
 * project.repo 写面（本地 UI invoke 与 face tap 远程写面共用 repo 单点
 * 埋点）创建/更新/删除成功后 emit——双消费者：渲染层全窗
 * PROJECT_CHANGED_EVENT（React Query ["projects"] 前缀失效）+ face 事件桥
 * （project.changed 外发远程控制端重拉）。资产空间行连带变不另发
 * workspace 事件（不进 workspace 分组树，projectId:null 过滤语义不变）。
 */
import { BrowserWindow } from "electron";
import Log from "../../commons/Log";
import { PROJECT_CHANGED_EVENT } from "../../../src-react/domains/project/api/project.api";

type ProjectChangedListener = () => void;

const listeners = new Set<ProjectChangedListener>();

/** 订阅项目级变更（face 桥装配；返回退订函数） */
export function onProjectChanged(fn: ProjectChangedListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 项目变更广播：渲染层全窗 PROJECT_CHANGED_EVENT + 进程级订阅者扇出
 *  （订阅者异常隔离——face 桥故障不得打断本地通知链） */
export function emitProjectChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(PROJECT_CHANGED_EVENT);
  }
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (e) {
      Log.warn("project 变更订阅者抛错（已隔离）", e);
    }
  }
}
