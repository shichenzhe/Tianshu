/**
 * 会话级变更扇出总线（workspace-change-bus 同构，2026-11-06）：
 * session.repo 结构性写面（本地 UI invoke 与 face tap 远程写面共用 repo
 * 单点埋点）创建/删除/归档/置顶/改名成功后 emit——消费者：渲染层全窗
 * SESSION_CHANGED_EVENT（React Query ["sessions"] 失效）。修复背景：移动端
 * 经 server-face 建会话落本地库后，桌面侧栏树无任何信号（本地路径靠渲染
 * 层写后主动 invalidate）——点其它会话触发重拉才可见。独立小模块破
 * repo ↔ bus 循环依赖（rolldown 打包后模块顺序不可依赖——各消费方单向
 * 下引本模块）。列表级刷新信号语义（workspace.changed 同款），不带实体
 * id；onSessionChanged 订阅面预留 face 桥外发（session.changed 协议类型
 * 涉 @tianshu/protocol FaceEvent 扩面，另行立项不随本修复）。
 */
import { BrowserWindow } from "electron";
import Log from "../../../commons/Log";
import { SESSION_CHANGED_EVENT } from "../../../../src-react/domains/ai/api/session.api";

type SessionChangedListener = () => void;

const listeners = new Set<SessionChangedListener>();

/** 订阅会话级变更（返回退订函数；face 桥装配预留） */
export function onSessionChanged(fn: SessionChangedListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 会话变更广播：渲染层全窗 SESSION_CHANGED_EVENT + 进程级订阅者扇出
 *  （订阅者异常隔离——单订阅者故障不得打断本地通知链） */
export function emitSessionChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(SESSION_CHANGED_EVENT);
  }
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (e) {
      Log.warn("session 变更订阅者抛错（已隔离）", e);
    }
  }
}
