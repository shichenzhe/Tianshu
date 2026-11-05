/**
 * MCP 服务器生命周期管理与工具注册（P2）：
 * 连接 → listTools → 以 `mcp__<server>__<tool>` 前缀注册进 tool-registry。
 * 工具面预算折叠（2026-11-01，spec
 * docs/superpowers/specs/2026-11-01-mcp-tool-surface-budget.md）：单 server
 * 直接工具面超预算时折叠为 list_tools/call_tool 两聚合工具——引擎
 * （langgraph）工具集静态绑定不支持动态挂载，defer 必须在注册层完成。
 * prisma 与 client 工厂全部依赖注入；SDK 仅在本文件的生产工厂触碰，
 * 传递依赖 Log（→ electron）在单测经 vi.mock 替换（仓库既有模式）。
 */
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  estimateTokens,
  surfaceBudgetFor,
  MCP_TOOL_SURFACE_BUDGET_TOKENS,
} from "@tianshu/core";
import type { ToolDefinition } from "./file-tools";
import { registerTools, unregisterTools } from "./tool-registry";
import { getNetworkGate } from "../../security/network-gate";
import type { NetworkVerdict } from "../../security/domain-policy";
import Log from "../../../commons/Log";
import { errorMessageWithCause } from "../../../commons/error-message-with-cause";

/**
 * 单 server 工具面注入预算——静态线（core 单源；会话级自适应线见
 * surfaceBudgetFor）：注册层折叠判定（connect 时点）消费本静态线；
 * 会话装配层（chat.service collectToolDefinitions）按会话 contextWindow
 * 经 adaptiveDefinitions 动态调线——小窗激进折叠、大窗保直注
 * （skills-tools-mcp §6-3：注册逻辑不动，折叠判定输入增
 * modelContextWindow 一维）
 */
export { MCP_TOOL_SURFACE_BUDGET_TOKENS };

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
  /** 工具面超预算已折叠（聚合两跳注入；toolCount 仍为元数据工具数） */
  deferred: boolean;
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
  deferred: boolean;
  error?: string;
  /**
   * 连接代际：connect 开始与 setEnabled(false) 各自递增；挂起的 connect 在
   * await 恢复后核对代际，不符即整体丢弃结果（I1 竞态守卫）
   */
  generation: number;
  /** 直接工具面 token 估值（estimateTokens，会话级自适应折叠判定输入） */
  surfaceTokens: number;
  /** 直接工具面留存（自适应折叠的直注分支与 unfold 复用；连接成功后非空数组） */
  directDefs: ToolDefinition[];
  /** listTools 原始目录（自适应折叠的聚合分支按需重建两跳工具） */
  mcpTools: Array<
    Awaited<ReturnType<McpClientLike["listTools"]>>["tools"][number]
  >;
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

/**
 * MCP http 入口预判（SP5 spec §6）：deny 抛错（含 host 与规则，回喂状态机
 * error 文案）——SDK transport 构造之前拦截，未装门或缺省 url 零行为；
 * 判定本身抛错视为放行 + winston error（spec §9，终审 S2——生产注入
 * judgeUrl 为 total 函数，缺口仅测试注入面可达）
 */
export function assertMcpUrlAllowed(
  row: McpServerConfig,
  checkUrl?: (url: string) => NetworkVerdict,
): void {
  if (row.transport !== "http" || !row.url) return;
  const verdict = safeCheckUrl(row.url, checkUrl);
  if (!verdict.ok) {
    getNetworkGate()?.blockedAudit(verdict.host, verdict.rule, "mcp");
    throw new Error(
      `网络安全策略已拒绝 ${verdict.host}（规则：${verdict.rule}）`,
    );
  }
}

/** 判定抛错 → 放行 + winston error（fail-open）；日志只收字符串防二次抛错 */
function safeCheckUrl(
  url: string,
  checkUrl?: (url: string) => NetworkVerdict,
): NetworkVerdict {
  const viaGate = (): NetworkVerdict =>
    getNetworkGate()?.judgeUrl(url) ?? { ok: true };
  try {
    return (checkUrl ?? viaGate)(url);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    Log.error(`MCP url 预判异常，视为放行 url=${url} reason=${reason}`);
    return { ok: true };
  }
}

/** stdio 子进程 env（SP5）：合并 proxy 注入（门未装/代理未启动原样返回） */
export function mergeStdioEnv(
  row: McpServerConfig,
): Record<string, string> | undefined {
  const proxyEnv = getNetworkGate()?.childProxyEnv();
  return proxyEnv ? { ...row.env, ...proxyEnv } : row.env;
}

