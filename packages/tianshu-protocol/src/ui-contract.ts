/**
 * ui-drive 线上契约类型（spec 2026-10-17 §2.1，UD-T1 收编单份）：
 * 控制端驱动被控桌面端 UI 的三端点入参/出参——POST ui/openSession|
 * ui/notify|ui/openRoute（逻辑路径见 server-event.ts ENDPOINTS.ui）。
 * 仅桌面被控面（mirror server-face）实现；无头端 capability 不报
 * ui-drive 即控制端不可达（直连调用返回 404——协商门控与端点面互锁）。
 * 返回布尔语义：true = 主窗已驱动；false = 主窗缺失/已销毁的降级态
 * （主进程尽力而为不抛错，控制端据值如实提示）。
 */

/** POST ui/openSession：主窗口聚焦 + 渲染层打开该会话（ui:openSession） */
export interface UiOpenSessionParams {
  sessionId: number;
}

export interface UiOpenSessionResult {
  opened: boolean;
}

/** POST ui/notify：渲染层 sonner toast（ui:notify；不抢焦点） */
export interface UiNotifyParams {
  title: string;
  message?: string;
}

export interface UiNotifyResult {
  notified: boolean;
}

/**
 * POST ui/openRoute：渲染层路由跳转（ui:openRoute）。path 白名单
 * `/module/` 前缀（主进程校验，非白名单 4005 参数错；渲染层二次校验
 * 双保险——spec §4）；openRoute 语义为跳转不聚焦（仅 openSession 抢
 * 焦点，spec §2.1 表）。
 */
export interface UiOpenRouteParams {
  path: string;
}

export interface UiOpenRouteResult {
  opened: boolean;
}
