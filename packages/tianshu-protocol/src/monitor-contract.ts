// packages/tianshu-protocol/src/monitor-contract.ts
/** A6 批自桌面 monitor.api.ts 收编（单份权威源）。 */

export type MonitorScene = "chat" | "graph" | "automation";

export interface MonitorStats {
  today: {
    inputTokens: number;
    outputTokens: number;
    llmCalls: number;
    toolCalls: number;
    toolSuccessRate: number; // done/(done+denied+error)，分母 0 记 0
  };
  trend: Array<{
    date: string;
    inputTokens: number;
    outputTokens: number;
    llmCalls: number;
    toolCalls: number;
  }>;
  byModel: Array<{
    modelId: number;
    name: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    /**
     * 该模型 7 天窗口累计成本（USD，token/1M × 单价；monitoring §6
     * P1-3）：单价来源 DB 显式价 > 内置目录价；null = 未知价（含
     * graph 场景行——modelId 恒 null 不进 byModel）。可选字段：旧
     * 服务端响应/移动端等既有消费面增量兼容
     */
    cost?: number | null;
  }>;
  tools: Array<{
    toolName: string;
    total: number;
    done: number;
    denied: number;
    error: number;
    avgDurationMs: number | null;
    successRate: number;
  }>;
  /**
   * MCP server 维度聚合（skills-tools-mcp §6 项 8）：toolName 带 mcp__
   * 前缀的调用按 server 段切分聚合；可选字段——旧服务端响应/移动端等
   * 既有消费面不构造该字段，增量兼容（三端共用 computeMonitorStats
   * 产出侧恒在场）
   */
  mcpByServer?: Array<{
    server: string; // mcp__<server>__<tool> 的 server 段
    total: number;
    done: number;
    denied: number;
    error: number;
    avgDurationMs: number | null;
    successRate: number;
  }>;
  /**
   * 7 天窗口累计成本（USD，monitoring §6 P1-3）：byModel 有价行的和
   * （部分计价——未配价模型不计入）；null = 无任何可计价行（未知价，
   * 含 graph 场景 modelId=null 行）。可选字段：旧消费面增量兼容
   */
  totalCost?: number | null;
}
