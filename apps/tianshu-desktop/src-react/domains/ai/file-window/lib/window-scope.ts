/**
 * 文件窗窗口域标记（T22，spec §13 项 3）：文件窗渲染进程在 FileWindowView
 * 挂载期捕获 windowId（hash 导航后 query 丢失，模块级单例是路由跳回的
 * 唯一来源——prewarm 池窗转正/冷启同路）。主窗进程恒未标记。
 * forwardMainRoute：文件窗内主窗路由跳转（ChatPane 子菜单内部 navigate
 * 「配置模型/管理专家/管理技能」等）→ invoke fileWindow:openRoute 聚焦
 * 主窗跳同路由；主窗域恒不转发。
 */
import { invoke } from "@/lib/ipc";

let scopeWindowId: string | null = null;

/** 文件窗挂载标记（幂等；同窗仅一个 windowId） */
export function markFileWindowScope(windowId: string): void {
  scopeWindowId = windowId || null;
}

/** 当前渲染进程是否文件窗 */
export function isFileWindowScope(): boolean {
  return scopeWindowId !== null;
}

/** 跳回本文件窗的路由（guard 重定向用；windowId 回填） */
export function fileWindowRoute(): string {
  return `/file-window?windowId=${scopeWindowId ?? ""}`;
}

/** 主窗路由跳转转发：已转发返回 true（调用方跳回/跳过本地渲染）；
 *  主窗域返回 false（本地 navigate 照常）。失败静默——主窗缺失由
 *  主进程 openRoute 兜底为 no-op */
export function forwardMainRoute(path: string): boolean {
  if (!isFileWindowScope()) return false;
  void invoke("fileWindow:openRoute", { hash: path }).catch(() => undefined);
  return true;
}
