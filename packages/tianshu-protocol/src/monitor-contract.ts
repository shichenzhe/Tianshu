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
}
