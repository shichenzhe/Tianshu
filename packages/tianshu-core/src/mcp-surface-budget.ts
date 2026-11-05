/** MCP 工具面折叠预算（skills-tools-mcp §6-3 会话级自适应）：
 *  原全局静态线 4000 token（estimateTokens 1token≈2 字符口径）按会话
 *  contextWindow 线性调线——小窗模型更激进折叠（直接工具面挤占对话
 *  空间）、大窗模型保直注体验；注册层静态线（连接时点折叠判定）不
 *  动，本函数供会话装配层消费（折叠判定输入增 modelContextWindow 一维）。
 *  纯函数零依赖三端单源；缺省/非法窗口回落静态线（现行为零漂移）。 */
import { DEFAULT_CONTEXT_WINDOW } from "./param-merge";

/** 预算基准：静态线（注册层折叠判定同值——desktop mcp-manager 消费） */
export const MCP_TOOL_SURFACE_BUDGET_TOKENS = 4000;

/** 自适应下限：小窗不再压缩（低于 1K 连中型 server 都折叠会伤可用性） */
export const MCP_TOOL_SURFACE_BUDGET_MIN_TOKENS = 1000;

/** 自适应上限：大窗也封顶（防直注面无界膨胀挤占输出预算） */
export const MCP_TOOL_SURFACE_BUDGET_MAX_TOKENS = 8000;

/** 窗口→预算线性比值取整；clamp 到 [1000, 8000] */
function scaledBudget(contextWindow: number): number {
  const ratio = contextWindow / DEFAULT_CONTEXT_WINDOW;
  return Math.round(MCP_TOOL_SURFACE_BUDGET_TOKENS * ratio);
}

/**
 * 会话级折叠预算线：按 contextWindow 线性缩放基准线并 clamp。
 * - 128K（DEFAULT_CONTEXT_WINDOW）→ 4000（与静态线重合，行为零漂移）；
 * - 32K → 1000（激进折叠）；≥262K → 8000（封顶）；
 * - null/undefined/非正/非有限 → 4000（静态线回落）。
 */
export function surfaceBudgetFor(
  modelContextWindow: number | null | undefined,
): number {
  if (
    modelContextWindow == null ||
    !Number.isFinite(modelContextWindow) ||
    modelContextWindow <= 0
  ) {
    return MCP_TOOL_SURFACE_BUDGET_TOKENS;
  }
  return Math.min(
    MCP_TOOL_SURFACE_BUDGET_MAX_TOKENS,
    Math.max(MCP_TOOL_SURFACE_BUDGET_MIN_TOKENS, scaledBudget(modelContextWindow)),
  );
}
