// src-react/domains/ai/orchestration/components/HighlightTextarea.tsx
/**
 * 高亮输入（textarea + overlay 双层）：textarea 文字透明、光标可见，
 * 背后 pre 按分段渲染着色文本——字体/行高/padding/换行（wrap=off 横向
 * 滚动）与 textarea 严格一致，滚动经 onScroll 同步。变量表达式 chip
 * 底色 + 代码关键字/字符串/注释着色（颜色全部走主题语义 token）。
 */
import { useMemo, useRef } from "react";

import {
  highlightSegments,
  type HighlightKind,
  type HighlightLanguage,
} from "../lib/prompt-highlight";

/** 着色走主题语义 token（明暗主题/四色主题切换均跟随） */
const KIND_CLASS: Record<HighlightKind, string> = {
  plain: "",
  variable: "rounded bg-primary-subtle text-primary",
  keyword: "text-primary",
  string: "text-muted-foreground",
  comment: "italic text-muted-foreground/60",
  number: "font-medium text-primary-active",
};

export interface HighlightTextareaProps {
  value: string;
  onChange: (next: string) => void;
  language: HighlightLanguage;
  placeholder?: string;
  /** 固定高度（px，内滚动）；fill 模式下由容器拉伸 */
  height?: number;
  /** 撑满父容器（放大弹窗内用） */
  fill?: boolean;
}

export default function HighlightTextarea({
  value,
  onChange,
  language,
  placeholder,
  height = 72,
  fill = false,
}: HighlightTextareaProps) {
  const overlayRef = useRef<HTMLPreElement>(null);
  const segments = useMemo(
    () => highlightSegments(value, language),
    [value, language],
  );

  function syncScroll(event: React.UIEvent<HTMLTextAreaElement>) {
    const overlay = overlayRef.current;
    if (overlay) {
      overlay.scrollTop = event.currentTarget.scrollTop;
      overlay.scrollLeft = event.currentTarget.scrollLeft;
    }
  }

  return (
    <div
      className={`relative overflow-hidden rounded-lg border border-border/50 bg-card focus-within:ring-1 focus-within:ring-primary/40 ${
        fill ? "h-full" : ""
      }`}
      style={fill ? undefined : { height }}
    >
      <pre
        ref={overlayRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre p-2 font-mono text-xs leading-5 text-foreground"
      >
        {segments.map((segment, index) => (
          <span key={index} className={KIND_CLASS[segment.kind]}>
            {segment.text}
          </span>
        ))}
        {/* 尾随换行占一行高度，与 textarea 光标行为对齐 */}
        {"\n"}
      </pre>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onScroll={syncScroll}
        spellCheck={false}
        wrap="off"
        placeholder={placeholder}
        className="absolute inset-0 h-full w-full resize-none whitespace-pre rounded-lg border-0 bg-transparent p-2 font-mono text-xs leading-5 text-transparent caret-foreground outline-none placeholder:text-muted-foreground/60"
      />
    </div>
  );
}
