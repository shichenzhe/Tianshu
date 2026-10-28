/**
 * user 消息引用文件卡片（引用前缀段拆出渲染，替代气泡内生硬的路径行
 * 文本）：类型图标 + 文件名 + 相对路径；点击弹层内嵌产物面板同款
 * FilePreview 应用内预览（md/文本代码/图片/html-pdf-音视频 webview 全
 * 分类，工具栏可再转独立文件窗——对齐 WorkBuddy 引用文件 office 窗
 * 语义）。远程会话（workspaceId 为 null——空间概念不跨主机）纯展示
 * 不可点。卡片尾随导出按钮（聊天导出批）：内容 Blob 纯渲染层下载
 * （文本/图片按 readFile 返回分支；webview 类无内容通道不支持）。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Download } from "lucide-react";

import { dataUrlToBlob } from "@/lib/data-url";
import { downloadBlob } from "@/lib/file-download";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import ArtifactApi from "../../api/artifact.api";
import { mapIpcError } from "../lib/error-message";
import { fileIconFor } from "./artifacts/file-icon";
import FilePreview from "./artifacts/FilePreview";
import type { SessionFile } from "../lib/artifacts";
import { fileRefBasename } from "../lib/file-ref-lines";

interface MessageFileRefProps {
  /** 引用文件路径（工作空间相对/本地绝对路径等注入原值） */
  path: string;
  /** 所属工作空间 id；null（远程会话/未绑定）时纯展示不可点 */
  workspaceId?: number | null;
}

export default function MessageFileRef({
  path,
  workspaceId,
}: MessageFileRefProps) {
  const { t } = useTranslation(["chat"]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const Icon = fileIconFor(path);
  const clickable = workspaceId != null;

  // FilePreview 仅消费 path（其余 SessionFile 字段给展示合理值——引用
  // 文件非产物写入，不参与 writing 状态与源消息定位）
  const previewFile: SessionFile = {
    path,
    group: "workspace",
    status: "written",
    messageId: -1,
  };

  // 导出（纯渲染层）：读内容后 Blob+<a> 落下载目录（不经主进程写盘）；
  // webview 类（pdf/音视频）readFile 只回绝对路径，无内容可下——明示不支持
  const exportContent = async () => {
    try {
      const content = await ArtifactApi.readFile(workspaceId as number, path);
      if (content.kind === "image" && content.dataUrl) {
        downloadBlob(dataUrlToBlob(content.dataUrl), fileRefBasename(path));
      } else if (
        content.kind === "text" &&
        typeof content.content === "string"
      ) {
        downloadBlob(
          new Blob([content.content], { type: "text/plain;charset=utf-8" }),
          fileRefBasename(path),
        );
      } else {
        toast.error(t("chat:message.fileRefExportUnsupported"));
        return;
      }
      toast.success(t("chat:message.fileRefExported"));
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  return (
    <>
      <div className="flex w-full max-w-[360px] items-stretch gap-1">
        <button
          type="button"
          disabled={!clickable}
          onClick={() => clickable && setPreviewOpen(true)}
          aria-label={t("chat:message.fileRefOpen", {
            name: fileRefBasename(path),
          })}
          title={t("chat:message.fileRefOpen", { name: fileRefBasename(path) })}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-border/50 bg-secondary px-3 py-2 text-left shadow-sm transition-colors hover:border-primary/30 hover:bg-primary-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-default disabled:hover:border-border/50 disabled:hover:bg-secondary"
        >
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">
              {fileRefBasename(path)}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {path}
            </span>
          </span>
        </button>
        {clickable && (
          <button
            type="button"
            onClick={() => void exportContent()}
            aria-label={t("chat:message.fileRefExport")}
            title={t("chat:message.fileRefExport")}
            className="shrink-0 rounded-lg border border-border/50 bg-secondary px-2 text-muted-foreground shadow-sm transition-colors hover:border-primary/30 hover:bg-primary-subtle hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Download className="h-4 w-4" />
          </button>
        )}
      </div>
      {clickable && (
        <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
          <DialogContent className="flex h-[80vh] max-w-[85vw] flex-col border-border/50 p-0 sm:rounded-lg [&>button]:hidden">
            <DialogTitle className="sr-only">
              {t("chat:message.fileRefPreviewTitle", {
                name: fileRefBasename(path),
              })}
            </DialogTitle>
            {/* onBack 即工具栏返回箭头：弹层形态承载「关闭回聊天」 */}
            <FilePreview
              file={previewFile}
              workspaceId={workspaceId as number}
              onBack={() => setPreviewOpen(false)}
            />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
