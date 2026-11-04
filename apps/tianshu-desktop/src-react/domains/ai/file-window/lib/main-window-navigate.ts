/**
 * 主窗侧跨窗导航监听（T22，spec §13 项 3）：文件窗 ChatPane 的设置类
 * 入口（onOpenSettings/onOpenMcp）invoke fileWindow:openRoute → 主进程
 * 聚焦主窗并推 fileWindow:navigate → 本监听经 router 跳应用内路由。
 * 注册于 main.tsx（所有窗口同一入口；事件仅发往主窗 webContents，
 * 文件窗注册了也不会收到）。
 */
import { on } from "@/lib/ipc";

/** router 结构面（createHashRouter 返回值子集；结构类型免耦合内部 Router 类型） */
interface NavigateRouter {
  navigate: (to: string) => unknown;
}

export function registerMainWindowNavigate(router: NavigateRouter): () => void {
  return on("fileWindow:navigate", (_e, payload) => {
    const hash = (payload as { hash?: unknown } | undefined)?.hash;
    // 主进程 openRoute 已校验 "/" 起始，此处双保险——不透传任意值给 router
    if (typeof hash !== "string" || !hash.startsWith("/")) return;
    void router.navigate(hash);
  });
}
