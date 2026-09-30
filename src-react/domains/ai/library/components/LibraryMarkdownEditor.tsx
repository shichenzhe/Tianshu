/**
 * Markdown 编辑器（详情面板 md 编辑载体，标准编辑器交互）：
 * - 工具栏：标题 1-3 / 加粗 / 斜体 / 删除线 / 行内代码 / 代码块 / 链接 /
 *   引用 / 无序·有序列表 / 表格 / 分隔线（title 冒泡提示）
 * - 快捷键：⌘B 加粗 / ⌘I 斜体 / ⌘K 链接 / Tab·Shift+Tab 缩进（跨行选区
 *   逐行 ±2 空格）/ Enter 列表·引用续行（空项退出，有序 +1）
 * - 变换走 lib/markdown-edit 纯函数（单测覆盖），完成后恢复光标选区
 * - 左编辑右预览分栏：右栏复用 MarkdownView（GFM + shiki）；编辑侧滚动
 *   单向比例同步预览侧（双向会互振）；工具栏尾 Eye 开关预览（关=纯
 *   编辑独占全宽）
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Bold,
  Code,
  Eye,
  EyeOff,
  Italic,
  Link,
  List,
  ListOrdered,
  Minus,
  SquareCode,
  Strikethrough,
  Table,
  TextQuote,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import MarkdownView from "@/domains/ai/chat/components/MarkdownView";
import {
  continueList,
  indentSelection,
  insertCodeBlock,
  insertHr,
  insertLink,
  insertTable,
  toggleHeading,
  toggleLinePrefix,
  toggleWrap,
  type TextEditResult,
} from "../lib/markdown-edit";
import IconTooltip from "./icon-tooltip";

interface LibraryMarkdownEditorProps {
  value: string;
  onChange: (next: string) => void;
  /** 内容读取中（textarea 禁用，避免覆盖成空串） */
  loading?: boolean;
}

/** 工具栏按钮基类（ghost 小图标钮，hover primary） */
const TOOL_BTN =
  "rounded p-1.5 text-muted-foreground hover:bg-primary-subtle hover:text-primary disabled:opacity-50";

