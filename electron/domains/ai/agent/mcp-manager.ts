/**
 * MCP 服务器生命周期管理与工具注册（P2）：
 * 连接 → listTools → 以 `mcp__<server>__<tool>` 前缀注册进 tool-registry。
 * prisma 与 client 工厂全部依赖注入，可零 mock 测试；SDK 仅在本文件的生产工厂触碰。
 */
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolDefinition } from "./file-tools";
import { registerTools, unregisterTools } from "./tool-registry";

export interface McpServerConfig {
  id: number;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** prisma mcpServer 行（JSON 列为字符串，由 parseMcpRow 解析为 McpServerConfig） */
export interface McpServerRow {
  id: number;
  name: string;
  transport: string;
  command?: string | null;
  args?: string | null;
  env?: string | null;
  url?: string | null;
  headers?: string | null;
  enabled?: boolean;
}

/** 对 MCP Client 的最小结构约束（生产为 SDK Client，测试为 fake） */
export interface McpClientLike {
  listTools(): Promise<{
    tools: Array<{
      name: string;
      description?: string;
      inputSchema?: unknown;
      annotations?: { readOnlyHint?: boolean };
    }>;
  }>;
  callTool(args: {
    name: string;
    arguments?: unknown;
  }): Promise<{ content?: Array<{ type: string; text?: string }> }>;
  close(): Promise<void>;
}

export type McpServerState = "connecting" | "connected" | "error" | "disabled";

export interface McpServerStatus {
  id: number;
  name: string;
  state: McpServerState;
  toolCount: number;
  error?: string;
}

interface McpManagerDeps {
  createClient: (row: McpServerConfig) => Promise<McpClientLike>;
  prisma: { mcpServer: { findMany(): Promise<McpServerConfig[]> } };
}

interface ServerRecord {
  row: McpServerConfig;
  state: McpServerState;
  client?: McpClientLike;
  toolCount: number;
  error?: string;
  /**
   * 连接代际：connect 开始与 setEnabled(false) 各自递增；挂起的 connect 在
   * await 恢复后核对代际，不符即整体丢弃结果（I1 竞态守卫）
   */
  generation: number;
}

/** 服务器内工具的统一前缀 */
const toolPrefix = (serverName: string): string => `mcp__${serverName}__`;

/** JSON 字符串列解析，非法 JSON 容错为 undefined */
function parseJsonField<T>(raw: string | null | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** prisma 行 → manager 配置（T6 repo 复用本函数） */
export function parseMcpRow(row: McpServerRow): McpServerConfig {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport === "http" ? "http" : "stdio",
    command: row.command ?? undefined,
    args: parseJsonField<string[]>(row.args),
    env: parseJsonField<Record<string, string>>(row.env),
    url: row.url ?? undefined,
    headers: parseJsonField<Record<string, string>>(row.headers),
  };
}

/** 生产 client 工厂：SDK 唯一 import/构造点（其余仅依赖 McpClientLike） */
export async function createDefaultClient(
  row: McpServerConfig,
): Promise<McpClientLike> {
  let transport: StdioClientTransport | StreamableHTTPClientTransport;
  if (row.transport === "http") {
    if (!row.url) throw new Error(`MCP 服务 ${row.name} 缺少 url`);
    transport = new StreamableHTTPClientTransport(new URL(row.url), {
      requestInit: { headers: row.headers ?? {} },
    });
  } else {
    if (!row.command) throw new Error(`MCP 服务 ${row.name} 缺少 command`);
    transport = new StdioClientTransport({
      command: row.command,
      args: row.args,
      env: row.env,
    });
  }
  const client = new Client({ name: "mirror", version: "1.0.0" });
  await client.connect(transport);
  // SDK callTool 返回联合含 task 变体（无 content 字段），弱类型结构检查拒绝；
  // 常规工具调用结果必有 content，manager 仅读取 content，故此处断言收窄
  return client as McpClientLike;
}

/** 尽力关闭：close 失败静默——清理路径不得打断状态机与主流程 */
async function closeQuietly(client: McpClientLike): Promise<void> {
  try {
    await client.close();
  } catch {
    // 断开失败不影响本地状态
  }
}

export class McpManager {
  private readonly deps: McpManagerDeps;
  private readonly records = new Map<number, ServerRecord>();

  constructor(deps: McpManagerDeps) {
    this.deps = deps;
  }

