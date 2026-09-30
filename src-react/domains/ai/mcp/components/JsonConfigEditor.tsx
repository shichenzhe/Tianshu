/**
 * mcp.json 编辑器：textarea（前景透明）+ shiki 高亮 overlay + 自绘行号。
 * 高亮 200ms 防抖重绘；shiki 未就绪/失败时回退纯文本（React 文本节点自动转义）。
 * 对齐保证：overlay 与 textarea 共用 font-mono/text-[13px]/leading-6/
 * p-3 pl-12/whitespace-pre-wrap/break-all，gutter 固定 w-10
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { getHighlighter } from "../../chat/components/CodeBlock";
import { cn } from "@/lib/utils";

interface JsonConfigEditorProps {
  value: string;
  onChange: (next: string) => void;
  /** JSON 非法时红框（由父层校验后传入） */
  invalid?: boolean;
}

export default function JsonConfigEditor({
  value,
  onChange,
  invalid,
}: JsonConfigEditorProps) {
  const [html, setHtml] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void (async () => {
        const highlighter = await getHighlighter("json");
        if (!highlighter) {
          setHtml(null);
          return;
        }
        const out = highlighter.codeToHtml(value, {
          lang: "json",
          themes: { light: "github-light", dark: "github-dark" },
        });
        setHtml(out);
      })();
    }, 200);
    return () => clearTimeout(timerRef.current);
  }, [value]);

  const lineNumbers = useMemo(
    () =>
      value
        .split("\n")
        .map((_, i) => i + 1)
        .join(""),
    [value],
  );

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-lg border bg-muted/30 font-mono text-[13px] leading-6",
        invalid ? "border-destructive" : "border-border/50",
      )}
    >
      <div
        role="presentation"
        aria-hidden
        className="absolute inset-y-0 left-0 z-10 w-10 select-none overflow-hidden border-r border-border/30 py-3 pr-2 text-right text-muted-foreground/60"
      >
        {lineNumbers}
      </div>
      {html !== null ? (
        <div
          aria-hidden
          className="pointer-events-none max-h-[55vh] overflow-hidden py-0 [&_code]:leading-6 [&_pre]:bg-transparent [&_pre]:p-3 [&_pre]:pl-12 [&_pre]:whitespace-pre-wrap [&_pre]:break-all"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <div
          aria-hidden
          className="pointer-events-none max-h-[55vh] overflow-hidden whitespace-pre-wrap break-all p-3 pl-12"
        >
          {value}
        </div>
      )}
      <textarea
        role="textbox"
        spellCheck={false}
        aria-label="mcp.json"
        className="absolute inset-0 h-full w-full resize-none overflow-auto whitespace-pre-wrap break-all bg-transparent p-3 pl-12 font-mono text-[13px] leading-6 text-transparent caret-foreground outline-none"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