export default function LibraryMarkdownEditor({
  value,
  onChange,
  loading = false,
}: LibraryMarkdownEditorProps) {
  const { t } = useTranslation(["chat"]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  // 变换后的待恢复光标（受控重渲染后 setSelectionRange，一次性）
  const [pendingSel, setPendingSel] = useState<[number, number] | null>(null);
  // 预览栏开关（关=纯编辑独占全宽）
  const [showPreview, setShowPreview] = useState(true);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!pendingSel || !ta) {
      return;
    }
    ta.setSelectionRange(pendingSel[0], pendingSel[1]);
    setPendingSel(null);
  }, [pendingSel, value]);

  /** 应用变换结果：上抛文本 + 光标恢复 + 焦点回编辑器 */
  const applyEdit = (result: TextEditResult) => {
    onChange(result.text);
    setPendingSel(result.selection);
    textareaRef.current?.focus();
  };

  /** 按当前选区执行变换 */
  const runWithSelection = (
    fn: (text: string, start: number, end: number) => TextEditResult,
  ) => {
    const ta = textareaRef.current;
    if (!ta) {
      return;
    }
    applyEdit(fn(value, ta.selectionStart, ta.selectionEnd));
  };

  // 工具动作（占位文本统一「文本」）
  const bold = () =>
    runWithSelection((text, s, e) =>
      toggleWrap(text, s, e, "**", t("chat:library.mdPlaceholder")),
    );
  const italic = () =>
    runWithSelection((text, s, e) =>
      toggleWrap(text, s, e, "*", t("chat:library.mdPlaceholder")),
    );
  const strike = () =>
    runWithSelection((text, s, e) =>
      toggleWrap(text, s, e, "~~", t("chat:library.mdPlaceholder")),
    );
  const inlineCode = () =>
    runWithSelection((text, s, e) =>
      toggleWrap(text, s, e, "`", t("chat:library.mdPlaceholder")),
    );
  const quote = () =>
    runWithSelection((text, s, e) => toggleLinePrefix(text, s, e, "> "));
  const bulletList = () =>
    runWithSelection((text, s, e) => toggleLinePrefix(text, s, e, "- "));
  const orderedList = () =>
    runWithSelection((text, s, e) =>
      toggleLinePrefix(text, s, e, (row) => `${row + 1}. `),
    );

  /** Tab/Enter 等键盘行为（⌘B/I/K、缩进、列表续行） */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "b") {
      e.preventDefault();
      bold();
      return;
    }
    if (mod && e.key.toLowerCase() === "i") {
      e.preventDefault();
      italic();
      return;
    }
    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      runWithSelection(insertLink);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      runWithSelection((text, s, en) =>
        indentSelection(text, s, en, e.shiftKey),
      );
      return;
    }
    // 列表/引用续行（Shift+Enter 软换行不拦）
    if (e.key === "Enter" && !mod && !e.shiftKey && !e.altKey) {
      const ta = textareaRef.current;
      if (!ta) {
        return;
      }
      const result = continueList(value, ta.selectionStart);
      if (result) {
        e.preventDefault();
        applyEdit(result);
      }
    }
  };

  /** 编辑侧滚动单向比例同步预览侧（预览侧滚动不回写，避免互振） */
  const handleEditorScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const preview = previewRef.current;
    if (!preview) {
      return;
    }
    const editorMax = ta.scrollHeight - ta.clientHeight;
    const previewMax = preview.scrollHeight - preview.clientHeight;
    if (editorMax > 0 && previewMax > 0) {
      preview.scrollTop = (ta.scrollTop / editorMax) * previewMax;
    }
  };

  /** 工具栏按钮工厂（纯图标钮统一冒泡提示） */
  const tool = (label: string, icon: React.ReactNode, onClick: () => void) => (
    <IconTooltip key={label} label={label}>
      <button
        type="button"
        aria-label={label}
        disabled={loading}
        onClick={onClick}
        className={TOOL_BTN}
      >
        {icon}
      </button>
    </IconTooltip>
  );

  return (
    <TooltipProvider>
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {/* 工具栏（分组：标题 | 行内 | 块级） */}
        <div
          className={cn(
            "flex shrink-0 flex-wrap items-center gap-0.5 rounded-md border border-border/50 bg-muted/30 p-1",
          )}
        >
          {tool(
            t("chat:library.mdH1"),
            <span className="text-[11px] font-semibold">H1</span>,
            () =>
              runWithSelection((text, s, e) => toggleHeading(text, s, e, 1)),
          )}
          {tool(
            t("chat:library.mdH2"),
            <span className="text-[11px] font-semibold">H2</span>,
            () =>
              runWithSelection((text, s, e) => toggleHeading(text, s, e, 2)),
          )}
          {tool(
            t("chat:library.mdH3"),
            <span className="text-[11px] font-semibold">H3</span>,
            () =>
              runWithSelection((text, s, e) => toggleHeading(text, s, e, 3)),
          )}
          <span className="mx-1 h-4 w-px bg-border/60" aria-hidden="true" />
          {tool(t("chat:library.mdBold"), <Bold className="h-4 w-4" />, bold)}
          {tool(
            t("chat:library.mdItalic"),
            <Italic className="h-4 w-4" />,
            italic,
          )}
          {tool(
            t("chat:library.mdStrike"),
            <Strikethrough className="h-4 w-4" />,
            strike,
          )}
          {tool(
            t("chat:library.mdInlineCode"),
            <Code className="h-4 w-4" />,
            inlineCode,
          )}
          <span className="mx-1 h-4 w-px bg-border/60" aria-hidden="true" />
          {tool(t("chat:library.mdLink"), <Link className="h-4 w-4" />, () =>
            runWithSelection(insertLink),
          )}
          {tool(
            t("chat:library.mdQuote"),
            <TextQuote className="h-4 w-4" />,
            quote,
          )}
          {tool(
            t("chat:library.mdList"),
            <List className="h-4 w-4" />,
            bulletList,
          )}
          {tool(
            t("chat:library.mdOrderedList"),
            <ListOrdered className="h-4 w-4" />,
            orderedList,
          )}
          {tool(
            t("chat:library.mdCodeBlock"),
            <SquareCode className="h-4 w-4" />,
            () => {
              const ta = textareaRef.current;
              if (ta) {
                applyEdit(insertCodeBlock(value, ta.selectionStart));
              }
            },
          )}
          {tool(
            t("chat:library.mdTable"),
            <Table className="h-4 w-4" />,
            () => {
              const ta = textareaRef.current;
              if (ta) {
                applyEdit(insertTable(value, ta.selectionStart));
              }
            },
          )}
          {tool(t("chat:library.mdHr"), <Minus className="h-4 w-4" />, () => {
            const ta = textareaRef.current;
            if (ta) {
              applyEdit(insertHr(value, ta.selectionStart));
            }
          })}
          {/* 预览开关（工具栏尾右贴）：关=纯编辑独占全宽 */}
          <IconTooltip
            label={
              showPreview
                ? t("chat:library.mdHidePreview")
                : t("chat:library.mdShowPreview")
            }
          >
            <button
              type="button"
              aria-label={
                showPreview
                  ? t("chat:library.mdHidePreview")
                  : t("chat:library.mdShowPreview")
              }
              disabled={loading}
              onClick={() => setShowPreview((v) => !v)}
              className={cn(TOOL_BTN, "ml-auto", showPreview && "text-primary")}
            >
              {showPreview ? (
                <Eye className="h-4 w-4" />
              ) : (
                <EyeOff className="h-4 w-4" />
              )}
            </button>
          </IconTooltip>
        </div>
        {/* 左编辑右预览（预览关闭时编辑区独占全宽） */}
        <div className="flex min-h-0 flex-1 gap-2">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onScroll={handleEditorScroll}
            spellCheck={false}
            aria-label={t("chat:library.editContent")}
            disabled={loading}
            className="min-h-0 flex-1 resize-none rounded-md border border-border/50 bg-background p-3 font-mono text-sm leading-relaxed outline-none focus:border-primary/30 disabled:opacity-60"
          />
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
    </TooltipProvider>
  );
}
