/**
 * Agent 进度细条：流式期间显示于输入区上方（28px），展示当前生成轮次与
 * 活跃工具名（最新一个 running/awaiting-approval 的工具）；无活跃工具时仅
 * 显示「思考中…」。数据由 ChatPane 从 store 派生后以 props 传入
 */
import { memo } from "react";
import { useTranslation } from "react-i18next";

interface AgentProgressProps {
  /** 当前生成轮次 = 流式 tools 条数 + 1 */
  stepCount: number;
  /** 最新一个 running/awaiting-approval 的工具名；无则显示思考中文案 */
  activeTool?: string;
}

function AgentProgressImpl({ stepCount, activeTool }: AgentProgressProps) {
  const { t } = useTranslation(["chat"]);

  return (
    <div className="flex h-7 items-center gap-2 px-4 text-xs text-muted-foreground">
      {activeTool
        ? t("chat:agent.step", { n: stepCount, tool: activeTool })
        : t("chat:agent.working")}
    </div>
  );
}

export default memo(AgentProgressImpl);
