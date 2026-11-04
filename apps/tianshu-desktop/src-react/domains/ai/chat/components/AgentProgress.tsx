/**
 * Agent 流式状态行：流式期间显示于消息流内底部（liveMessage 之后，
 * WorkBuddy conversation-streaming-footer 同位）——头像 + 状态文字，
 * 与 assistant 消息头像列对齐。两档渐变扫光文字（WorkBuddy ShiningText
 * 同形态，样式见 globals.css .agent-shimmer-text）：「准备中」（发出后
 * 尚无任何流式产出）与「回复中」（已有产出但无活跃工具）；有活跃工具
 * 时展示当前生成轮次与工具名。store 派生由 MessageList 完成后以 props
 * 传入（本组件保持纯展示可单测）
 */
import { memo } from "react";
import { useTranslation } from "react-i18next";
import AssistantAvatar from "./AssistantAvatar";

interface AgentProgressProps {
  /** 当前生成轮次 = 流式 tools 条数 + 1 */
  stepCount: number;
  /** 最新一个 running/awaiting-approval 的工具名；无则显示扫光文字 */
  activeTool?: string;
  /** 准备中（尚无任何流式产出）：显示「准备中」，否则无工具时「回复中」 */
  preparing?: boolean;
  /** 会话当前专家 icon（emoji，头像列展示） */
  assistantIcon?: string;
}

function AgentProgressImpl({
  stepCount,
  activeTool,
  preparing = false,
  assistantIcon,
}: AgentProgressProps) {
  const { t } = useTranslation(["chat"]);

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <AssistantAvatar icon={assistantIcon} />
      <div className="flex min-h-7 items-center text-xs text-muted-foreground">
        {activeTool ? (
          t("chat:agent.step", { n: stepCount, tool: activeTool })
        ) : (
          <span data-testid="agent-shimmer" className="agent-shimmer-text">
            {preparing ? t("chat:agent.preparing") : t("chat:agent.replying")}
          </span>
        )}
      </div>
    </div>
  );
}

export default memo(AgentProgressImpl);
