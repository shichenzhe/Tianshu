/**
 * MCP 服务器配置 API
 */

import { invoke } from "@/lib/ipc";

/** 传输类型：stdio 子进程 / http 流式端点 */
export type McpTransport = "stdio" | "http";

export interface McpServerRecord {
  id: number;
  name: string;
  transport: McpTransport;
  command?: string;
  /** JSON 字符串（如 "[\"--port\",\"8080\"]"），UI 层 parse/stringify */
  args?: string;
  /** JSON 字符串（如 "{\"KEY\":\"value\"}"），UI 层 parse/stringify */
  env?: string;
  url?: string;
  /** JSON 字符串（含 Bearer 等认证头），UI 层 parse/stringify */
  headers?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface McpServerCreateParams {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string;
  env?: string;
  url?: string;
  headers?: string;
  enabled?: boolean;
}

export interface McpServerUpdateParams {
  id: number;
  name?: string;
  transport?: McpTransport;
  /** 可空字段：null 表示清空（undefined = 不修改） */
  command?: string | null;
  args?: string | null;
  env?: string | null;
  url?: string | null;
  headers?: string | null;
  enabled?: boolean;
}

/** 连接状态（与主进程 McpManager.getStatuses 结构对齐） */
export type McpServerState = "connecting" | "connected" | "error" | "disabled";

export interface McpServerStatus {
  id: number;
  name: string;
  state: McpServerState;
  toolCount: number;
  error?: string;
}

export class McpServerApi {
  static async list(): Promise<McpServerRecord[]> {
    return invoke<McpServerRecord[]>("mcpServer:list");
  }

  static async create(params: McpServerCreateParams): Promise<McpServerRecord> {
    return invoke<McpServerRecord>("mcpServer:create", params);
  }

  static async update(params: McpServerUpdateParams): Promise<McpServerRecord> {
    return invoke<McpServerRecord>("mcpServer:update", params);
  }

  static async delete(id: number): Promise<void> {
    return invoke<void>("mcpServer:delete", id);
  }

  static async reconnect(id: number): Promise<void> {
    return invoke<void>("mcpServer:reconnect", id);
  }

  static async setEnabled(id: number, enabled: boolean): Promise<void> {
    return invoke<void>("mcpServer:setEnabled", id, enabled);
  }

  static async statuses(): Promise<McpServerStatus[]> {
    return invoke<McpServerStatus[]>("mcpServer:statuses");
  }
}

export default McpServerApi;
