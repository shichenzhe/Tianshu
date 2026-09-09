/**
 * 深度思考面板：消息过程块（thinking + 工具调用）的统一折叠容器
 * 头部状态（思考中/已完成）随流式与落库两态切换；展开区限高内滚。
 * 流式面板与落库面板是两个组件实例——流结束 liveMessage 卸载、
 * 落库面板以 defaultOpen=false 挂载，「展开→已完成折叠」即挂载切换
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ChevronUp, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { useLoadingPhrase } from "../hooks/use-loading-phrase";
import { usePersonalizationUi } from "../hooks/use-personalization-ui";
import { summarizeThinking, type ToolPanelItem } from "../lib/group-blocks";
import ToolCallCard from "./ToolCallCard";

/** 展开区最大高度（PRD §3.2：超长思考内滚，避免撑破布局） */
const EXPAND_MAX_HEIGHT = "max-h-[400px]";

interface ThinkingPanelProps {
  /** streaming = 头部呼吸「思考中」；done = 「已完成」+ 折叠箭头 */
  status: "streaming" | "done";
  thinking: string;
  tools: ToolPanelItem[];
  /** 挂载初始态：流式 true（实时过程）、落库 false（默认折叠） */
  defaultOpen: boolean;
  /** 生成耗时毫秒(v9;done 态在「已完成」后展示) */
  durationMs?: number;
}

/** 耗时格式化(与 MessageItem 同语义;面板内独立小函数) */
function formatDuration(ms?: number): string | null {
  if (ms === undefined || ms === null) {
    return null;
  }
  if (ms < 1000) {
    return "<1s";
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

export default function ThinkingPanel({
  status,
  thinking,
  tools,
  defaultOpen,
  durationMs,
}: ThinkingPanelProps) {
  const { t } = useTranslation(["chat"]);
  const [open, setOpen] = useState(defaultOpen);

  // 加载欢迎语（spec §5.3A）：开关开 → 1.5s 后轮换问候语；关 → 仅 spinner 无文字
  const { welcomeLoading } = usePersonalizationUi();
  const phrase = useLoadingPhrase(status === "streaming" && welcomeLoading);

  return (
    <div className="my-1 rounded-md border border-border/50 bg-muted/30">
      {/* 头部：状态 + 摘要（点击整行切换折叠） */}
      <button
        type="button"
        className="flex w-full cursor-pointer select-none items-center gap-2 px-3 py-1.5 text-left"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        {status === "streaming" ? (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {welcomeLoading ? (phrase ?? t("chat:panel.thinkingStatus")) : null}
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <Check className="h-3.5 w-3.5" />
            {t("chat:panel.doneStatus")}
            {status === "done" && formatDuration(durationMs) && (
              <span className="text-muted-foreground/80">
                {" · "}
                {formatDuration(durationMs)}
              </span>
            )}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          <span className="mr-1 text-muted-foreground/80">
            {t("chat:panel.thinkingLabel")}
          </span>
          {thinking ? summarizeThinking(thinking) : ""}
        </span>
        {open ? (
          <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </button>
      {/* 展开区：thinking 全文 + 工具序列，限高内滚 */}
      {open && (
        <div
          className={cn(
            "overflow-y-auto border-t border-border/40 px-3 py-2",
            EXPAND_MAX_HEIGHT,
          )}
        >
          {thinking && (
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
              {thinking}
            </p>
          )}
          {tools.map((tool, index) => (
            <ToolCallCard key={`${index}-${tool.toolName}`} {...tool} />
          ))}
        </div>
      )}
    </div>
  );
}
