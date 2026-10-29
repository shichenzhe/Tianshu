/**
 * 单条消息渲染：过程块（thinking/tool_call）收进深度思考面板 + 答案正文
 * （text/usage）+ 错误横幅 + 重新生成按钮。user 消息右侧气泡 + hover 操作栏
 * （时间戳/编辑/复制），编辑态气泡原位替换为 EditBar；assistant 消息左侧
 * 头像列（专家 icon/默认 Logo）+ 内容列，操作行最右为悬浮时间戳（与 user
 * 共用 HoverTimestamp）；流式态由
 * MessageList 以伪消息 + streaming 传入
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
import { cn } from "@/lib/utils";
import { ModelApi } from "../../api/model.api";
import { parseBlocks, type MessageBlock } from "../model/blocks";
import { splitFileRefPrefix } from "../lib/file-ref-lines";
import { groupBlocks } from "../lib/group-blocks";
import { formatMessageTime } from "../lib/message-time";
import { renderHitMarks } from "../lib/search-highlight";
import type { BlockHit, HitRange } from "../lib/hit-positions";
import { detectPseudoToolCallText } from "../lib/pseudo-tool-call";
import { useSessionSearchStore } from "../../store/session-search.store";
import type { MessageRecord } from "../../api/session.api";
import ThinkingPanel from "./ThinkingPanel";
import MarkdownView from "./MarkdownView";
import AssistantAvatar from "./AssistantAvatar";
import WidgetRenderer from "./WidgetRenderer";
import ExpertRecommendCard from "./ExpertRecommendCard";
import PseudoToolCallNotice from "./PseudoToolCallNotice";
import { MessageImage } from "./MessageImage";
import MessageFileRef from "./MessageFileRef";
import type { ImageBlock } from "../model/blocks";
import EditBar from "./EditBar";

interface MessageItemProps {
  message: MessageRecord;
  /** 所属会话 id：推荐卡（recommend_expert）添加专家后绑定回当前会话；
   *  缺省只添加不绑定（组件渲染不依赖该值） */
  sessionId?: number;
  /** 流式中的实时气泡：面板显示「思考中」并默认展开 */
  streaming?: boolean;
  /** 重新生成回调(任意 assistant 消息;其后内容将被覆盖);未提供则隐藏按钮 */
  onRegenerate?: (messageId: number) => void;
  /** 编辑重发入口(user 消息 hover 操作栏);未提供则隐藏编辑按钮 */
  onEdit?: (messageId: number) => void;
  /** 隐藏编辑/复制按钮(流式生成中,user 操作栏仅余时间戳) */
  hideActions?: boolean;
  /** 原位编辑态：该 user 消息正被编辑（气泡原位替换为 EditBar） */
  isEditing?: boolean;
  /** 编辑回填原文（isEditing 时传给 EditBar 的 initialText） */
  editInitialText?: string;
  /** 原位编辑提交（重发）；未提供则不进入编辑态渲染 */
  onEditSubmit?: (text: string) => void;
  /** 原位编辑取消 */
  onEditCancel?: () => void;
  /** 会话内搜索：该消息首个命中的全局序号（无命中/未搜索为 undefined） */
  hitOffset?: number;
  /** 会话内搜索：该消息的位置级命中集合（blockIdx 原始块下标 + 块内
   *  偏移；计数与着色同一份——与 hitOffset 配套下发） */
  searchHits?: BlockHit[];
  /** 会话当前专家 icon（emoji，头像列展示；无专家走默认 Logo） */
  assistantIcon?: string;
  /** 远端模型名映射（CU 批远控注入：远端 modelId → 展示名——远端 id 与
   *  本地模型表无关，注入后免查本地缓存；本地消费不传走原链路） */
  remoteModelName?: (modelId: number) => string | undefined;
  /** 会话所属工作空间 id：user 消息引用文件卡片点击打开用；null（远程
   *  会话——空间概念不跨主机/未绑定）纯展示不可点 */
  workspaceId?: number | null;
  /** 结构化 blocks 直传（M8）：流式 liveMessage 免 serialize→parse 的
   *  全量 JSON 往返；缺省走 message.blocks 解析（历史消息） */
  parsedBlocks?: MessageBlock[];
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
 * 悬浮时间戳（user/assistant 操作栏共用）：文本每次渲染按当前时钟格式化
 * （外层 hovered state 随移入/移出重渲染，跨天显示正确），显隐与 150ms 淡入
 * 淡出交由外层 group + group-hover:opacity-100；show 控制挂载——user 悬浮
 * 才挂载按需计算，assistant 非 streaming 常驻（保留移出淡出动画）
 */
function HoverTimestamp({
  iso,
  locale,
  className,
  show,
}: {
  iso: string;
  locale: string;
  className?: string;
  show: boolean;
}) {
  if (!show) return null;
  return (
    <span
      className={cn(
        "text-xs text-muted-foreground select-none pointer-events-none",
        "opacity-0 group-hover:opacity-100 transition-opacity duration-150",
        className,
      )}
    >
      {formatMessageTime(iso, locale)}
    </span>
  );
}

