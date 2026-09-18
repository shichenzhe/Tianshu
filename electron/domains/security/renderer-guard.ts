/**
 * 渲染/Chromium 层防护（SP5 spec §6）：markdown img、SkillHub 图标走
 * session.webRequest 判定；window.open 链接恒拒内开窗、放行域转系统浏览器；
 * 主窗口导航仅 file:// 与 dev server。薄壳 + 纯函数（electron mock 可测）。
 */
import { session, shell } from "electron";
import { getNetworkGate } from "./network-gate";

/** 窗口开放判定："external"=经系统浏览器外开（放行域/门旁路），"deny"=拒绝 */
export function handleWindowOpen(url: string): "deny" | "external" {
  const gate = getNetworkGate();
  const verdict = gate ? gate.judgeUrl(url) : { ok: true as const };
  if (!verdict.ok) {
    gate?.blockedAudit(verdict.host, verdict.rule, "renderer");
    return "deny";
  }
  void shell.openExternal(url).catch(() => {}); // 外开失败静默（不回退内开窗）
  return "external";
}

/** 主窗口导航白名单：file:// 与 dev server（http(s) 远程导航一律拒） */
export function shouldAllowNavigation(
  url: string,
  devServerOrigin: string | undefined,
): boolean {
  if (url.startsWith("file://")) return true;
  if (devServerOrigin === undefined) return false;
  try {
    // origin 精确比较（fix round 1）：两侧同经 URL 归一，消除 devServerOrigin
    // 尾斜杠隐式不变量；前缀同形域（…5173.evil.com）与 userinfo 伪装
    // （http://5173@evil.com）的 origin 不等即拒
    return new URL(url).origin === new URL(devServerOrigin).origin;
  } catch {
    return false; // 非法 URL fail-closed（导航白名单拒绝比放行安全）
  }
}

/** session 级判定（Application 装配一次）：仅 http(s) 过门，拒则 cancel */
export function installSessionGuard(): void {
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*"] },
    (details, callback) => {
      const gate = getNetworkGate();
      const verdict = gate ? gate.judgeUrl(details.url) : { ok: true as const };
      if (!verdict.ok) {
        gate?.blockedAudit(verdict.host, verdict.rule, "renderer");
        callback({ cancel: true });
        return;
      }
      callback({});
    },
  );
}

/** 资料库预览 webview 独立 partition（library-preview）的网络门：本地
 *  file:// 预览对 http(s) 子资源/外链直接全拒（spec「外链直接拒」语义，
 *  不走白名单门）；fromPartition 立即创建 session，放启动装配一次即可 */
export function installLibraryPreviewSessionGuard(): void {
  session
    .fromPartition("library-preview")
    .webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] },
      (_details, callback) => callback({ cancel: true }),
    );
}
