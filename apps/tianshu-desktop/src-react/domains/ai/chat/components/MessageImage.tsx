/**
 * 用户消息图片附件 chip（多模态输入回看，2026-10-24 参照形态改版）：不在
 * 消息流内展开大缩略图——文件名小标签内联在气泡文本前，仅点击才进
 * lightbox 全屏查看。dataUrl 经 IPC 读盘（queryKey 以 imagePath 为键全 UI
 * 复用），查询 enabled=zoomed 点开才拉（chip 渲染零等待零 IO）；读不到
 * （源文件被删/超限）lightbox 内降级「图片已失效」提示。
 * lightbox 悬浮操作条（聊天导出批）：复制（W3C 剪贴板）与另存为
 * （file:saveDataUrl 原生保存对话框）；失败 toast 错误分类文案。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, Download, ImageIcon, Loader2 } from "lucide-react";

import { copyImageToClipboard } from "@/lib/data-url";
import { invoke } from "@/lib/ipc";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import ChatApi from "../../api/chat.api";
import { mapIpcError } from "../lib/error-message";

export function MessageImage({
  imagePath,
  name,
}: {
  imagePath: string;
  name?: string;
}) {
  const { t } = useTranslation(["chat"]);
  const [zoomed, setZoomed] = useState(false);
  const { data, isPending } = useQuery({
    queryKey: ["message-image", imagePath],
    queryFn: () => invoke<string | null>("file:readMessageImage", imagePath),
    staleTime: Infinity,
    retry: false,
    enabled: zoomed,
  });
  const label = name ?? imagePath;

  // 图片操作（聊天导出批）：data 已就绪才可操作；stopPropagation 防
  // 透传到 DialogContent 的点击关闭层
  const copyImage = async () => {
    if (!data) {
      return;
    }
    try {
      await copyImageToClipboard(data);
      toast.success(t("chat:codeBlock.imageCopied"));
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const saveImageAs = async () => {
    if (!data) {
      return;
    }
    try {
      const saved = await ChatApi.saveImageFile(data, label);
      if (saved) {
        toast.success(t("chat:artifacts.exportSuccess"));
      }
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setZoomed(true)}
        title={t("chat:message.imageZoom", { name: label })}
        className="inline-flex h-6 max-w-[200px] shrink-0 items-center gap-1 rounded-md border border-border/50 bg-secondary px-1.5 align-middle text-xs text-muted-foreground transition-colors hover:border-primary/30 hover:bg-primary-subtle hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <ImageIcon className="h-3 w-3 shrink-0" />
        <span className="truncate">{label}</span>
      </button>
      <Dialog open={zoomed} onOpenChange={setZoomed}>
        <DialogContent
          className="max-w-[90vw] border-0 bg-transparent p-0 shadow-none sm:rounded-lg [&>button]:hidden"
          onClick={() => setZoomed(false)}
        >
          <DialogTitle className="sr-only">
            {t("chat:message.imageZoomTitle", { name: label })}
          </DialogTitle>
          {isPending ? (
            <div
              data-testid="message-image-loading"
              className="flex h-40 items-center justify-center"
            >
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : !data ? (
            <div
              data-testid="message-image-expired"
              className="flex items-center gap-1.5 rounded-lg bg-secondary px-2.5 py-1.5 text-xs text-muted-foreground"
            >
              <ImageIcon className="h-3.5 w-3.5" />
              {t("chat:message.imageExpired", { name: label })}
            </div>
          ) : (
            <>
              {/* 悬浮操作条：复制 / 另存为（stopPropagation 防点关 lightbox） */}
              <div
                data-testid="message-image-actions"
                className="mb-2 flex items-center justify-center gap-2"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  onClick={() => void copyImage()}
                  className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-secondary/80 px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/30 hover:bg-primary-subtle hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <Copy className="h-3.5 w-3.5" />
                  {t("chat:message.imageCopy")}
                </button>
                <button
                  type="button"
                  onClick={() => void saveImageAs()}
                  className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-secondary/80 px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/30 hover:bg-primary-subtle hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <Download className="h-3.5 w-3.5" />
                  {t("chat:message.imageSaveAs")}
                </button>
              </div>
              {/* 点击图片自身也关闭（整层均可点关，Esc 由 Radix 处理）。
               容器 w-fit 随图片收缩 + justify-items-center：grid 对 img 这类
               replaced element 不施 stretch，不显式居中时小图会靠左 */}
              <img
                src={data}
                alt={label}
                className="max-h-[85vh] w-auto max-w-full justify-self-center object-contain"
              />
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
