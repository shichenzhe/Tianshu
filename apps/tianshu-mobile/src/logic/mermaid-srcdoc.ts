/**
 * mermaid 沙箱文档构造（富内容批）——桌面 MermaidBlock 渲染语义的
 * WebView 移植：runtime 从 CDN 加载（mermaid@12 与桌面同版系；min.js
 * 5.2MB 本地资产化代价不成比例，留后续优化——网络不可达降级源码）。
 * 失败（网络/语法）postMessage mermaid:error，由组件降级代码块显源码
 * （对齐桌面失败语义）。高度上报复用 widget 桥。
 */
import {
  RESIZE_BOOTSTRAP,
  WIDGET_MAX_HEIGHT,
  WIDGET_MIN_HEIGHT,
} from "./widget-srcdoc";

const MERMAID_CDN =
  "https://cdn.jsdelivr.net/npm/mermaid@12/dist/mermaid.min.js";

export function buildMermaidSrcDoc(code: string, dark: boolean): string {
  const theme = dark ? "dark" : "default";
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;">
<style>
html, body { background-color: transparent; margin: 0; padding: 8px; }
svg { max-width: 100%; }
</style>
</head>
<body>
<div id="diagram"></div>
<script>
window.__mermaidFail = function () {
  if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(
      JSON.stringify({ type: "mermaid:error" })
    );
  }
};
window.onerror = function () { window.__mermaidFail(); return true; };
</script>
<script src="${MERMAID_CDN}" onerror="__mermaidFail()"></script>
<script>
var theme = ${JSON.stringify(theme)};
var code = ${JSON.stringify(code)};
if (window.mermaid) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: theme,
  });
  mermaid
    .render("mermaid-view", code)
    .then(function (r) {
      document.getElementById("diagram").innerHTML = r.svg;
    })
    .catch(window.__mermaidFail);
} else {
  window.__mermaidFail();
}
</script>
${RESIZE_BOOTSTRAP}
</body>
</html>`;
}

/** WebView onMessage 帧解析：resize 帧 clamp（与 widget 同值）；error 帧
 *  降级信号；其余 null */
export type MermaidFrame =
  { type: "resize"; height: number } | { type: "error" };

export function parseMermaidFrame(data: string): MermaidFrame | null {
  try {
    const parsed = JSON.parse(data) as { type?: unknown; height?: unknown };
    if (parsed?.type === "mermaid:error") {
      return { type: "error" };
    }
    if (parsed?.type === "widget:resize" && typeof parsed.height === "number") {
      return {
        type: "resize",
        height: Math.min(
          Math.max(Math.round(parsed.height), WIDGET_MIN_HEIGHT),
          WIDGET_MAX_HEIGHT,
        ),
      };
    }
  } catch {
    // 非 JSON 上报忽略
  }
  return null;
}
