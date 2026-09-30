/**
 * mcp.json 编辑器：textarea（前景透明）+ shiki 高亮 overlay + 自绘行号。
 * 高亮 200ms 防抖重绘，带代际守卫（value 变更/卸载后旧结果不回写）；
 * shiki 未就绪/失败（getHighlighter 会 rethrow）回退纯文本（React 文本节点自动转义）。
 * 对齐保证：overlay 与 textarea 共用 font-mono/text-[13px]/leading-6/
 * p-3 pl-12/whitespace-pre-wrap/break-all，gutter 固定 w-10 逐行堆叠（每行 leading-6）
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
    // 代际守卫：cleanup 置位后，在途的旧 value 高亮结果不再回写（防串台）
    let cancelled = false;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void (async () => {
        try {
          const highlighter = await getHighlighter("json");
          if (!highlighter) {
            if (!cancelled) setHtml(null);
            return;
          }
          const out = highlighter.codeToHtml(value, {
            lang: "json",
            themes: { light: "github-light", dark: "github-dark" },
          });
          // 剥离 shiki pre 的 tabindex：aria-hidden overlay 内不可留 Tab 焦点
          if (!cancelled) setHtml(out.replace(' tabindex="0"', ""));
        } catch {
          /* 高亮失败回退纯文本，下次输入重试 */
          if (!cancelled) setHtml(null);
        }
      })();
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timerRef.current);
    };
  }, [value]);

  const lineCount = useMemo(() => value.split("\n").length, [value]);

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
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i} className="leading-6">
            {i + 1}
          </div>
        ))}
      </div>
      {html !== null ? (
        <div
          aria-hidden
          // bg-transparent 加 v4 尾缀 !：压过 shiki pre 内联 background-color，
          // 否则深色模式高亮文字落在白底上；pre/code 补 font-mono 压过 preflight
          // 对 code,kbd,samp,pre 的元素级默认 mono 栈（与 textarea 同 --font-mono）
          className="pointer-events-none max-h-[55vh] overflow-hidden py-0 [&_code]:font-mono [&_code]:leading-6 [&_pre]:bg-transparent! [&_pre]:font-mono [&_pre]:p-3 [&_pre]:pl-12 [&_pre]:whitespace-pre-wrap [&_pre]:break-all"
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
