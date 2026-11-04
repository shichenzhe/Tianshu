/**
 * 产物面板预览（按类型，对齐资料库预览口径）：返回/文件名工具栏 +
 * 内容区路由——md 走 MarkdownView / 纯文本与代码 <pre> / 图片
 * dataUrl 直渲 / html-pdf-音视频 <webview file://>（独立 partition、禁
 * 弹窗、will-navigate 外跳拦截——chat/lib use-webview-guard 共享守卫，
 * T28 收敛，同 LibraryPreviewContent）。
 * webview 类后端仅 stat 校验并回绝对路径（不读内容，不受 512KB 上限）。
 * 读取失败/不支持显示空态 + 「在 Finder 中显示」兜底并 toast 原因。
 * onBack 可选：省略即不渲染返回按钮（tab 形态——FilePanelTab——无
 * 「返回列表」语义；资料库/列表形态传入保留返回）。纯内嵌组件，占满
 * 调用方内容区（全窗放大由 DetailPanel 最大化承载，本组件不再自带）。
 * 工具行尾部「在新窗口打开」：invoke fileWindow:open 开独立文件窗，
 * 成功后回调 onOpenInNewWindow——tab 形态传入以关主窗 tab（移动语义）；
 * 列表形态不传即只开新窗不关。
 * 工具行「下载」（聊天导出批）：文本类内容 Blob 纯渲染层落下载目录；
 * 图片走 file:saveDataUrl 原生保存对话框；webview 类无内容通道不展示。
 */
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  Download,
  FileX,
  FolderSearch,
  SquareArrowOutUpRight,
} from "lucide-react";
import { downloadBlob } from "@/lib/file-download";
import IconTooltip from "@/components/common/icon-tooltip";

import ArtifactApi from "../../../api/artifact.api";
import ChatApi from "../../../api/chat.api";
import type { SessionFile } from "../../lib/artifacts";
import { previewModeOfPath } from "../../lib/file-preview-mode";
import { mapIpcError } from "../../lib/error-message";
import { useWebviewGuard } from "../../lib/use-webview-guard";
import { fileUrlOf } from "@/lib/file-url";
import { invoke } from "@/lib/ipc";
import MarkdownView from "../MarkdownView";

interface FilePreviewProps {
  file: SessionFile;
  workspaceId: number;
  /** 返回列表回调：省略即不渲染返回按钮（tab 形态无返回语义） */
  onBack?: () => void;
  /** 在新窗口打开成功后回调（tab 形态传 → 关主窗 tab，移动语义） */
  onOpenInNewWindow?: () => void;
}

function FilePreview({
  file,
  workspaceId,
  onBack,
  onOpenInNewWindow,
}: FilePreviewProps) {
  const { t } = useTranslation(["chat"]);
  const queryClient = useQueryClient();
  const mode = previewModeOfPath(file.path);
  const fileQuery = useQuery({
    queryKey: ["artifact-file", workspaceId, file.path],
    queryFn: () => ArtifactApi.readFile(workspaceId, file.path),
    retry: false,
    staleTime: 5_000,
  });
  // 外部写盘广播（含独立文件窗保存/AI 工具写盘，spec §6.4）：同文件失效
  // 本地缓存重取。全挂载下多个 FilePreview 实例（多 tab）各自订阅各自
  // 过滤——同路径多次 invalidate 由 React Query 去重，无害；卸载退订
  useEffect(() => {
    const off = window.ipcRenderer?.on(
      "workspace:fileChanged",
      (_e, raw: unknown) => {
        const payload = raw as { workspaceId: number; path: string };
        if (payload.workspaceId !== workspaceId || payload.path !== file.path)
          return;
        void queryClient.invalidateQueries({
          queryKey: ["artifact-file", workspaceId, file.path],
        });
      },
    );
    return () => off?.();
  }, [file.path, queryClient, workspaceId]);
  // webview 外跳拦截/失败降级守卫（T28 收敛共享 hook，语义见其头注释）
  const webviewSrc =
    mode === "webview" &&
    fileQuery.data?.kind === "webview" &&
    fileQuery.data.absPath
      ? fileUrlOf(fileQuery.data.absPath)
      : null;
  const { ref: webviewRef, failed: webviewFailed } =
    useWebviewGuard(webviewSrc);

  // 错误只 toast 一次（空态由渲染分支兜底，文案不依赖错误分类）
  useEffect(() => {
    if (fileQuery.error) {
      toast.error(mapIpcError(fileQuery.error));
    }
  }, [fileQuery.error]);

  const failed =
    (mode === "webview" && webviewFailed) ||
    (!fileQuery.isPending && !fileQuery.data);

  const reveal = () =>
    void ArtifactApi.revealFile(workspaceId, file.path).catch((e) =>
      toast.error(mapIpcError(e)),
    );

  // 开独立文件窗预览该文件；成功才回调（失败 toast，不关主窗 tab）
  const openInNewWindow = async () => {
    try {
      await invoke("fileWindow:open", {
        resources: [{ kind: "workspace", workspaceId, path: file.path }],
      });
      onOpenInNewWindow?.();
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  // 下载按内容形态分支（聊天导出批）：图片 → 原生另存对话框；文本 →
  // Blob+<a> 即落下载目录；webview 类（fileQuery 只回 absPath）无内容不下
  const downloadable =
    fileQuery.data?.kind === "image" ||
    (fileQuery.data?.kind === "text" &&
      typeof fileQuery.data.content === "string");
  const basename = file.path.split("/").pop() || "file";
  const downloadFile = async () => {
    const data = fileQuery.data;
    if (!data) {
      return;
    }
    try {
      if (data.kind === "image" && data.dataUrl) {
        const saved = await ChatApi.saveImageFile(data.dataUrl, basename);
        if (saved) {
          toast.success(t("chat:artifacts.exportSuccess"));
        }
      } else if (data.kind === "text") {
        downloadBlob(
          new Blob([data.content ?? ""], {
            type: "text/plain;charset=utf-8",
          }),
          basename,
        );
      }
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border/50 px-2 py-1.5">
        {onBack && (
          <IconTooltip label={t("chat:artifacts.back")}>
            <button
              type="button"
              aria-label={t("chat:artifacts.back")}
              onClick={onBack}
              className="rounded p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          </IconTooltip>
        )}
        <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium">
          {file.path}
        </span>
        {downloadable && (
          <IconTooltip label={t("chat:artifacts.actionDownload")}>
            <button
              type="button"
              aria-label={t("chat:artifacts.actionDownload")}
              onClick={() => void downloadFile()}
              className="rounded p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
            >
              <Download className="h-4 w-4" />
            </button>
          </IconTooltip>
        )}
        <IconTooltip label={t("chat:fileWindow.openInNewWindow")}>
          <button
            type="button"
            aria-label={t("chat:fileWindow.openInNewWindow")}
            onClick={() => void openInNewWindow()}
            className="ml-auto rounded p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
          >
            <SquareArrowOutUpRight className="h-4 w-4" />
          </button>
        </IconTooltip>
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
}

export default FilePreview;
