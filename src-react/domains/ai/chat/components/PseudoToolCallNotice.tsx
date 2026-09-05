/**
 * 伪工具调用警示折叠条：检测函数命中时替代正文 Markdown 渲染，
 * 提示模型服务不支持工具调用，原文收进折叠区保真可见
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";

interface PseudoToolCallNoticeProps {
  /** 模型原始输出（碎片保真，不做 Markdown 渲染） */
  rawText: string;
}

export default function PseudoToolCallNotice({
  rawText,
}: PseudoToolCallNoticeProps) {
  const { t } = useTranslation(["chat"]);
  const [open, setOpen] = useState(false);

  return (
    <div className="my-1 rounded-md border border-border/50 border-l-2 border-l-orange-400/80 bg-muted/30">
      <button
        type="button"
        className="flex w-full cursor-pointer select-none items-center gap-2 px-3 py-1.5 text-left"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-orange-500" />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {t("chat:pseudoToolCall.notice")}
        </span>
        {open ? (
          <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </button>
      {open && (
        <pre className="max-h-[400px] overflow-y-auto whitespace-pre-wrap break-words border-t border-border/40 px-3 py-2 font-mono text-xs leading-relaxed text-muted-foreground">
          {rawText}
        </pre>
      )}
    </div>
  );
}
