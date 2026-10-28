/**
 * 内置浏览器 session 守卫（spec §2）：persist:browser-webview partition 的
 * 请求门（NetworkGate blocklist + SSRF 封锁）与响应头剥离（X-Frame-Options
 * / CSP frame-ancestors——不剥则 GitHub 等设 XFO 的站点无法嵌入 webview）。
 * 纯函数 + 薄壳注册（electron mock 可测，照 renderer-guard.ts 先例）。
 */

import { app, session } from "electron";
import type { Session } from "electron";
import { handleUser } from "../../../commons/ipc-user";
import { getNetworkGate } from "../../security/network-gate";
import { isSsrfHost } from "../../security/ssrf-hosts";

/** 浏览器 webview 专用持久 partition（登录态跨重启，spec §3.3） */
export const BROWSER_WEBVIEW_PARTITION = "persist:browser-webview";

/** SSRF 封锁清单收敛在 security/ssrf-hosts（与 web_fetch 共用防漂移）；保留 re-export 兼容既有 import */
export { isSsrfHost };

/** mainFrame/subFrame 剥 XFO 与 CSP frame-ancestors；其余资源原样放行 */
export function sanitizeEmbedHeaders(
  resourceType: string,
  responseHeaders: Record<string, string[]>,
): Record<string, string[]> {
  if (resourceType !== "mainFrame" && resourceType !== "subFrame") {
    return responseHeaders;
  }
  const cleaned: Record<string, string[]> = {};
  for (const key of Object.keys(responseHeaders)) {
    const lower = key.toLowerCase();
    if (lower === "x-frame-options") continue;
    if (
      lower === "content-security-policy" ||
      lower === "content-security-policy-report-only"
    ) {
      const values = responseHeaders[key];
      if (!values || values.length === 0) continue;
      const stripped = values
        .map((v) =>
          v
            .split(";")
            .map((part) => part.trim())
            .filter((part) => !/^frame-ancestors\b/i.test(part))
            .join("; "),
        )
        .filter((v) => v.length > 0);
      if (stripped.length > 0) cleaned[key] = stripped;
      continue;
    }
    cleaned[key] = responseHeaders[key];
  }
  return cleaned;
}

/** 清数据类型归一（fail-fast：非法类型抛错而非静默猜默认） */
export function readClearDataType(value: unknown): "cookies" | "cache" {
  if (value !== "cookies" && value !== "cache") {
    throw new Error(
      `browser data type must be 'cookies' or 'cache', got: ${String(value)}`,
    );
  }
  return value;
}

/** clearStorageData 可清的站点存储类型（从 Electron Session 签名推导，
 *  随 Electron 版本演进保持与 typings 一致） */
type BrowserStorages = NonNullable<
  NonNullable<Parameters<Session["clearStorageData"]>[0]>["storages"]
>;

/** cache 类型清除的站点存储（cookies 归 cookies 类型单独清；websql 已随
 *  WebSQL 从 Chromium/Electron 移除，storages 联合类型不再收录） */
export const CACHE_CLEAR_STORAGES: BrowserStorages = [
  "localstorage",
  "indexdb",
  "serviceworkers",
  "cachestorage",
  "shadercache",
  "filesystem",
];

/** 装配 browser partition 两道门（Application 启动调一次） */
export function installBrowserSessionGuard(): void {
  const target = session.fromPartition(BROWSER_WEBVIEW_PARTITION);
  target.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*"] },
    (details, callback) => {
      try {
        if (isSsrfHost(new URL(details.url).hostname)) {
          callback({ cancel: true });
          return;
        }
      } catch {
        // 非法 URL 不在此拦，交给加载失败路径
      }
      const gate = getNetworkGate();
      const verdict = gate ? gate.judgeUrl(details.url) : { ok: true as const };
      if (!verdict.ok) {
        gate?.blockedAudit(verdict.host, verdict.rule, "browser");
        callback({ cancel: true });
        return;
      }
      callback({});
    },
  );
  target.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: sanitizeEmbedHeaders(
        details.resourceType,
        details.responseHeaders ?? {},
      ),
    });
  });
}

/** 站内开窗转发事件（主→渲染）：guest 的 target=_blank/window.open 转新 tab */
export const BROWSER_OPEN_IN_NEW_TAB_EVENT = "browser:openInNewTab";

/** 目标 session 是否为 browser partition（fromPartition 同实例可 ===；
 *  guest-registry-ipc 捕获 guest 复用同一判定口径） */
export function isBrowserGuestSession(guestSession: Session): boolean {
  return guestSession === session.fromPartition(BROWSER_WEBVIEW_PARTITION);
}

/**
 * guest 弹窗拦截：browser partition 的 webview 内开窗请求（target=_blank /
 * window.open）一律 deny，http(s) url 转发宿主以新 tab 打开（浏览器产品
 * 行为；资料库/产物预览等非 browser partition 的 webview 不受影响）。
 * app 级事件，Application 装配一次。
 */
export function registerBrowserGuestPopupForwarding(): void {
  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "webview") return;
    if (!isBrowserGuestSession(contents.session)) return;
    contents.setWindowOpenHandler(({ url }) => {
      try {
        const { protocol } = new URL(url);
        if (protocol === "http:" || protocol === "https:") {
          contents.hostWebContents?.send(BROWSER_OPEN_IN_NEW_TAB_EVENT, url);
        }
      } catch {
        // 非法 url 静默丢弃（fail-closed，不开窗不转发）
      }
      return { action: "deny" };
    });
  });
}

/** browser:clearData（handleUser：剥 token，userId 无业务语义仅过鉴权） */
export function registerBrowserIpc(): void {
  handleUser("browser:clearData", async (_event, _userId, type: unknown) => {
    const dataType = readClearDataType(type);
    const target = session.fromPartition(BROWSER_WEBVIEW_PARTITION);
    if (dataType === "cookies") {
      await target.clearStorageData({ storages: ["cookies"] });
      return;
    }
    await target.clearStorageData({ storages: CACHE_CLEAR_STORAGES });
    await target.clearCache();
  });
}
