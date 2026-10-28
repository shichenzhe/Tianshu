/**
 * 聊天面板可视化组件渲染（WorkBuddy widget-renderer/widget-sandbox 移植，
 * MVP）：模型经 show_widget 工具输出 HTML/JS 代码，本组件在消息流内以
 * 隔离 iframe 沙箱呈现——sandbox="allow-scripts"（无 allow-same-origin，
 * srcDoc 唯一源隔离）+ CSP（default-src 'none'，脚本样式仅内联，无网络
 * 访问）；高度经 iframe 内上报（widget:resize postMessage，ResizeObserver
 * + MutationObserver 双观察）自适应，宿主 clamp 40-800px。工具 running
 * 中渲染加载占位（args 渐进防反复重载），done 后一次性注入。
 * 标题栏截图操作（聊天导出批）：iframe getBoundingClientRect（DIP +
 * 窗口滚动偏移）→ widget:capture（event.sender.capturePage）→ 复制/
 * 另存。协议限制：iframe 内部滚动仅截可视区（截屏为窗口位图，滚出
 * 视口部分不可达）。
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { BarChart3, Copy, Download, Loader2 } from "lucide-react";

import { copyImageToClipboard } from "@/lib/data-url";
import ChatApi from "../../api/chat.api";
import { mapIpcError } from "../lib/error-message";

/** 高度 clamp：过小无意义，过大撑爆消息流（滚动收归宿主） */
const WIDGET_MIN_HEIGHT = 40;
const WIDGET_MAX_HEIGHT = 800;
/** 加载态默认高度（上报到达前的初值） */
const WIDGET_INITIAL_HEIGHT = 120;

/** iframe 内高度上报脚本：双观察器 + load 兜底，变更即 postMessage */
const RESIZE_BOOTSTRAP = `<script>
(function () {
  var last = 0;
  function send() {
    var h = document.documentElement.scrollHeight || document.body.scrollHeight;
    if (h !== last) {
      last = h;
      parent.postMessage({ source: "widget", type: "widget:resize", height: h }, "*");
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

/**
 * 沙箱文档构造（纯函数可测）：CSP + 重置样式（透明背景融入聊天流，
 * WorkBuddy 同款）+ 代码本体 + 高度上报脚本
 */
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

interface WidgetRendererProps {
  title?: string;
  code: string;
  /** 工具执行态：running 加载占位，done（及其它终态）注入沙箱 */
  state: string;
}

function WidgetRendererImpl({ title, code, state }: WidgetRendererProps) {
  const { t } = useTranslation(["chat"]);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(WIDGET_INITIAL_HEIGHT);
  const ready = state !== "running" && state !== "awaiting-approval";

  // 高度上报监听：仅信任本 iframe 源（e.source 比对，防跨 widget 串扰）
  const onMessage = useCallback((event: MessageEvent) => {
    if (event.source !== frameRef.current?.contentWindow) {
      return;
    }
    const data = event.data as { type?: string; height?: number };
    if (data?.type === "widget:resize" && typeof data.height === "number") {
      setHeight(
        Math.min(
          Math.max(Math.round(data.height), WIDGET_MIN_HEIGHT),
          WIDGET_MAX_HEIGHT,
        ),
      );
    }
  }, []);
  useEffect(() => {
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onMessage]);

  // 图表区截图：rect 取 iframe 视口位置 + 窗口滚动偏移（capturePage 为
  // 页面坐标 DIP）；协议限制——iframe 内部滚动仅截可视区（见头注释）
  const captureFrame = async (): Promise<string | null> => {
    const frame = frameRef.current;
    if (!frame) {
      return null;
    }
    const rect = frame.getBoundingClientRect();
    return ChatApi.captureWidget({
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      width: rect.width,
      height: rect.height,
    });
  };

  const copySnapshot = async () => {
    try {
      const dataUrl = await captureFrame();
      if (!dataUrl) {
        return;
      }
      await copyImageToClipboard(dataUrl);
      toast.success(t("chat:codeBlock.imageCopied"));
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const saveSnapshot = async () => {
    try {
      const dataUrl = await captureFrame();
      if (!dataUrl) {
        return;
      }
      const saved = await ChatApi.saveImageFile(
        dataUrl,
        title ?? t("chat:widget.defaultTitle"),
      );
      if (saved) {
        toast.success(t("chat:artifacts.exportSuccess"));
      }
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const actionBtn =
    "rounded p-1 text-muted-foreground transition-colors hover:bg-primary-subtle hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

  return (
    <div
      data-testid="widget-card"
      className="my-2 overflow-hidden rounded-lg border border-border/50"
    >
      {/* 标题栏：图表图标 + 标题（无标题显示通用文案）+ 截图操作（done 后） */}
      <div className="flex items-center gap-1.5 border-b border-border/50 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
        <BarChart3 className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {title ?? t("chat:widget.defaultTitle")}
        </span>
        {ready && (
          <div className="flex shrink-0 items-center">
            <button
              type="button"
              onClick={() => void copySnapshot()}
              aria-label={t("chat:widget.copySnapshot")}
              title={t("chat:widget.copySnapshot")}
              className={actionBtn}
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void saveSnapshot()}
              aria-label={t("chat:widget.downloadSnapshot")}
              title={t("chat:widget.downloadSnapshot")}
              className={actionBtn}
            >
              <Download className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
      {ready ? (
        <iframe
          ref={frameRef}
          title={title ?? t("chat:widget.defaultTitle")}
          sandbox="allow-scripts"
          srcDoc={buildWidgetSrcDoc(code)}
          style={{ height: `${height}px` }}
          className="block w-full border-0 bg-transparent"
        />
      ) : (
        <div
          data-testid="widget-loading"
          className="flex items-center gap-2 px-3 py-6 text-xs text-muted-foreground"
          style={{ height: `${WIDGET_INITIAL_HEIGHT}px` }}
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("chat:widget.loading")}
        </div>
      )}
    </div>
  );
}

export default memo(WidgetRendererImpl);
