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
}
