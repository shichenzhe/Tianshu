/**
 * 单条消息渲染：过程块（thinking/tool_call）收进深度思考面板 + 答案正文
 * （text/usage）+ 错误横幅 + 重新生成按钮。user 消息右侧主色气泡，
 * assistant 消息左侧全宽；流式态由 MessageList 以伪消息 + streaming 传入
 */
import { isValidElement, memo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { type Components } from "react-markdown";
import { Check, Copy, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { parseBlocks } from "../model/blocks";
import { groupBlocks } from "../lib/group-blocks";
import type { MessageRecord } from "../../api/session.api";
import CodeBlock from "./CodeBlock";
import ThinkingPanel from "./ThinkingPanel";

interface MessageItemProps {
  message: MessageRecord;
  /** 流式中的实时气泡：面板显示「思考中」并默认展开 */
  streaming?: boolean;
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

function UsageBlockView({ input, output }: { input: number; output: number }) {
  const { t } = useTranslation(["chat"]);

  return (
    <div className="mt-1 text-xs text-muted-foreground">
      {t("chat:message.usage", { input, output })}
    </div>
  );
}

function MessageItemImpl({
  message,
  streaming = false,
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
  const grouped = groupBlocks(blocks);
  const showRegenerate = isLastAssistant && Boolean(onRegenerate);

  const handleCopy = async () => {
    const text = grouped.texts.map((block) => block.text).join("\n");
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
      {/* 深度思考面板（答案上方，PRD §2.2）：流式展开实时过程，落库默认折叠 */}
      {grouped.hasProcess && (
        <ThinkingPanel
          status={streaming ? "streaming" : "done"}
          thinking={grouped.thinkingText}
          tools={grouped.tools}
          defaultOpen={streaming}
        />
      )}
      {grouped.texts.map((block, index) => (
        <MarkdownBlock key={`text-${index}`} text={block.text} />
      ))}
      {grouped.usage && (
        <UsageBlockView
          input={grouped.usage.input}
          output={grouped.usage.output}
        />
      )}
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
