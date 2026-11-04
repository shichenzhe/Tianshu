/**
 * md 编辑载体（T24，spec §14 项 2）：CM6 编辑（FileWindowEditor/markdown）
 * + 右侧分栏预览（MarkdownView）——LibraryMarkdownEditor 分栏语义移植：
 * Eye 开关（默认开，关=编辑独占全宽）、编辑侧滚动单向比例同步预览侧
 * （双向互振）；md 工具栏二期不做（spec §14 项 2 裁定）。
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff } from "lucide-react";

import { cn } from "@/lib/utils";
import MarkdownView from "@/domains/ai/chat/components/MarkdownView";
import FileWindowEditor from "./FileWindowEditor";

const TOOL_BTN =
  "rounded p-1.5 text-muted-foreground hover:bg-primary-subtle hover:text-primary disabled:opacity-50";

interface FileWindowMdEditorProps {
  value: string;
  onChange: (next: string) => void;
  /** 内容读取中（编辑器禁输入，防半值编辑） */
  loading?: boolean;
}

export default function FileWindowMdEditor({
  value,
  onChange,
  loading = false,
}: FileWindowMdEditorProps) {
  const { t } = useTranslation(["chat"]);
  // 预览栏开关（关=纯编辑独占全宽）
  const [showPreview, setShowPreview] = useState(true);
  const editorWrapRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  // 编辑侧 .cm-scroller 滚动单向比例同步预览（预览侧滚动不回写，避免互振）；
  // scroller 由 CM6 挂载时同步渲染（子 effect 先于本 effect，querySelector 可得）
  useEffect(() => {
    const scroller = editorWrapRef.current?.querySelector(".cm-scroller");
    if (!(scroller instanceof HTMLElement)) return;
    const onScroll = () => {
      const preview = previewRef.current;
      if (!preview) return;
      const editorMax = scroller.scrollHeight - scroller.clientHeight;
      const previewMax = preview.scrollHeight - preview.clientHeight;
      if (editorMax > 0 && previewMax > 0) {
        preview.scrollTop = (scroller.scrollTop / editorMax) * previewMax;
      }
    };
    scroller.addEventListener("scroll", onScroll);
    return () => scroller.removeEventListener("scroll", onScroll);
  }, []);

  const eyeLabel = showPreview
    ? t("chat:library.mdHidePreview")
    : t("chat:library.mdShowPreview");

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* 预览开关行（工具栏二期不做，仅 Eye）：右贴对齐编辑/预览分栏 */}
      <div className="flex shrink-0 items-center justify-end rounded-md border border-border/50 bg-muted/30 p-1">
        <button
          type="button"
          aria-label={eyeLabel}
          disabled={loading}
          onClick={() => setShowPreview((v) => !v)}
          className={cn(TOOL_BTN, showPreview && "text-primary")}
        >
          {showPreview ? (
            <Eye className="h-4 w-4" />
          ) : (
            <EyeOff className="h-4 w-4" />
          )}
        </button>
      </div>
      {/* 左编辑右预览（预览关闭时编辑区独占全宽） */}
      <div className="flex min-h-0 flex-1 gap-2">
        <div
          ref={editorWrapRef}
          className="min-h-0 flex-1 overflow-hidden rounded-md border border-border/50"
        >
          <FileWindowEditor
            value={value}
            onChange={onChange}
            language="markdown"
            readOnly={loading}
            ariaLabel={t("chat:library.editContent")}
          />
        </div>
        {showPreview && (
          <div
            ref={previewRef}
            className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border/50 p-4 text-sm"
          >
            <MarkdownView text={value} />
          </div>
        )}
      </div>
    </div>
  );
}
