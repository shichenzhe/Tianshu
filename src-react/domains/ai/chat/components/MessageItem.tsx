/**
 * 单条消息渲染：过程块（thinking/tool_call）收进深度思考面板 + 答案正文
 * （text/usage）+ 错误横幅 + 重新生成按钮。user 消息右侧气泡 + hover 操作栏
 * （时间戳/编辑/复制），assistant 消息左侧全宽；流式态由 MessageList 以
 * 伪消息 + streaming 传入
 */
import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Cpu, Pencil, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ModelApi } from "../../api/model.api";
import { parseBlocks } from "../model/blocks";
import { groupBlocks } from "../lib/group-blocks";
import { formatMessageTime } from "../lib/message-time";
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
  /** 重新生成回调(任意 assistant 消息;其后内容将被覆盖);未提供则隐藏按钮 */
  onRegenerate?: (messageId: number) => void;
  /** 编辑重发入口(user 消息 hover 操作栏);未提供则隐藏编辑按钮 */
  onEdit?: (messageId: number) => void;
  /** 隐藏编辑/复制按钮(流式生成中,user 操作栏仅余时间戳) */
  hideActions?: boolean;
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

/** 复制按钮（assistant 操作行与 user hover 操作栏共用）：对勾反馈 + 冒泡提示 */
function CopyButton({
  label,
  copied,
  onCopy,
}: {
  label: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            onClick={onCopy}
            aria-label={label}
            className="h-7 w-7 p-0 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * user 消息 hover 操作栏：时间戳仅在 hovered 时按当前时钟计算（每次进入
 * 重新渲染，跨天显示正确）；编辑按钮存在 onEdit 时渲染；hideActions
 * （流式生成中）隐藏编辑与复制、仅余时间戳
 */
function UserActionBar({
  createdAt,
  messageId,
  onEdit,
  hideActions,
  copied,
  onCopy,
  hovered,
}: {
  createdAt: string;
  messageId: number;
  onEdit?: (messageId: number) => void;
  hideActions?: boolean;
  copied: boolean;
  onCopy: () => void;
  hovered: boolean;
}) {
  const { t, i18n } = useTranslation(["chat", "common"]);

  return (
    <div className="mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
      {hovered && (
        <span className="text-xs text-muted-foreground select-none">
          {formatMessageTime(createdAt, i18n.language)}
        </span>
      )}
      {!hideActions && onEdit && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onEdit(messageId)}
                aria-label={t("chat:message.edit")}
                className="h-7 w-7 p-0 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("chat:message.editHint")}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {!hideActions && (
        <CopyButton label={t("common:copy")} copied={copied} onCopy={onCopy} />
      )}
    </div>
  );
}

function MessageItemImpl({
  message,
  streaming = false,
  onRegenerate,
  onEdit,
  hideActions = false,
  hitOffset,
}: MessageItemProps) {
  const { t } = useTranslation(["chat", "common"]);
  const [copied, setCopied] = useState(false);
  // hover 态仅为重算时间戳触发重渲染（显隐交给 CSS group-hover）
  const [hovered, setHovered] = useState(false);
  const searchQuery = useSessionSearchStore((s) => s.query);
  const searchActiveIndex = useSessionSearchStore((s) => s.activeIndex);

  // 当条输出模型(id → 名称;共享 ["models"] 缓存,仅 assistant 且有 modelId 时查)
  const modelsQuery = useQuery({
    queryKey: ["models"],
    queryFn: () => ModelApi.listAll(),
    enabled: message.role === "assistant" && message.modelId !== undefined,
    staleTime: 300_000,
  });
  const modelName = modelsQuery.data?.find(
    (model) => model.id === message.modelId,
  )?.modelId;

  /** 复制到剪贴板：写入纯文本，对勾 1500ms 复位 + 成功 toast，失败提示 */
  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success(t("common:copied"));
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("common:copyFailed"));
    }
  };

  if (message.role === "user") {
    const text = parseBlocks(message.blocks)
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");

    return (
      <div
        className="group flex flex-col items-end"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
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
        <UserActionBar
          createdAt={message.createdAt}
          messageId={message.id}
          onEdit={onEdit}
          hideActions={hideActions}
          copied={copied}
          onCopy={() => void copyText(text)}
          hovered={hovered}
        />
      </div>
    );
  }

  const blocks = parseBlocks(message.blocks);
  const grouped = groupBlocks(blocks);
  const showRegenerate = !streaming && Boolean(onRegenerate);

  /** 正文块逐块累计块前命中数：伪调用块计数但不渲染（与 MessageList 统计一致） */
  let hitsBeforeBlock = 0;

  const handleCopy = () =>
    copyText(grouped.texts.map((block) => block.text).join("\n"));

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
          durationMs={message.durationMs}
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
      {/* 操作行:默认常显(不随悬浮);复制/重新生成带冒泡提示,重生成右侧为当条输出模型 */}
      <div className="mt-1 flex items-center gap-1">
        <CopyButton
          label={t("common:copy")}
          copied={copied}
          onCopy={handleCopy}
        />
        {showRegenerate && onRegenerate && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onRegenerate(message.id)}
                  aria-label={t("chat:message.regenerate")}
                  className="h-7 w-7 p-0 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("chat:message.regenerateTip")}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        {modelName && (
          <span className="ml-1 flex items-center gap-1 text-xs text-muted-foreground select-none">
            <Cpu className="h-3 w-3" />
            {modelName}
          </span>
        )}
      </div>
    </div>
  );
}

export default memo(MessageItemImpl);