/**
 * user 消息 hover 操作栏：时间戳（共用 HoverTimestamp）仅 hovered 时按当前
 * 时钟计算（每次进入重新渲染，跨天显示正确）；编辑按钮存在 onEdit 时渲染；
 * hideActions（流式生成中）隐藏编辑与复制、仅余时间戳
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
      <HoverTimestamp iso={createdAt} locale={i18n.language} show={hovered} />
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
  sessionId,
  streaming = false,
  onRegenerate,
  onEdit,
  hideActions = false,
  isEditing = false,
  editInitialText,
  onEditSubmit,
  onEditCancel,
  hitOffset,
  searchHits,
  assistantIcon,
  remoteModelName,
  workspaceId,
  parsedBlocks,
}: MessageItemProps) {
  const { t, i18n } = useTranslation(["chat", "common"]);
  const [copied, setCopied] = useState(false);
  // hover 态仅为重算时间戳触发重渲染（显隐交给 CSS group-hover；user/
  // assistant 均接线移入移出，assistant 流式期同理仅重算）
  const [hovered, setHovered] = useState(false);
  const searchQuery = useSessionSearchStore((s) => s.query);
  const searchActiveIndex = useSessionSearchStore((s) => s.activeIndex);

  // 当条输出模型(id → 名称;共享 ["models"] 缓存,仅 assistant 且有 modelId 时查)
  // remoteModelName（CU 批）：远控面板注入远端模型名映射——命中则免查
  // 本地模型表（远端 modelId 与本地表无关），本地消费不传走原链路
  const modelsQuery = useQuery({
    queryKey: ["models"],
    queryFn: () => ModelApi.listAll(),
    enabled:
      remoteModelName === undefined &&
      message.role === "assistant" &&
      message.modelId !== undefined,
    staleTime: 300_000,
  });
  const modelName =
    (message.modelId !== undefined
      ? remoteModelName?.(message.modelId)
      : undefined) ??
    modelsQuery.data?.find((model) => model.id === message.modelId)?.modelId;

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
    const parsed = parseBlocks(message.blocks);
    const rawText = parsed
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    // 文件引用前缀段（引用式 + 内容注入式）拆出渲染文件卡片，rest 进
    // 气泡；复制与编辑回填仍走全文口径（引用行随原文回喂/重发，保持发给
    // AI 的语义）
    const { refs, rest } = splitFileRefPrefix(rawText);
    // 位置级命中（块坐标）换算成气泡余文坐标：text 块跨度表（joined
    // 坐标）+ 前缀长剔除——与 hit-positions 纯函数同口径的逆变换
    const spans = new Map<number, { start: number; length: number }>();
    let spanOffset = 0;
    parsed.forEach((block, blockIdx) => {
      if (block.type === "text") {
        spans.set(blockIdx, { start: spanOffset, length: block.text.length });
        spanOffset += block.text.length + 1;
      }
    });
    const prefixLength = rawText.length - rest.length;
    const restRanges: HitRange[] = (searchHits ?? [])
      .map((hit) => {
        const span = spans.get(hit.blockIdx);
        return span
          ? {
              start: span.start + hit.start - prefixLength,
              length: hit.length,
            }
          : null;
      })
      .filter((range): range is HitRange => range !== null && range.start >= 0)
      .sort((a, b) => a.start - b.start);
    const fileRefCards = refs.length > 0 && (
      <div className="mb-1.5 flex max-w-[75%] flex-col items-end gap-1.5">
        {refs.map((path, index) => (
          <MessageFileRef
            key={`${index}-${path}`}
            path={path}
            workspaceId={workspaceId}
          />
        ))}
      </div>
    );
    // 图片附件块（多模态输入）：文件名 chip（2026-10-24 参照形态改版——
    // 不在消息流展开大缩略图，点击 chip 进 lightbox）；编辑态与正常态共用
    // ——编辑只改文本，图片随行保留。正常态内联进气泡文本前（参照形态），
    // 编辑态独立行（EditBar 为块级组件，chip 不与其混排）
    const images = parsed.filter(
      (block): block is ImageBlock => block.type === "image",
    );
    const imageChipNodes = images.map((image) => (
      <MessageImage
        key={image.imagePath}
        imagePath={image.imagePath}
        name={image.name}
      />
    ));

    // 原位编辑态：EditBar 替换气泡与 hover 操作栏（items-end 列内右对齐，
    // 宽度由 EditBar 外层 75% 上限自适配）；hideActions（会话 sending）期间
    // 恢复普通气泡防呆，流结束自动回到编辑态（editing state 由 ChatView 持有）
    if (isEditing && !hideActions && onEditSubmit && onEditCancel) {
      return (
        <div className="flex flex-col items-end">
          {fileRefCards}
          {images.length > 0 && (
            <div className="mb-1.5 flex max-w-[75%] flex-wrap justify-end gap-1">
              {imageChipNodes}
            </div>
          )}
          <EditBar
            initialText={editInitialText ?? ""}
            onCancel={onEditCancel}
            onSubmit={onEditSubmit}
          />
        </div>
      );
    }

    return (
      <div
        className="group flex flex-col items-end"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {fileRefCards}
        {/* 纯图消息（rest 空）气泡仍渲染——chip 即气泡内容（参照形态：
            [chip] 文本 同行内联；多图 flex-wrap 换行续排） */}
        {(images.length > 0 || rest.trim() !== "") && (
          <div className="max-w-[75%] whitespace-pre-wrap break-words rounded-lg bg-secondary px-3 py-2 text-sm text-foreground">
            {images.length > 0 && (
              <span className="mr-1 inline-flex max-w-full flex-wrap gap-1 align-middle">
                {imageChipNodes}
              </span>
            )}
            {searchQuery && hitOffset !== undefined && restRanges.length > 0
              ? renderHitMarks(rest, restRanges, hitOffset, searchActiveIndex)
              : rest}
          </div>
        )}
        <UserActionBar
          createdAt={message.createdAt}
          messageId={message.id}
          onEdit={onEdit}
          hideActions={hideActions}
          copied={copied}
          onCopy={() => void copyText(rawText)}
          hovered={hovered}
        />
      </div>
    );
  }

  const blocks = parsedBlocks ?? parseBlocks(message.blocks);
  const grouped = groupBlocks(blocks);
  const showRegenerate = !streaming && Boolean(onRegenerate);

  /** 正文块逐块累计块前命中数：同一份位置级集合驱动计数与着色
   *  （伪调用块命中已在纯函数层剔除，无计数无落点漂移） */
  let hitsBeforeBlock = 0;
  // text 块引用 → 原始 blockIdx（groupBlocks 保序保留原块引用）+
  // blockIdx → 块内命中区间，逐块下发 MarkdownView
  const textBlockIdx = new Map<MessageBlock, number>();
  blocks.forEach((block, blockIdx) => {
    if (block.type === "text") {
      textBlockIdx.set(block, blockIdx);
    }
  });
  const hitsByBlock = new Map<number, BlockHit[]>();
  for (const hit of searchHits ?? []) {
    const list = hitsByBlock.get(hit.blockIdx);
    if (list) {
      list.push(hit);
    } else {
      hitsByBlock.set(hit.blockIdx, [hit]);
    }
  }

  const handleCopy = () =>
    copyText(grouped.texts.map((block) => block.text).join("\n"));

  return (
    <div
      className="group flex min-w-0 items-start gap-2.5"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* assistant 头像列（WorkBuddy 同构：头像 + 内容两列） */}
      <AssistantAvatar icon={assistantIcon} />
      <div className="min-w-0 flex-1">
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
        {/* 可视化组件（show_widget 工具块分流）：消息流正文位沙箱渲染 */}
        {grouped.widgets.map((widget) => (
          <WidgetRenderer
            key={widget.toolCallId}
            title={widget.title}
            code={widget.code}
            state={widget.state}
          />
        ))}
        {/* 专家推荐卡（recommend_expert 工具块分流）：消息流正文位渲染 */}
        {grouped.recommends.map((rec) => (
          <ExpertRecommendCard
            key={rec.toolCallId}
            item={rec}
            sessionId={sessionId}
          />
        ))}
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
          // 块级命中序号 = 消息序号基 + 块前累计（同一份位置级集合前缀和）
          const blockIdx = textBlockIdx.get(block);
          const blockHits =
            blockIdx !== undefined ? hitsByBlock.get(blockIdx) : undefined;
          const blockOffset =
            hitOffset !== undefined ? hitOffset + hitsBeforeBlock : undefined;
          hitsBeforeBlock += blockHits?.length ?? 0;
          // 伪工具调用碎片（本地服务未实现结构化 tool_calls）：警示折叠替代正文渲染
          return detectPseudoToolCallText(block.text) ? (
            <PseudoToolCallNotice key={`text-${index}`} rawText={block.text} />
          ) : (
            <MarkdownView
              key={`text-${index}`}
              text={block.text}
              hits={
                searchQuery && blockHits
                  ? blockHits.map(({ start, length }) => ({ start, length }))
                  : undefined
              }
              hitBase={searchQuery ? blockOffset : undefined}
              streaming={streaming}
            />
          );
        })}
        {grouped.usage && (
          <UsageBlockView
            input={grouped.usage.input}
            output={grouped.usage.output}
          />
        )}
        {/* 操作行:默认常显(不随悬浮);复制/重新生成带冒泡提示,重生成右侧为当
          条输出模型,最右为悬浮时间戳(与 user 同格式,streaming 不渲染) */}
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
                <TooltipContent>
                  {t("chat:message.regenerateTip")}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {modelName && (
            <span className="ml-1 flex items-center gap-1 text-xs text-muted-foreground select-none">
              <Cpu className="h-3 w-3" />
              {modelName}
            </span>
          )}
          <HoverTimestamp
            iso={message.createdAt}
            locale={i18n.language}
            show={!streaming}
            className="ml-2"
          />
        </div>
      </div>
    </div>
  );
}

export default memo(MessageItemImpl);
