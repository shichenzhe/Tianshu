import type { RemoteStreamState } from "./remote-stream";

export interface AgentProgressInfo {
  /** 准备中（发出后尚无任何流式产出） */
  preparing: boolean;
  /** 当前生成轮次 = 流式 tools 条数 + 1（桌面 AgentProgress 同口径） */
  stepCount: number;
  /** 最新 running/awaiting-approval 工具名；无则回复中 */
  activeTool?: string;
}

/** Agent 流式进度派生（MR-T3，桌面 AgentProgress props 派生同构；
 * activeTool 分支 stepCount 口径=桌面 MessageList indexOf+1——运行中
 * 工具在调用序中的位置；无 activeTool 分支才是工具条数+1） */
export function deriveAgentProgress(
  live: RemoteStreamState | null,
): AgentProgressInfo {
  if (live == null) {
    return { preparing: true, stepCount: 1 };
  }
  const hasOutput =
    live.text !== "" || live.thinking !== "" || live.toolOrder.length > 0;
  if (!hasOutput) {
    return { preparing: true, stepCount: 1 };
  }
  const stepCount = live.toolOrder.length + 1;
  for (let i = live.toolOrder.length - 1; i >= 0; i--) {
    const id = live.toolOrder[i];
    const tool = live.tools[id];
    if (
      tool &&
      (tool.state === "running" || tool.state === "awaiting-approval")
    ) {
      return {
        preparing: false,
        stepCount: live.toolOrder.indexOf(id) + 1,
        activeTool: tool.toolName,
      };
    }
  }
  return { preparing: false, stepCount };
}
