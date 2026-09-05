/**
 * 单条消息渲染：过程块（thinking/tool_call）收进深度思考面板 + 答案正文
 * （text/usage）+ 错误横幅 + 重新生成按钮。user 消息右侧主色气泡，
 * assistant 消息左侧全宽；流式态由 MessageList 以伪消息 + streaming 传入
 */
import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { parseBlocks } from "../model/blocks";
import { groupBlocks } from "../lib/group-blocks";
import {
  countHits,
  createHighlightContext,
  highlightChildren,
} from "../lib/search-highlight";
import { detectPseudoToolCallText } from "../lib/pseudo-tool-call";
import { useSessionSearchStore } from "../../store/session-search.store";
import type { MessageRecord } from "../../api/session.api";
import ThinkingPanel from "./ThinkingPanel";
import MarkdownView from "./MarkdownView";
import PseudoToolCallNotice from "./PseudoToolCallNotice";

interface MessageItemProps {
  message: MessageRecord;
  /** 流式中的实时气泡：面板显示「思考中」并默认展开 */
  streaming?: boolean;
  /** 仅最后一条助手消息为 true（配合 onRegenerate 显示重新生成） */
  isLastAssistant?: boolean;
  /** 重新生成回调（Task 17 由 useChatSend 接线）；未提供则隐藏按钮 */
  onRegenerate?: () => void;
  /** 会话内搜索：该消息首个命中的全局序号（无命中/未搜索为 undefined） */
  hitOffset?: number;
}

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
  hitOffset,
}: MessageItemProps) {
  const { t } = useTranslation(["chat", "common"]);
  const [copied, setCopied] = useState(false);
  const searchQuery = useSessionSearchStore((s) => s.query);
  const searchActiveIndex = useSessionSearchStore((s) => s.activeIndex);

  if (message.role === "user") {
    const text = parseBlocks(message.blocks)
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");

    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] whitespace-pre-wrap break-words rounded-lg bg-secondary px-3 py-2 text-sm text-foreground">
          {searchQuery && hitOffset !== undefined
            ? highlightChildren(
                text,
                createHighlightContext(
                  searchQuery,
                  searchActiveIndex,
                  hitOffset,
                ),
              )
            : text}
        </div>
      </div>
    );
  }

  const blocks = parseBlocks(message.blocks);
  const grouped = groupBlocks(blocks);
  const showRegenerate = isLastAssistant && Boolean(onRegenerate);

  /** 正文块逐块累计块前命中数：伪调用块计数但不渲染（与 MessageList 统计一致） */
  let hitsBeforeBlock = 0;

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
      {grouped.texts.map((block, index) => {
        // 块级命中序号 = 消息序号 + 块前累计（伪调用块也计数，与列表统计一致）
        const blockOffset =
          hitOffset !== undefined ? hitOffset + hitsBeforeBlock : undefined;
        hitsBeforeBlock += countHits(block.text, searchQuery);
        // 伪工具调用碎片（本地服务未实现结构化 tool_calls）：警示折叠替代正文渲染
        return detectPseudoToolCallText(block.text) ? (
          <PseudoToolCallNotice key={`text-${index}`} rawText={block.text} />
        ) : (
          <MarkdownView
            key={`text-${index}`}
            text={block.text}
            hitOffset={searchQuery ? blockOffset : undefined}
          />
        );
      })}
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
