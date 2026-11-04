/**
 * 渲染/Chromium 层防护（SP5 spec §6）：markdown img、SkillHub 图标走
 * session.webRequest 判定；window.open 链接恒拒内开窗、放行域转系统浏览器；
 * 主窗口导航仅 file:// 与 dev server。薄壳 + 纯函数（electron mock 可测）。
 */
import { session, shell } from "electron";
import { pathToFileURL } from "node:url";
import { getNetworkGate } from "./network-gate";

/** 窗口开放判定："external"=经系统浏览器外开（放行域/门旁路），"deny"=拒绝。
 *  协议白名单先行（安全审查 2026-11-02 S1）：仅 http(s) 可外开——非 http(s)
 *  （file:///smb://ms-*:/自定义 scheme）的 hostFromUrl 为空、域门恒放行，
 *  曾被直接交 shell.openExternal = 任意 scheme 交系统处理器（Windows 上
 *  file:// 按扩展名关联程序执行）。与 browser:openExternal/settings:
 *  openExternal 的既有 http(s) 校验对齐，fail-closed。 */
export function handleWindowOpen(url: string): "deny" | "external" {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "deny";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "deny";
  }
  const gate = getNetworkGate();
  const verdict = gate ? gate.judgeUrl(url) : { ok: true as const };
  if (!verdict.ok) {
    gate?.blockedAudit(verdict.host, verdict.rule, "renderer");
    return "deny";
  }
  void shell.openExternal(url).catch(() => {}); // 外开失败静默（不回退内开窗）
  return "external";
}

/** 主窗口导航白名单：渲染入口 index.html 精确匹配与 dev server
 *  （http(s) 远程导航一律拒）。安全审查 2026-11-02：曾 file:// 前缀全放行
 *  ——磁盘任意植入 HTML（write 工具产物/导出/备份恢复）可经导航拿到
 *  preload 注入的 IPC 白名单桥（含 terminal:write/workspace:readFile）；
 *  收窄到应用自身渲染入口。 */
export function shouldAllowNavigation(
  url: string,
  devServerOrigin: string | undefined,
  rendererIndex?: string,
): boolean {
  if (url.startsWith("file://")) {
    if (rendererIndex === undefined) {
      // 调用方未提供入口路径（测试替身/旧调用）：fail-closed 拒 file 导航
      return false;
    }
    try {
      // pathToFileURL 归一消 platform 差异（反斜杠/空格编码）
      return new URL(url).href === pathToFileURL(rendererIndex).href;
    } catch {
      return false;
    }
  }
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
