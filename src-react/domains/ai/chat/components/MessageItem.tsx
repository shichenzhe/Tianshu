/**
 * 单条消息渲染：blocks 分发（text/thinking/usage）+ 错误横幅 + 重新生成按钮
 * user 消息右侧主色气泡，assistant 消息左侧全宽
 */
import { isValidElement, memo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { type Components } from "react-markdown";
import { Check, Copy, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { parseBlocks, type MessageBlock } from "../model/blocks";
import type { MessageRecord } from "../../api/session.api";
import CodeBlock from "./CodeBlock";
import ToolCallCard from "./ToolCallCard";

interface MessageItemProps {
  message: MessageRecord;
  /** 仅最后一条助手消息为 true（配合 onRegenerate 显示重新生成） */
  isLastAssistant?: boolean;
  /** 重新生成回调（Task 17 由 useChatSend 接线）；未提供则隐藏按钮 */
  onRegenerate?: () => void;
}

/**
 * 递归提取 React 子树中的纯文本（code 元素内容为转义后的源码文本）
 */
function toPlainText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(toPlainText).join("");
  }
  if (isValidElement(node)) {
    return toPlainText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

/**
 * react-markdown v9+ 移除了 code 的 inline 属性，围栏代码统一在 pre 层拦截：
 * 提取源码交给 CodeBlock（shiki 高亮，自带 pre），内联代码仍走 code 组件。
 * 不配置 rehype-raw（不渲染原始 HTML，规避 XSS 注入面）。
 */
const MARKDOWN_COMPONENTS: Components = {
  pre: ({ children }) => {
    const first = Array.isArray(children) ? children[0] : children;
    if (isValidElement(first)) {
      const { className, children: codeChildren } = first.props as {
        className?: string;
        children?: ReactNode;
      };
      const lang = /language-([\w-]+)/.exec(className ?? "")?.[1] ?? "text";
      return (
        <CodeBlock
          code={toPlainText(codeChildren).replace(/\n$/, "")}
          lang={lang}
        />
      );
    }
    return <pre>{children}</pre>;
  },
  code: ({ children }) => (
    <code className="rounded bg-muted px-1 py-0.5 text-xs">{children}</code>
  ),
};

/**
 * markdown 渲染（memo：流式增量重渲染时跳过历史消息的重解析）
 */
const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  return (
    <div className="break-words text-sm leading-relaxed">
      <ReactMarkdown components={MARKDOWN_COMPONENTS}>{text}</ReactMarkdown>
    </div>
  );
});

function ThinkingBlockView({ text }: { text: string }) {
  const { t } = useTranslation(["chat"]);

  return (
    <details className="my-1 rounded-md border border-border/50 bg-muted/30">
      <summary className="cursor-pointer select-none px-3 py-1.5 text-xs text-muted-foreground">
        {t("chat:message.thinking")}
      </summary>
      <div className="whitespace-pre-wrap break-words px-3 pb-2 text-xs leading-relaxed text-muted-foreground">
        {text}
      </div>
    </details>
  );
}

function UsageBlockView({ input, output }: { input: number; output: number }) {
  const { t } = useTranslation(["chat"]);

  return (
    <div className="mt-1 text-xs text-muted-foreground">
      {t("chat:message.usage", { input, output })}
    </div>
  );
}

function BlockView({ block }: { block: MessageBlock }) {
  switch (block.type) {
    case "text":
      return <MarkdownBlock text={block.text} />;
    case "thinking":
      return <ThinkingBlockView text={block.text} />;
    case "usage":
      return <UsageBlockView input={block.input} output={block.output} />;
    case "tool_call":
      // 落库块 output 恒为主进程写入的字符串（done/denied/error 终态），兜底非字符串不展示
      return (
        <ToolCallCard
          toolName={block.toolName}
          args={block.args}
          state={block.state}
          output={typeof block.output === "string" ? block.output : undefined}
        />
      );
    default:
      return null;
  }
}

function MessageItemImpl({
  message,
  isLastAssistant = false,
  onRegenerate,
}: MessageItemProps) {
  const { t } = useTranslation(["chat", "common"]);
  const [copied, setCopied] = useState(false);

  if (message.role === "user") {
    const text = parseBlocks(message.blocks)
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");

    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] whitespace-pre-wrap break-words rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
          {text}
        </div>
      </div>
    );
  }

  const blocks = parseBlocks(message.blocks);
  const showRegenerate = isLastAssistant && Boolean(onRegenerate);

  const handleCopy = async () => {
    const text = blocks
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success(t("common:copied"));
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("common:copyFailed"));
    }
  };

  return (
    <div className="group min-w-0">
      {message.error && (
        <div className="mb-2 rounded-md bg-destructive/10 px-3 py-2">
          <p className="text-xs font-medium text-destructive">
            {t("chat:message.failed")}
          </p>
          <p className="mt-0.5 break-words text-xs text-destructive/90">
            {message.error}
          </p>
        </div>
      )}
      {blocks.map((block, index) => (
        <BlockView key={`${index}-${block.type}`} block={block} />
      ))}
      <div className="mt-1 flex items-center gap-1 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          aria-label={t("common:copy")}
          className="h-7 px-2 text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </Button>
        {showRegenerate && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onRegenerate}
            className="h-7 px-2 text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
          >
            <RotateCcw className="mr-1 h-3.5 w-3.5" />
            {t("chat:message.regenerate")}
          </Button>
        )}
      </div>
    </div>
  );
}

export default memo(MessageItemImpl);
