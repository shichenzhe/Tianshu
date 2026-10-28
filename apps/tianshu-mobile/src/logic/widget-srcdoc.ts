/**
 * widget 沙箱文档构造（MR-T1）——桌面
 * src-react/domains/ai/chat/components/WidgetRenderer.tsx 的 buildWidgetSrcDoc
 * 双份移植（@tianshu/core 带 langChain peer 不宜引，同 file-refs 先例）。
 * 差异：高度上报优先 window.ReactNativeWebView.postMessage（RN WebView
 * onMessage 桥；window.postMessage 在 RN WebView 内不触发 onMessage），
 * 兜底 parent.postMessage（web 预览场景）。
 */

/** 高度 clamp（与桌面同值）：过小无意义，过大撑爆消息流 */
export const WIDGET_MIN_HEIGHT = 40;
export const WIDGET_MAX_HEIGHT = 800;
/** 加载态默认高度（上报到达前的初值） */
export const WIDGET_INITIAL_HEIGHT = 120;

export const RESIZE_BOOTSTRAP = `<script>
(function () {
  var last = 0;
  function send() {
    var h = document.documentElement.scrollHeight || document.body.scrollHeight;
    if (h !== last) {
      last = h;
      var msg = JSON.stringify({ source: "widget", type: "widget:resize", height: h });
      if (window.ReactNativeWebView) { window.ReactNativeWebView.postMessage(msg); }
      else { parent.postMessage(msg, "*"); }
    }
  }
  send();
  if (window.ResizeObserver) {
    new ResizeObserver(send).observe(document.documentElement);
  }
  if (window.MutationObserver) {
    new MutationObserver(send).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true,
    });
  }
  window.addEventListener("load", send);
})();
</script>`;

export function buildWidgetSrcDoc(code: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background-color: transparent; overflow: visible; }
body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
#root { width: 100%; }
</style>
</head>
<body>
<div id="root">${code}</div>
${RESIZE_BOOTSTRAP}
</body>
</html>`;
}

/** WebView onMessage 高度帧解析：合法 resize 帧 clamp 后返回高度，其余 null */
export function parseWidgetResize(data: string): number | null {
  try {
    const parsed = JSON.parse(data) as { type?: unknown; height?: unknown };
    if (parsed?.type === "widget:resize" && typeof parsed.height === "number") {
      return Math.min(
        Math.max(Math.round(parsed.height), WIDGET_MIN_HEIGHT),
        WIDGET_MAX_HEIGHT,
      );
    }
  } catch {
    // 非 JSON 上报忽略
  }
  return null;
}
