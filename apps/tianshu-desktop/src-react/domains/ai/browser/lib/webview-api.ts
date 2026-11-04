// src-react/domains/ai/browser/lib/webview-api.ts
/**
 * <webview> DOM 命令收窄：webview.d.ts 的 ref 类型是 HTMLElement，
 * goBack/goForward/reload 与原生事件监听在此统一转一道（调用方不散落 cast）。
 */
export interface WebviewElement extends HTMLElement {
  goBack(): void;
  goForward(): void;
  reload(): void;
  /** 导航历史查询（did-navigate DOM 事件 detail 不含 canGoBack/canGoForward，
   *  导航后需经元素方法查询） */
  canGoBack(): boolean;
  canGoForward(): boolean;
  /** 命令式导航：工具栏地址栏提交走此入口（受控 src 属性回写会令
   *  Electron 对属性变化调 loadURL，中止在途导航，ERR_ABORTED）。注意
   *  guest attach + dom-ready 前调用会抛错，仅用于已挂载的 webview */
  loadURL(url: string): Promise<void>;
  /** guest WebContents id（dom-ready 后有效；browser_use 绑定上报用） */
  getWebContentsId(): number;
  /** 页内查找（计数经 found-in-page DOM 事件回流）；返回 requestId */
  findInPage(
    text: string,
    options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean },
  ): number;
  /** 结束查找：clearSelection 同时清页面高亮 */
  stopFindInPage(
    action: "clearSelection" | "keepSelection" | "activateSelection",
  ): void;
  /** 页面缩放（菜单钳制 0.25–5）；跨域导航 Chromium 按域重置，宿主负责重放 */
  setZoomFactor(factor: number): void;
  getZoomFactor(): number;
}

export function webviewApi(node: HTMLElement | null): WebviewElement | null {
  return node as WebviewElement | null;
}

/** 惰性取 guest WebContents id：guest 未 attach 时 getWebContentsId 抛错、
 *  未就绪时返回非有限值，统一收敛 null（调用方给「页面未就绪」提示）。
 *  设备模拟/截图（经主进程反查 guest）两处共用 */
export function readWebContentsId(node: HTMLElement | null): number | null {
  try {
    const id = (node as WebviewElement | null)?.getWebContentsId();
    return typeof id === "number" && Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}

/** 应用缩放：guest 未 attach/已销毁时 setZoomFactor 抛错，静默跳过
 *  （BrowserWebview 在 zoomFactor 变化与 dom-ready 两处重放兜底） */
export function applyZoomFactor(
  node: HTMLElement | null,
  factor: number,
): void {
  try {
    (node as WebviewElement | null)?.setZoomFactor(factor);
  } catch {
    // guest 未就绪：等 dom-ready 重放
  }
}

/** 加载失败分类：-3 ERR_ABORTED（切换预览中止）不算失败；-20 为主进程门拦截 */
export function classifyLoadError(
  errorCode: number,
): "ignored" | "blocked" | "failed" {
  if (errorCode === -3) return "ignored";
  if (errorCode === -20) return "blocked";
  return "failed";
}
