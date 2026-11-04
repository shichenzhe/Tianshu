/**
 * ui-drive 渲染层监听（UD-T2，spec §2.3/§3.3）：被控面三端点经主窗
 * webContents.send 推送的 ui:* 三事件 → 渲染层动作。
 * - ui:openSession → 路由 /module/ai?session=<id>（与侧边栏点击同链路：
 *   ChatView 选中态由 URL ?session= 派生，无 store 会话激活动作——查证
 *   裁定见 UD-T2 报告；先例 SessionTreePanel.selectSession 同款导航）
 * - ui:notify → sonner toast（title + 可选 description；Toaster 挂
 *   main.tsx 应用根，React 外调用可用；title/message 渲染层 typeof
 *   string 复核——主进程只验 title 非空，非字符串不透传给 toast）
 * - ui:openRoute → router 跳转（/module/ 前缀 + 段校验二次防线双保险
 *   ——主进程 isAllowedRoute 已拒非白名单/穿越段 4005（UD-T3 上提，与
 *   本层 isSafeModuleRoute 同款语义），渲染层再防一道防回归）
 * 注册于 main.tsx（registerMainWindowNavigate 同款先例：router 实例注入、
 * React 外单次注册无生命周期；事件仅发主窗，文件窗共用入口注册也不会收到）。
 */
import { toast } from "sonner";

import { on } from "@/lib/ipc";
import type {
  UiNotifyParams,
  UiOpenRouteParams,
  UiOpenSessionParams,
} from "@tianshu/protocol";

/** router 结构面（main-window-navigate 同款：结构类型免耦合内部 Router；
 * options.replace——SessionTreePanel.selectSession 先例） */
interface NavigateRouter {
  navigate: (to: string, options?: { replace?: boolean }) => unknown;
}

/**
 * openRoute 渲染层白名单（双保险，与主进程 isAllowedRoute 同款语义——
 * UD-T3 上提后两道防线一致）：
 * 1. 必须以 "/module/" 起始；
 * 2. 不得含 "." / ".." 点段——resolvePath 会归一点段，"/module/../login"
 *    归一后为 "/login"（前缀穿越）；".." 段按字面比较（"..foo" 不算）；
 * 3. 不得含 "://" 或 "//" 空段——双斜杠在归一/协议相对语义下有歧义，
 *    "/module//evil" 一并拒绝。查询串（"?" 后）不参与段校验（// 检查在
 *    切出查询串后的路径部分做——UD-T2 审查：合法查询值含 // 不误拒）。
 */
function isSafeModuleRoute(path: string): boolean {
  if (!path.startsWith("/module/")) return false;
  const routePart = path.split("?")[0];
  if (routePart.includes("//")) return false;
  return routePart
    .split("/")
    .every((segment) => segment !== "." && segment !== "..");
}

export function initUiDriveListener(router: NavigateRouter): () => void {
  const offOpenSession = on("ui:openSession", (_e, payload) => {
    const sessionId = (payload as UiOpenSessionParams | undefined)?.sessionId;
    if (typeof sessionId !== "number" || !Number.isFinite(sessionId)) return;
    // replace:true——selectSession 先例：远端驱动跳转不往被控端 history
    // 压栈（回退键不被远控吃掉）
    void router.navigate(`/module/ai?session=${sessionId}`, { replace: true });
  });
  const offNotify = on("ui:notify", (_e, payload) => {
    const p = payload as Partial<UiNotifyParams> | undefined;
    if (typeof p?.title !== "string" || p.title === "") return;
    // message typeof string 复核（主进程未验型，非字符串不透传给 toast）
    const message = typeof p.message === "string" ? p.message : undefined;
    toast(
      p.title,
      message !== undefined ? { description: message } : undefined,
    );
  });
  const offOpenRoute = on("ui:openRoute", (_e, payload) => {
    const path = (payload as UiOpenRouteParams | undefined)?.path;
    if (typeof path !== "string" || !isSafeModuleRoute(path)) return;
    void router.navigate(path);
  });
  return () => {
    offOpenSession();
    offNotify();
    offOpenRoute();
  };
}