  /** 查 enabled 行逐个连接；单个失败记 error 状态，不抛出 */
  async startupConnectAll(): Promise<void> {
    const rows = await this.deps.prisma.mcpServer.findMany();
    for (const row of rows) await this.connect(row);
  }

  /**
   * 连接并注册工具；重连前注销旧工具并尽力关闭旧连接（I2 泄漏修复）；
   * 失败记 error 状态，不抛出。挂起期间发生重连/停用（代际失效）则整体丢弃
   * 本次结果——不注册、不改状态，并尽力关闭新建的 client（I1 竞态守卫）
   */
  async connect(row: McpServerConfig): Promise<void> {
    const record = this.ensureRecord(row);
    const myGeneration = ++record.generation;
    record.state = "connecting";
    record.error = undefined;
    const previousClient = record.client;
    record.client = undefined;
    unregisterTools(toolPrefix(row.name));
    if (previousClient) {
      await closeQuietly(previousClient);
    }
    try {
      const client = await this.deps.createClient(row);
      const tools = (await client.listTools()).tools ?? [];
      if (this.isSuperseded(record, myGeneration)) {
        await closeQuietly(client);
        return;
      }
      const defs = tools.map((tool) => this.toDefinition(row, client, tool));
      registerTools(defs);
      record.client = client;
      record.state = "connected";
      record.toolCount = defs.length;
    } catch (e) {
      // 过期连接的失败不得覆盖接管者（新一轮 connect/停用）已写入的状态
      if (this.isSuperseded(record, myGeneration)) {
        return;
      }
      record.client = undefined;
      record.state = "error";
      record.toolCount = 0;
      record.error = e instanceof Error ? e.message : String(e);
    }
  }

  /** 本次连接已过期：期间发生新一轮 connect（代际前移）或已停用 */
  private isSuperseded(record: ServerRecord, myGeneration: number): boolean {
    return record.generation !== myGeneration || record.state === "disabled";
  }

  /** connect 的别名（语义：先清旧再连） */
  async reconnect(row: McpServerConfig): Promise<void> {
    return this.connect(row);
  }

  /**
   * 停用：代际前移使挂起中的 connect 结果作废，注销工具并断开；启用：重新连接
   */
  async setEnabled(row: McpServerConfig, enabled: boolean): Promise<void> {
    if (enabled) return this.connect(row);
    const record = this.ensureRecord(row);
    record.generation++;
    unregisterTools(toolPrefix(row.name));
    const client = record.client;
    record.client = undefined;
    record.state = "disabled";
    record.toolCount = 0;
    record.error = undefined;
    if (client) {
      await closeQuietly(client);
    }
  }

  getStatuses(): McpServerStatus[] {
    return [...this.records.values()].map((record) => ({
      id: record.row.id,
      name: record.row.name,
      state: record.state,
      toolCount: record.toolCount,
      error: record.error,
    }));
  }

  private ensureRecord(row: McpServerConfig): ServerRecord {
    let record = this.records.get(row.id);
    if (!record) {
      record = { row, state: "connecting", toolCount: 0, generation: 0 };
      this.records.set(row.id, record);
    }
    record.row = row;
    return record;
  }

  private toDefinition(
    row: McpServerConfig,
    client: McpClientLike,
    tool: Awaited<ReturnType<McpClientLike["listTools"]>>["tools"][number],
  ): ToolDefinition {
    return {
      name: `${toolPrefix(row.name)}${tool.name}`,
      description: tool.description ?? `MCP 工具 ${tool.name}`,
      // MCP 的 inputSchema 为 JSON Schema 对象，直接透传（类型已放宽）
      parameters: (tool.inputSchema as object | undefined) ?? z.object({}),
      kind: tool.annotations?.readOnlyHint === true ? "read" : "write",
      execute: (_ctx, args) => this.callTool(row, client, tool.name, args),
    };
  }

  /** 任何抛错（含断连）统一转为错误文案回喂模型，不向 agent-loop 抛出 */
  private async callTool(
    row: McpServerConfig,
    client: McpClientLike,
    toolName: string,
    args: unknown,
  ): Promise<string> {
    try {
      const result = await client.callTool({ name: toolName, arguments: args });
      const texts = (result.content ?? [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string);
      return texts.length > 0 ? texts.join("\n") : "(无输出)";
    } catch {
      return `错误: MCP 服务不可用（${row.name}）`;
    }
  }
}
