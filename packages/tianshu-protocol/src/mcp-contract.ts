// packages/tianshu-protocol/src/mcp-contract.ts
/** A4 批收编：MCP 运行态/写面契约（单份权威源）。
 *  写面 v1 仅 HTTP transport——stdio command/args 是被控宿主机进程执行面，
 *  移动端只读摘要（name/transport/enabled/status），不可创建/编辑参数。
 *  headers/env 掩码三态复用 REDACTED_SECRET（A1 fail-closed 语义）：
 *  undefined 保留 / null 清除 / 含掩码按未传。 */

/** 运行态（mcp/statuses——McpManager 共享池按用户可见 id 过滤） */
export interface McpStatusItemDto {
  id: number;
  name: string;
  state: string;
  toolCount: number;
  error?: string;
}

/** HTTP 单条 upsert：无 id 新建 / 有 id 更；url 必须 http(s)；
 *  headers 三态同上注释；stdio 类型的 save 由服务端拒绝（MCP_STDIO_FORBIDDEN） */
export interface McpSavePayload {
  id?: number;
  name: string;
  url: string;
  headers?: Record<string, string> | null;
  enabled?: boolean;
}

/** 详情读面（mcp/detail）：headers/env 恒掩码（有值回 REDACTED 占位）；
 *  args 仅 HTTP 类型回传（恒为空数组语义）；stdio 类型只回摘要字段 */
export interface McpDetailResult {
  id: number;
  name: string;
  transport: string;
  command: string | null;
  url: string | null;
  enabled: boolean;
  args: string[];
  env: Record<string, string>;
  headers: Record<string, string>;
}

export const MCP_ERROR_CODES = [
  "MCP_NOT_FOUND",
  "MCP_INVALID",
  "MCP_STDIO_FORBIDDEN",
] as const;
export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];
