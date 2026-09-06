/**
 * 产物面板预览：返回/文件名/全屏切换工具栏 + 内容区（文本走 MarkdownView，
 * 图片直渲）。fullscreen 受控于 ArtifactsPanel：非全屏嵌面板内容区；
 * 全屏时由 ArtifactsPanel 渲染在行容器层（absolute inset-0 覆盖聊天主
 * 区域）。读取失败显示通用空态并 toast 具体原因（spec §6：ENOENT/
 * 二进制统一此路径，toast 文案区分）
 */
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, FileX, Maximize2, Minimize2 } from "lucide-react";

import ArtifactApi from "../../../api/artifact.api";
import type { SessionFile } from "../../lib/artifacts";
import { mapIpcError } from "../../lib/error-message";
import MarkdownView from "../MarkdownView";

interface FilePreviewProps {
  file: SessionFile;
  workspaceId: number;
  onBack: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}

function FilePreview({
  file,
  workspaceId,
  onBack,
  fullscreen,
  onToggleFullscreen,
}: FilePreviewProps) {
  const { t } = useTranslation(["chat"]);

  const fileQuery = useQuery({
    queryKey: ["artifact-file", workspaceId, file.path],
    queryFn: () => ArtifactApi.readFile(workspaceId, file.path),
    retry: false,
    staleTime: 5_000,
  });

  // 错误只 toast 一次（空态由渲染分支兜底，文案不依赖错误分类）
  useEffect(() => {
    if (fileQuery.error) {
      toast.error(mapIpcError(fileQuery.error));
    }
  }, [fileQuery.error]);

  return (
    <div
      className={
        fullscreen
          ? "absolute inset-0 z-40 flex flex-col bg-background"
          : "flex h-full min-h-0 flex-col"
      }
    >
      <div className="flex items-center gap-1 border-b border-border/50 px-2 py-1.5">
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
        {fileQuery.isPending ? (
          <p className="text-xs text-muted-foreground">…</p>
        ) : fileQuery.data ? (
          fileQuery.data.kind === "image" ? (
            <img
              src={fileQuery.data.dataUrl}
              alt={file.path}
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <MarkdownView text={fileQuery.data.content ?? ""} />
          )
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <FileX className="h-8 w-8" />
            <p className="text-xs">{t("chat:artifacts.previewFailed")}</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default FilePreview;
