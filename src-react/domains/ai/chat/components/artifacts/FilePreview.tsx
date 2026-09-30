/**
 * 产物面板预览（按类型，对齐资料库预览口径）：返回/文件名/全屏切换
 * 工具栏 + 内容区路由——md 走 MarkdownView / 纯文本与代码 <pre> / 图片
 * dataUrl 直渲 / html-pdf-音视频 <webview file://>（独立 partition、禁
 * 弹窗、will-navigate 外跳拦截——同 LibraryPreviewContent 内联守卫语义）。
 * webview 类后端仅 stat 校验并回绝对路径（不读内容，不受 512KB 上限）。
 * 读取失败/不支持显示空态 + 「在 Finder 中显示」兜底并 toast 原因。
 * fullscreen 受控于 ArtifactsPanel：非全屏嵌面板内容区；全屏为真全屏
 *（Portal 到 body + fixed inset-0 覆盖整个视口含 TopBar，macOS 头部行
 * 让出红绿灯区域；h-11 与 TopBar 同高，内容行中心与红绿灯水平对齐）
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  FileX,
  FolderSearch,
  Maximize2,
  Minimize2,
} from "lucide-react";

import ArtifactApi from "../../../api/artifact.api";
import type { SessionFile } from "../../lib/artifacts";
import { previewModeOfPath } from "../../lib/file-preview-mode";
import { mapIpcError } from "../../lib/error-message";
import { fileUrlOf } from "@/lib/file-url";
import MarkdownView from "../MarkdownView";

interface FilePreviewProps {
  file: SessionFile;
  workspaceId: number;
  onBack: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}

/** Electron 无边框窗口拖拽区域样式（React CSSProperties 未内置该属性） */
type AppRegionStyle = CSSProperties & { WebkitAppRegion?: string };