/** 生产 client 工厂：SDK 唯一 import/构造点（其余仅依赖 McpClientLike） */
export async function createDefaultClient(
  row: McpServerConfig,
): Promise<McpClientLike> {
  let transport: StdioClientTransport | StreamableHTTPClientTransport;
  if (row.transport === "http") {
    if (!row.url) throw new Error(`MCP 服务 ${row.name} 缺少 url`);
    assertMcpUrlAllowed(row);
    transport = new StreamableHTTPClientTransport(new URL(row.url), {
      requestInit: { headers: row.headers ?? {} },
    });
  } else {
    if (!row.command) throw new Error(`MCP 服务 ${row.name} 缺少 command`);
    transport = new StdioClientTransport({
      command: row.command,
      args: row.args,
      env: mergeStdioEnv(row),
    });
  }
  const client = new Client({ name: "tianshu", version: "1.0.0" });
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

/** call_tool 聚合工具参数（zod infer 驱动 execute 的 args 类型） */
const callToolArgsSchema = z.object({
  tool: z.string().describe("工具名（来自 list_tools 返回目录）"),
  arguments: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("工具参数对象（按 list_tools 返回的参数 Schema 构造）"),
});

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
   * 本次结果——不注册、不改状态，并尽力关闭新建的 client（I1 竞态守卫）；
   * catch 路径对已创建的半成品 client（listTools 等后续步骤失败）同样尽力关闭
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
    let client: McpClientLike | undefined;
    try {
      client = await this.deps.createClient(row);
      const tools = (await client.listTools()).tools ?? [];
      if (this.isSuperseded(record, myGeneration)) {
        await closeQuietly(client);
        return;
      }
      // const 快照：let 在 map 回调闭包中收窄失效，以窄化后的 const 传入注册
      const connected = client;
      const defs = tools.map((tool) => this.toDefinition(row, connected, tool));
      // 工具面预算折叠：超线不注册直接工具（schema 不常驻每会话），
      // 改挂 list_tools/call_tool 两聚合工具（spec §1）；线内零行为变化。
      // 会话级自适应批（§6-3）：直接面/目录/估值留存于 record，供
      // adaptiveDefinitions 按会话 contextWindow 动态折叠/直注（注册层不动）
      const surfaceTokens = estimateTokens(JSON.stringify(defs));
      const deferred = surfaceTokens > MCP_TOOL_SURFACE_BUDGET_TOKENS;
      registerTools(
        deferred ? this.toAggregateTools(row, connected, tools) : defs,
      );
      record.client = connected;
      record.state = "connected";
      record.toolCount = defs.length;
      record.deferred = deferred;
      record.surfaceTokens = surfaceTokens;
      record.directDefs = defs;
      record.mcpTools = tools;
    } catch (e) {
      // 半成品 client（createClient 成功但后续失败）不留活连接
      if (client) {
        await closeQuietly(client);
      }
      // 过期连接的失败不得覆盖接管者（新一轮 connect/停用）已写入的状态
      if (this.isSuperseded(record, myGeneration)) {
        return;
      }
      record.client = undefined;
      record.state = "error";
      record.toolCount = 0;
      record.deferred = false;
      record.surfaceTokens = 0;
      record.directDefs = [];
      record.mcpTools = [];
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
   * 按旧名清理：server 改名时旧前缀工具不再被 connect/setEnabled 触达，
   * 由 repo.update 改名钩子显式调用（注销旧前缀 + 尽力关闭旧 client）。
   * 代际同步前移：挂起中的旧 connect 恢复后经 isSuperseded 作废，
   * 不复活刚清理的旧前缀（同 setEnabled(false) 的守卫语义）
   */
  unregisterByName(serverName: string): void {
    unregisterTools(toolPrefix(serverName));
    for (const record of this.records.values()) {
      if (record.row.name === serverName) {
        record.generation++;
        const client = record.client;
        record.client = undefined;
        record.toolCount = 0;
        record.deferred = false;
        record.surfaceTokens = 0;
        record.directDefs = [];
        record.mcpTools = [];
        record.state = client ? "error" : record.state;
        if (client) {
          void closeQuietly(client);
        }
      }
    }
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
    record.deferred = false;
    record.surfaceTokens = 0;
    record.directDefs = [];
    record.mcpTools = [];
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
      deferred: record.deferred,
      error: record.error,
    }));
  }

  private ensureRecord(row: McpServerConfig): ServerRecord {
    let record = this.records.get(row.id);
    if (!record) {
      record = {
        row,
        state: "connecting",
        toolCount: 0,
        deferred: false,
        generation: 0,
        surfaceTokens: 0,
        directDefs: [],
        mcpTools: [],
      };
      this.records.set(row.id, record);
    }
    record.row = row;
    return record;
  }

  /**
   * 会话级自适应折叠面（skills-tools-mcp §6-3，chat.service 每 send 消费）：
   * 按会话 contextWindow 经 core surfaceBudgetFor 动态调线——小窗激进折叠
   * （超线 server 换 list_tools/call_tool 两聚合）、大窗保直注（静态线外
   * 的 server 直注）。窗口缺席/非法回落静态线（与注册层判定一致，行为零
   * 漂移）；仅 connected 态记录参与（connecting/error/disabled 无工具面）。
   * 注册层（全局 registry）不动——graph/automation 等其余消费面维持静态线
   */
  adaptiveDefinitions(modelContextWindow?: number | null): ToolDefinition[] {
    const budget = surfaceBudgetFor(modelContextWindow);
    const defs: ToolDefinition[] = [];
    for (const record of this.records.values()) {
      if (record.state !== "connected" || !record.client) continue;
      // 预算线只看 surfaceTokens（注册层 deferred 位不参与——大窗时
      // 静态线折叠的 server 可 unfold 直注，小窗时静态线内 server 也可折叠）
      defs.push(
        ...(record.surfaceTokens <= budget
          ? record.directDefs
          : this.toAggregateTools(record.row, record.client, record.mcpTools)),
      );
    }
    return defs;
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

  /**
   * 超预算 server 的聚合两跳工具组（spec §1 项 2）：list_tools 返回全工具
   * 目录（schema 仅在模型查询时进上下文），call_tool 按目录转发——
   * 专家目录出 system 批同构的渐进披露。call_tool kind 恒 write：
   * 目标工具只读性运行时未知，保守走审批（readOnlyHint 缺失时直接注册
   * 本就按 write，语义等价）
   */
  private toAggregateTools(
    row: McpServerConfig,
    client: McpClientLike,
    tools: Array<Awaited<ReturnType<McpClientLike["listTools"]>>["tools"][number]>,
  ): ToolDefinition<z.infer<typeof callToolArgsSchema>>[] {
    const callName = `${toolPrefix(row.name)}call_tool`;
    const listing = tools
      .map(
        (tool) =>
          `${tool.name}\n描述: ${tool.description ?? "(无)"}\n参数 Schema: ${JSON.stringify(tool.inputSchema ?? { type: "object" })}`,
      )
      .join("\n\n");
    return [
      {
        name: `${toolPrefix(row.name)}list_tools`,
        description:
          `查看 MCP 服务 ${row.name} 的 ${tools.length} 个工具清单（含各工具参数` +
          ` JSON Schema），按需选择后用 ${callName} 调用（该服务工具面较大，` +
          "已按需展开）",
        parameters: z.object({}),
        kind: "read",
        execute: async () => listing,
      },
      {
        name: callName,
        description:
          `调用 MCP 服务 ${row.name} 的工具（tool 取 list_tools 返回的工具名，` +
          "arguments 按该工具的参数 Schema 构造）",
        parameters: callToolArgsSchema,
        kind: "write",
        execute: (_ctx, args) => {
          if (!tools.some((tool) => tool.name === args.tool)) {
            return Promise.resolve(
              `错误: 工具 ${args.tool} 不在 ${row.name} 目录中，请先调用 list_tools 获取目录`,
            );
          }
          return this.callTool(row, client, args.tool, args.arguments);
        },
      },
    ];
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
    } catch (e) {
      return `错误: MCP 服务不可用（${row.name}）：${errorMessageWithCause(e)}`;
    }
  }
}

/**
 * 会话级自适应折叠源（模块级单例，commandGate install 先例）：
 * Application 装配 McpManager 后 install；chat.service
 * collectToolDefinitions 经 mcpAdaptiveDefinitions 消费（装配晚于
 * ChatService 构造，install 只需先于首个 send）。未安装（测试/局部
 * 构造）返回空数组——chat 链 MCP 面回落 registry 静态线，行为不变
 */
let adaptiveSource: McpManager | null = null;

export function installMcpAdaptiveSource(manager: McpManager | null): void {
  adaptiveSource = manager;
}

/** 自适应源是否已装配（chat 链据此切换 MCP 面来源——未装配回落 registry） */
export function mcpAdaptiveSourceInstalled(): boolean {
  return adaptiveSource !== null;
}

/** 当前自适应 MCP 工具面（含全部 connected server；窗口缺席=静态线） */
export function mcpAdaptiveDefinitions(
  modelContextWindow?: number | null,
): ToolDefinition[] {
  return adaptiveSource?.adaptiveDefinitions(modelContextWindow) ?? [];
}
