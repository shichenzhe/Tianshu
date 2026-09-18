/**
 * 资料库预览（spec 裁定 6 + §5）：md 复用会话 MarkdownView（text prop，
 * artifacts/FilePreview.tsx:104 同款先例）/ text-code <pre> / image <img> /
 * html-pdf-audio-video <webview file://>（独立 partition、禁弹窗、ref+
 * addEventListener 拦 will-navigate 外跳——renderer-guard 依赖 electron
 * 进不了渲染层，此为同语义内联实现）/ 其余或读失败降级 Finder。文本读取
 * 走 file:readExternalFile（512KB 上限沿用，超限降级 Finder）。dev 模式
 * 渲染器为 http 源、Chromium 阻止 file:// 子资源——图片经 readExternalFile
 * 取 dataUrl 内联（生产保持 file:// 直链，刻意不走 readExternalFile——
 * 其 512KB 上限对照片普遍超限属行为回退）。
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FolderSearch } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import MarkdownView from "@/domains/ai/chat/components/MarkdownView";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import { invoke } from "@/lib/ipc";
import type { LibraryItem } from "../api/library.api";
import { fileUrlOf, previewModeOf } from "../lib/library-view-model";
import LibraryApi from "../api/library.api";

interface LibraryPreviewDialogProps {
  item: LibraryItem | null;
  onClose: () => void;
}

export default function LibraryPreviewDialog({
  item,
  onClose,
}: LibraryPreviewDialogProps) {
  const { t } = useTranslation(["chat"]);
  const [text, setText] = useState<string | null>(null);
  // dev 图片预览 dataUrl（生产恒 null——<img> 直链 file://）
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const webviewRef = useRef<HTMLElement>(null);

  // 条目切换重置；文本类（md/text/code）读内容、dev 图片读 dataUrl
  // （readExternalFile 512KB 上限沿用，超限/读失败降级 Finder）；ignore
  // flag 防 stale-read（A→B 快切旧 promise 后到覆盖新条目状态）
  useEffect(() => {
    setText(null);
    setDataUrl(null);
    setLoadFailed(false);
    if (!item || item.kind !== "file") {
      return;
    }
    let stale = false;
    const mode = previewModeOf(item);
    if (mode === "inline-md" || mode === "inline-text") {
      invoke<{ kind: "text" | "image"; content?: string }>(
        "file:readExternalFile",
        item.storagePath ?? "",
      )
        .then((result) => {
          if (!stale) {
            setText(result.content ?? "");
          }
        })
        .catch(() => {
          if (!stale) {
            setLoadFailed(true);
          }
        });
    }
    if (mode === "inline-image" && import.meta.env.DEV) {
      invoke<{
        kind: "text" | "image";
        content?: string;
        dataUrl?: string;
      }>("file:readExternalFile", item.storagePath ?? "")
        .then((result) => {
          if (stale) {
            return;
          }
          if (!result.dataUrl) {
            setLoadFailed(true);
            return;
          }
          setDataUrl(result.dataUrl);
        })
        .catch(() => {
          if (!stale) {
            setLoadFailed(true);
          }
        });
    }
    return () => {
      stale = true;
    };
    // 仅按 item.id 重置重读（本仓 ESLint 未注册 react-hooks 规则，无法
    // eslint-disable exhaustive-deps，以注释说明；若启用需抑制该行）
  }, [item?.id]);

  // webview 外跳拦截：will-navigate 全拦（初始 src 加载不经此事件），
  // 加载失败降级。React 合成事件不支持 webview 非标准事件，原生监听
  useEffect(() => {
    const node = webviewRef.current;
    if (!node) {
      return;
    }
    const onWillNavigate = (event: Event) => event.preventDefault();
    // ERR_ABORTED（-3，多为切换条目时的中止加载）不误降级 Finder
    const onFail = (event: Event) => {
      if ((event as { errorCode?: number }).errorCode !== -3) {
        setLoadFailed(true);
      }
    };
    node.addEventListener("will-navigate", onWillNavigate);
    node.addEventListener("did-fail-load", onFail);
    return () => {
      node.removeEventListener("will-navigate", onWillNavigate);
      node.removeEventListener("did-fail-load", onFail);
    };
  }, [item?.id]);

  if (!item) {
    return null;
  }
  const mode = previewModeOf(item);
  const url = item.storagePath ? fileUrlOf(item.storagePath) : "";
  const textLoading =
    (mode === "inline-md" || mode === "inline-text") &&
    text === null &&
    !loadFailed;
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex h-[80vh] max-w-3xl flex-col border border-border/50 rounded-lg shadow-lg">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">{item.name}</DialogTitle>
        </DialogHeader>
        {mode === "finder" || loadFailed ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <p>
              {loadFailed
                ? t("chat:library.previewFailed")
                : t("chat:library.previewUnsupported")}
            </p>
            <Button
              variant="outline"
              className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              onClick={() =>
                void LibraryApi.revealItem(item.id).catch((e) =>
                  toast.error(mapIpcError(e)),
                )
              }
            >
              <FolderSearch className="mr-1 h-4 w-4" />
              {t("chat:library.openInFinder")}
            </Button>
          </div>
        ) : mode === "inline-md" ? (
          <div className="flex-1 overflow-y-auto rounded-md border border-border/50 p-4 text-sm">
            {textLoading ? "…" : <MarkdownView text={text ?? ""} />}
          </div>
        ) : mode === "inline-text" ? (
          <pre className="flex-1 overflow-auto rounded-md border border-border/50 p-4 text-xs leading-relaxed">
            {textLoading ? "…" : text}
          </pre>
        ) : mode === "inline-image" ? (
          <div className="flex flex-1 items-center justify-center overflow-auto">
            {/* dev：dataUrl 读取中显示占位（此时直链 file:// 会因跨源被拒，
                不能提前挂 src 触发 onError 误降级）；生产直链 file:// */}
            {import.meta.env.DEV && dataUrl === null ? (
              "…"
            ) : (
              <img
                src={import.meta.env.DEV ? (dataUrl ?? "") : url}
                alt={item.name}
                onError={() => setLoadFailed(true)}
                className="max-h-full max-w-full object-contain"
              />
            )}
          </div>
        ) : (
          // allowpopups 刻意不写：Electron 按 DOM 属性「存在性」取值
          // （hasAttribute），写 "false" 反而会放行弹窗；不写即默认拒绝
          <webview
            ref={webviewRef}
            src={url}
            partition="library-preview"
            className="flex-1 rounded-md border border-border/50"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