function FilePreview({
  file,
  workspaceId,
  onBack,
  fullscreen,
  onToggleFullscreen,
}: FilePreviewProps) {
  const { t } = useTranslation(["chat"]);
  const isMac = window.platform === "darwin";
  const mode = previewModeOfPath(file.path);
  const fileQuery = useQuery({
    queryKey: ["artifact-file", workspaceId, file.path],
    queryFn: () => ArtifactApi.readFile(workspaceId, file.path),
    retry: false,
    staleTime: 5_000,
  });
  // webview 外跳拦截：will-navigate 全拦（初始 src 加载不经此事件），
  // 加载失败降级空态；React 合成事件不支持 webview 非标准事件，原生监听
  //（webview 条件渲染，src 就绪后重挂时重绑）
  const [webviewFailed, setWebviewFailed] = useState(false);
  const webviewRef = useRef<HTMLElement>(null);
  const webviewSrc =
    mode === "webview" &&
    fileQuery.data?.kind === "webview" &&
    fileQuery.data.absPath
      ? fileUrlOf(fileQuery.data.absPath)
      : null;
  useEffect(() => {
    setWebviewFailed(false);
    const node = webviewRef.current;
    if (!node) {
      return;
    }
    const onWillNavigate = (event: Event) => event.preventDefault();
    // ERR_ABORTED（-3，切换预览时中止加载）不误降级
    const onFail = (event: Event) => {
      if ((event as { errorCode?: number }).errorCode !== -3) {
        setWebviewFailed(true);
      }
    };
    node.addEventListener("will-navigate", onWillNavigate);
    node.addEventListener("did-fail-load", onFail);
    return () => {
      node.removeEventListener("will-navigate", onWillNavigate);
      node.removeEventListener("did-fail-load", onFail);
    };
  }, [webviewSrc]);

  // 错误只 toast 一次（空态由渲染分支兜底，文案不依赖错误分类）
  useEffect(() => {
    if (fileQuery.error) {
      toast.error(mapIpcError(fileQuery.error));
    }
  }, [fileQuery.error]);

  // Escape 退出全屏：与层级无关的逃生通道（全屏层万一被环境压住时
  // 按钮不可达，键盘恒可退出）；嵌面板形态无键盘语义不监听
  useEffect(() => {
    if (!fullscreen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onToggleFullscreen();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullscreen, onToggleFullscreen]);

  const failed =
    (mode === "webview" && webviewFailed) ||
    (!fileQuery.isPending && !fileQuery.data);

  const reveal = () =>
    void ArtifactApi.revealFile(workspaceId, file.path).catch((e) =>
      toast.error(mapIpcError(e)),
    );

  const content = (
    <div
      className={
        fullscreen
          ? // 真全屏：fixed 盖整个视口（含 TopBar；窗口控制按钮由
            // main.ts overlay 绘制在更高层，不受影响）
            "fixed inset-0 z-[60] flex flex-col bg-background"
          : "flex h-full min-h-0 flex-col"
      }
      // 全屏层显式 no-drag：Electron 的 -webkit-app-region: drag 命中
      // 不遵循 z-index 覆盖——TopBar 整条 drag 区横在窗口顶部 44px，
      // 头部行（含退出按钮）落在其中会被吞掉鼠标事件（zIndex 再高
      // 也无效，键盘 Esc 不受影响）；no-drag 区域可挖洞（TopBar 自身
      // 交互块同款先例）。zIndex 内联为层叠双保险
      style={
        fullscreen
          ? ({ zIndex: 60, WebkitAppRegion: "no-drag" } as AppRegionStyle)
          : undefined
      }
    >
      <div
        className={`flex items-center gap-1 border-b border-border/50 px-2 ${
          fullscreen ? "h-11 py-0" : "py-1.5"
        } ${fullscreen && isMac ? "pl-20" : ""}`}
      >
        <button
          type="button"
          aria-label={t("chat:artifacts.back")}
          title={t("chat:artifacts.back")}
          onClick={onBack}
          className="rounded p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium">
          {file.path}
        </span>
        <button
          type="button"
          aria-label={
            fullscreen
              ? t("chat:artifacts.exitFullscreen")
              : t("chat:artifacts.fullscreen")
          }
          title={
            fullscreen
              ? t("chat:artifacts.exitFullscreen")
              : t("chat:artifacts.fullscreen")
          }
          onClick={onToggleFullscreen}
          className="rounded p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
        >
          {fullscreen ? (
            <Minimize2 className="h-4 w-4" />
          ) : (
            <Maximize2 className="h-4 w-4" />
          )}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {failed ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
            <FileX className="h-8 w-8" />
            <p className="text-xs">{t("chat:artifacts.previewFailed")}</p>
            <button
              type="button"
              onClick={reveal}
              className="inline-flex items-center gap-1 rounded-md border border-border/50 px-2 py-1 text-xs hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
            >
              <FolderSearch className="h-3.5 w-3.5" />
              {t("chat:artifacts.actionReveal")}
            </button>
          </div>
        ) : fileQuery.isPending || !fileQuery.data ? (
          <p className="text-xs text-muted-foreground">…</p>
        ) : webviewSrc ? (
          // allowpopups 刻意不写：Electron 按 DOM 属性「存在性」取值，
          // 不写即默认拒绝弹窗（同 LibraryPreviewContent）
          <webview
            ref={webviewRef}
            src={webviewSrc}
            partition="artifact-preview"
            className="h-full min-h-0 w-full rounded-md border border-border/50"
          />
        ) : fileQuery.data.kind === "image" ? (
          <div className="flex h-full items-center justify-center">
            <img
              src={fileQuery.data.dataUrl}
              alt={file.path}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : mode === "md" ? (
          <MarkdownView text={fileQuery.data.content ?? ""} />
        ) : (
          // 纯文本/代码：原文 <pre>（md 之外不经 Markdown 渲染，代码不受
          // Markdown 缩进/特殊字符解析影响）
          <pre className="text-xs leading-relaxed">
            {fileQuery.data.content ?? ""}
          </pre>
        )}
      </div>
    </div>
  );

  // 全屏层 Portal 到 body：脱离 ChatView/main 的滚动与层叠环境（深嵌
  // 嵌套容器内的 fixed 覆盖层存在被祖先环境压住的怪癖，Portal 是
  // 覆盖层标准做法——fixed inset-0 恒相对视口、z-60 恒居层叠顶端）
  return fullscreen ? createPortal(content, document.body) : content;
}

export default FilePreview;
