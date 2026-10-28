// electron/domains/ai/orchestration/create-workflow.ts
/**
 * create_workflow / list_workflows 内置工具（AI 聊天建工作流）：模型按
 * workflow-creator 技能规范生成 graphJson，经 create_workflow 落库（kind
 * write → 统一审批）；校验复用前后端共享的 validateGraph——结构化问题
 * （带节点定位）回传给模型自纠重试。list_workflows 供 iterate/subflow
 * 引用已有图时查真实 graphId。纯 Node（禁 import electron），prisma 注入
 * 可测；userId 经 ctx.sessionId 反查 session（工具上下文无 userId）。
 * create/update 落库成功经注入的 notify 广播 graphs-changed（渲染层
 * 列表缓存失效——工具写库绕过 IPC CRUD 的调用方 invalidate 链路）。
 */
import { z } from "zod";
import {
  normalizeGraph,
  validateGraph,
} from "../../../../src-react/domains/ai/orchestration/api/graph.schema";
import type { ToolContext, ToolDefinition } from "../agent/file-tools";
import { graphTestInflight } from "./graph-inflight";

/** 图仓储子集（测试注入内存 stub） */
export interface WorkflowGraphRow {
  id: number;
  name: string;
  description: string | null;
  graphJson: string;
  version: number;
  enabled?: boolean;
}

export interface WorkflowGraphPrismaLike {
  create(args: {
    data: {
      name: string;
      description: string | null;
      graphJson: string;
      userId: number;
    };
  }): Promise<{ id: number; name: string }>;
  findMany(args?: {
    where?: { userId: number };
    orderBy?: { createdAt: string };
  }): Promise<
    Array<{
      id: number;
      name: string;
      description: string | null;
      nodeCount?: number;
    }>
  >;
  /** get/update/run 共用：按 id + userId 取图（含 version/graphJson） */
  findFirst(args: {
    where: { id: number; userId: number };
  }): Promise<WorkflowGraphRow | null>;
  /** update 乐观锁：where 带 version，count=0 即冲突或不存在 */
  updateMany(args: {
    where: { id: number; userId: number; version: number };
    data: {
      name?: string;
      description?: string | null;
      graphJson?: string;
      version?: number;
    };
  }): Promise<{ count: number }>;
}

/** workspace 反查（run_workflow 定位会话归属空间） */
export interface WorkspacePrismaLike {
  findFirst(args: {
    where: { directoryPath: string; userId: number };
  }): Promise<{ id: number; directoryPath: string | null } | null>;
}

export interface SessionPrismaLike {
  findUnique(args: {
    where: { id: number };
  }): Promise<{ userId: number; appId?: number | null } | null>;
}

/** appDefinition 查询注入（会话应用作用域，切片 C 2026-10-29）：graphIds
 *  为 JSON 数组字符串（最小形态不做关联表） */
export interface AppDefinitionPrismaLike {
  findFirst(args: {
    where: { id: number; userId: number };
  }): Promise<{ id: number; name: string; graphIds: string } | null>;
  update(args: {
    where: { id: number };
    data: { graphIds: string };
  }): Promise<unknown>;
}

/** 会话应用作用域解析结果：dangling = 绑定存在但应用行已删（悬空按
 *  未作用域处理，回执注记提示重绑） */
export interface SessionAppScope {
  appId: number;
  name: string;
  graphIds: Set<number>;
  dangling: boolean;
}

/**
 * 会话应用作用域（切片 C P1）：run/list/create_workflow 的可见集合在此
 * 收窄——比 filterToolsBySession（纯函数、按工具名）更顺的层次是工具
 * execute 内按会话 appId 做数据级过滤（作用域是数据语义）。未绑定 →
 * null（全量，零行为变化）；应用行缺失 → dangling 提示态
 */
export async function resolveSessionAppScope(
  ctx: { sessionId: number | null },
  session: SessionPrismaLike,
  app: AppDefinitionPrismaLike | undefined,
  userId: number,
): Promise<SessionAppScope | null> {
  if (ctx.sessionId === null || !app) {
    return null;
  }
  const row = await session.findUnique({ where: { id: ctx.sessionId } });
  const appId = row?.appId ?? null;
  if (appId === null) {
    return null;
  }
  const def = await app.findFirst({ where: { id: appId, userId } });
  if (!def) {
    return { appId, name: "", graphIds: new Set(), dangling: true };
  }
  let ids: number[] = [];
  try {
    const parsed: unknown = JSON.parse(def.graphIds);
    if (Array.isArray(parsed)) {
      ids = parsed.filter((v): v is number => Number.isInteger(v));
    }
  } catch {
    // 非法 JSON 容错为空集（应用面可修复）
  }
  return {
    appId,
    name: def.name,
    graphIds: new Set(ids),
    dangling: false,
  };
}

const createWorkflowSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .describe("工作流名称（用户可读，同名会冲突）"),
  description: z
    .string()
    .max(500)
    .optional()
    .describe("一句话用途说明（可省略）"),
  graphJson: z
    .object({})
    .passthrough()
    .describe("图定义对象（节点与连线规范见 workflow-creator 技能）"),
});

const listWorkflowsSchema = z.object({}).describe("无参数");

/** 结构化校验问题 → 供模型修正的文本（错误码 + 定位） */
function formatIssues(
  issues: Array<{ code: string; params?: Record<string, string | number> }>,
): string {
  return issues
    .map((issue) => {
      const detail = issue.params
        ? ` ${Object.entries(issue.params)
            .map(([key, value]) => `${key}=${value}`)
            .join(" ")}`
        : "";
      return `- ${issue.code}${detail}`;
    })
    .join("\n");
}

/** sessionId → userId（工具上下文无 userId，经会话反查；图执行无会话
 *  sessionId null 返回 null——工具回「会话不存在」正确降级）。confirm_form
 *  工具同语义复用（切片 B），导出共用 */
export async function userIdOf(
  ctx: ToolContext,
  session: SessionPrismaLike,
): Promise<number | null> {
  if (ctx.sessionId === null) return null;
  const row = await session.findUnique({ where: { id: ctx.sessionId } });
  return row?.userId ?? null;
}

export function makeCreateWorkflowTool(deps: {
  graphDefinition: WorkflowGraphPrismaLike;
  session: SessionPrismaLike;
  /** 会话应用作用域（切片 C）：应用会话内新建的图自动入应用集合 */
  app?: AppDefinitionPrismaLike;
  /** 写库成功后通知（repo 注 notifyGraphsChanged 广播渲染层失效——
   *  全局 staleTime 30s 失效驱动，工具写库无此广播则列表页 30s 内
   *  不见新图；纯 Node 禁 electron 故经注入） */
  notify?: () => void;
}): ToolDefinition<z.infer<typeof createWorkflowSchema>> {
  return {
    name: "create_workflow",
    description:
      "创建并保存新工作流（校验失败返回问题清单；应用会话内创建会自动加入该应用）；写操作需批准",
    parameters: createWorkflowSchema,
    kind: "write",
    execute: async (ctx, args) => {
      const userId = await userIdOf(ctx, deps.session);
      if (userId === null) {
        return "错误: 会话不存在，无法确定当前用户";
      }
      const result = validateGraph(args.graphJson);
      if (!result.ok) {
        // 校验失败是渐进披露位：节点规范指引（原在描述里）挪到此处
        return `校验未通过，请修正 graphJson 后重试（节点规范可 read_skill 读取 workflow-creator 技能）：\n${formatIssues(result.issues)}`;
      }
      try {
        const row = await deps.graphDefinition.create({
          data: {
            name: args.name,
            description: args.description ?? null,
            // 模型按技能生成 graphJson 常省略"无执行语义"的 start 节点、
            // 末节点漏连 END，落库前归一补齐（画布「开始/END」不断头）
            graphJson: JSON.stringify(normalizeGraph(result.value)),
            userId,
          },
        });
        // 应用会话内新建 → 自动入应用集合（切片 C 作用域闭环：create 的
        // 图立即可被本会话 run/list 看见）；悬空绑定不入集（应用已删）
        const scope = await resolveSessionAppScope(
          ctx,
          deps.session,
          deps.app,
          userId,
        );
        let appNote = "";
        if (scope && !scope.dangling) {
          scope.graphIds.add(row.id);
          await deps.app?.update({
            where: { id: scope.appId },
            data: { graphIds: JSON.stringify([...scope.graphIds]) },
          });
          appNote = `；已加入应用「${scope.name}」`;
        }
        deps.notify?.();
        return `成功: 工作流「${row.name}」已创建（id=${row.id}），可在左侧「工作流」页面查看与编辑${appNote}`;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.includes("UNIQUE")) {
          return `错误: 工作流「${args.name}」已存在，请换个名称`;
        }
        return `错误: 创建失败 ${message}`;
      }
    },
  };
}

export function makeListWorkflowsTool(deps: {
  graphDefinition: WorkflowGraphPrismaLike;
  session: SessionPrismaLike;
  /** 会话应用作用域（切片 C）：应用会话内仅列该应用的工作流 */
  app?: AppDefinitionPrismaLike;
}): ToolDefinition<Record<string, never>> {
  return {
    name: "list_workflows",
    description:
      "列出已保存工作流（应用会话内仅该应用的工作流）；子图引用须用真实 id",
    parameters: listWorkflowsSchema,
    kind: "read",
    execute: async (ctx) => {
      const userId = await userIdOf(ctx, deps.session);
      if (userId === null) {
        return "错误: 会话不存在，无法确定当前用户";
      }
      const rows = await deps.graphDefinition.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
      });
      const scope = await resolveSessionAppScope(
        ctx,
        deps.session,
        deps.app,
        userId,
      );
      // 作用域收窄：仅应用集合内的图；悬空绑定按全量回退并注记（应用
      // 已删，提示用户重绑）——LLM 经回执感知作用域
      const visible =
        scope && !scope.dangling
          ? rows.filter((row) => scope.graphIds.has(row.id))
          : rows;
      if (visible.length === 0) {
        return scope && !scope.dangling
          ? `当前会话已绑定应用「${scope.name}」，其中暂无工作流`
          : "暂无已保存的工作流";
      }
      const listing = visible
        .map(
          (row) =>
            `id=${row.id} ${row.name}${row.description ? ` — ${row.description}` : ""}`,
        )
        .join("\n");
      if (scope && !scope.dangling) {
        return `当前会话已绑定应用「${scope.name}」，仅列出该应用的工作流：\n${listing}`;
      }
      if (scope?.dangling) {
        return `${listing}\n（注：会话绑定的应用已不存在，暂列全部工作流，可让用户重新绑定）`;
      }
      return listing;
    },
  };
}

/** 试运行发射器注入（run_workflow 用；repo 的 launchTestRun 包装，
 * fire-and-forget；测试注 stub 免拉 executor 重依赖） */
export type LaunchTestRunFn = (params: {
  graph: WorkflowGraphRow;
  inputs: Record<string, string>;
  workspace: { id: number; directoryPath: string | null };
}) => void;

const getWorkflowSchema = z.object({
  id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("工作流 id（与 name 二选一）"),
  name: z
    .string()
    .min(1)
    .optional()
    .describe("工作流名称（与 id 二选一，重名时用 id）"),
});

export function makeGetWorkflowTool(deps: {
  graphDefinition: WorkflowGraphPrismaLike;
  session: SessionPrismaLike;
}): ToolDefinition<z.infer<typeof getWorkflowSchema>> {
  return {
    name: "get_workflow",
    description: "读取工作流完整定义；修改前必先调用取 version（乐观锁）",
    parameters: getWorkflowSchema,
    kind: "read",
    execute: async (ctx, args) => {
      const userId = await userIdOf(ctx, deps.session);
      if (userId === null) {
        return "错误: 会话不存在，无法确定当前用户";
      }
      let row: WorkflowGraphRow | null;
      if (args.id !== undefined) {
        row = await deps.graphDefinition.findFirst({
          where: { id: args.id, userId },
        });
      } else if (args.name !== undefined) {
        const rows = await deps.graphDefinition.findMany({ where: { userId } });
        row =
          (rows.find((item) => item.name === args.name) as
            WorkflowGraphRow | undefined) ?? null;
        // findMany 轻量行无 version/graphJson，再按 id 取全量
        if (row) {
          row = await deps.graphDefinition.findFirst({
            where: { id: row.id, userId },
          });
        }
      } else {
        return "错误: id 与 name 至少提供一个";
      }
      if (!row) {
        return "错误: 工作流不存在（可先用 list_workflows 核对 id）";
      }
      return [
        `id=${row.id} version=${row.version}`,
        `name=${row.name}`,
        row.description ? `description=${row.description}` : "",
        "graphJson:",
        row.graphJson,
      ]
        .filter(Boolean)
        .join("\n");
    },
  };
}

const updateWorkflowSchema = z.object({
  id: z.number().int().positive().describe("目标工作流 id"),
  version: z
    .number()
    .int()
    .positive()
    .describe("当前版本号（先 get_workflow 获取；不符会冲突）"),
  name: z.string().min(1).max(100).optional().describe("新名称（可省略不改）"),
  description: z.string().max(500).optional().describe("新说明（可省略不改）"),
  graphJson: z
    .object({})
    .passthrough()
    .optional()
    .describe("新图定义（可省略；校验失败返回问题清单）"),
});

export function makeUpdateWorkflowTool(deps: {
  graphDefinition: WorkflowGraphPrismaLike;
  session: SessionPrismaLike;
  /** 写库成功后通知（语义同 create_workflow 的 notify） */
  notify?: () => void;
}): ToolDefinition<z.infer<typeof updateWorkflowSchema>> {
  return {
    name: "update_workflow",
    description: "修改工作流（须带 get_workflow 的 version）；写操作需批准",
    parameters: updateWorkflowSchema,
    kind: "write",
    execute: async (ctx, args) => {
      const userId = await userIdOf(ctx, deps.session);
      if (userId === null) {
        return "错误: 会话不存在，无法确定当前用户";
      }
      let serialized: string | undefined;
      if (args.graphJson !== undefined) {
        const result = validateGraph(args.graphJson);
        if (!result.ok) {
          return `校验未通过，请修正 graphJson 后重试（节点规范可 read_skill 读取 workflow-creator 技能）：\n${formatIssues(result.issues)}`;
        }
        serialized = JSON.stringify(normalizeGraph(result.value));
      }
      const res = await deps.graphDefinition.updateMany({
        where: { id: args.id, userId, version: args.version },
        data: {
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.description !== undefined
            ? { description: args.description }
            : {}),
          ...(serialized !== undefined ? { graphJson: serialized } : {}),
          version: args.version + 1,
        },
      });
      if (res.count === 0) {
        const exists = await deps.graphDefinition.findFirst({
          where: { id: args.id, userId },
        });
        return exists
          ? `错误: 版本冲突（当前 version=${exists.version}），请重新 get_workflow 后再更新`
          : "错误: 工作流不存在（可先用 list_workflows 核对 id）";
      }
      deps.notify?.();
      return `成功: 工作流 id=${args.id} 已更新（新 version=${args.version + 1}）`;
    },
  };
}

const runWorkflowSchema = z.object({
  id: z.number().int().positive().describe("要运行的工作流 id"),
  inputs: z
    .record(z.string(), z.string())
    .optional()
    .describe("输入变量（图 inputSchema 声明的键；可省略）"),
});

/** run_workflow：异步触发（触发即返回；结果落运行历史，AI 可用
 * get_workflow_run 查询——长图勿高频轮询，建议隔轮再查） */
export function makeRunWorkflowTool(deps: {
  graphDefinition: WorkflowGraphPrismaLike;
  session: SessionPrismaLike;
  workspace: WorkspacePrismaLike;
  launch: LaunchTestRunFn;
  /** 会话应用作用域（切片 C）：应用会话内仅可运行该应用的工作流 */
  app?: AppDefinitionPrismaLike;
}): ToolDefinition<z.infer<typeof runWorkflowSchema>> {
  return {
    name: "run_workflow",
    description:
      "异步试运行工作流（真实执行，触发即返；应用会话内仅可运行该应用的工作流）；写操作需批准",
    parameters: runWorkflowSchema,
    kind: "write",
    execute: async (ctx, args) => {
      const userId = await userIdOf(ctx, deps.session);
      if (userId === null) {
        return "错误: 会话不存在，无法确定当前用户";
      }
      if (!ctx.workspacePath) {
        return "错误: 当前会话未绑定工作空间目录，无法运行";
      }
      const row = await deps.graphDefinition.findFirst({
        where: { id: args.id, userId },
      });
      if (!row) {
        return "错误: 工作流不存在（可先用 list_workflows 核对 id）";
      }
      // 应用作用域闸（切片 C）：集合外的工作流对该会话不可运行——
      // 悬空绑定不拦（应用已删，按未作用域处理）
      const scope = await resolveSessionAppScope(
        ctx,
        deps.session,
        deps.app,
        userId,
      );
      if (scope && !scope.dangling && !scope.graphIds.has(args.id)) {
        return `错误: 工作流 id=${args.id} 不在当前应用「${scope.name}」的作用域内（该应用的可用工作流见 list_workflows）`;
      }
      const ws = await deps.workspace.findFirst({
        where: { directoryPath: ctx.workspacePath, userId },
      });
      if (!ws) {
        return `错误: 未找到目录 ${ctx.workspacePath} 对应的工作空间记录`;
      }
      if (graphTestInflight.has(args.id)) {
        return "错误: 该工作流正在运行中（同一图同时至多一个试运行），请稍后用 get_workflow_run 查询";
      }
      deps.launch({
        graph: row,
        inputs: args.inputs ?? {},
        workspace: { id: ws.id, directoryPath: ws.directoryPath },
      });
      return "已启动试运行（异步执行中）。结果可在「工作流」页运行历史查看，或稍后调用 get_workflow_run 查询最近一次运行结果";
    },
  };
}

/** automationRun 查询注入（get_workflow_run 用） */
export interface WorkflowRunPrismaLike {
  findFirst(args: {
    where: { graphId: number };
    orderBy: { startedAt: "desc" };
  }): Promise<{
    id: number;
    status: string;
    error: string | null;
    graphTrace: string | null;
    startedAt: Date;
    /** 结束时由 executor 收尾写入；运行中为 null */
    durationMs: number | null;
  } | null>;
}

/** graphRunNode 查询注入（get_workflow_run 终点完整输出口）：节点级执行
 *  详情行（executor writeNodeRecord 落全量 output，trace 只有 200 字预览） */
export interface WorkflowRunNodePrismaLike {
  findMany(args: {
    where: { runId: number };
  }): Promise<Array<{ nodeId: string; status: string; output: string | null }>>;
}

/** 终点完整输出上限：防巨型行集灌爆回喂上下文（超出截断标注） */
const FINAL_OUTPUT_LIMIT = 4_000;

const getWorkflowRunSchema = z.object({
  id: z.number().int().positive().describe("工作流 id"),
});

/** get_workflow_run：查该工作流最近一次运行（status/耗时/终点输出
 * 预览/失败原因）；graphTrace 缺失时只报状态。终点完整输出自 graphRunNode
 * 节点级详情行反查（demo 切片 2026-10-28：trace 预览仅 200 字，查账明细
 * 一类行集结果会被截断，聊天模型拿不到全量即无法透传 show_table 渲染——
 * runNodes delegate 缺席时回退仅预览，行为与旧装配一致） */
export function makeGetWorkflowRunTool(deps: {
  graphDefinition: WorkflowGraphPrismaLike;
  session: SessionPrismaLike;
  runs: WorkflowRunPrismaLike;
  runNodes?: WorkflowRunNodePrismaLike;
}): ToolDefinition<z.infer<typeof getWorkflowRunSchema>> {
  return {
    name: "get_workflow_run",
    description: "查工作流最近一次运行结果（状态/输出/失败原因）；勿高频轮询",
    parameters: getWorkflowRunSchema,
    kind: "read",
    execute: async (ctx, args) => {
      const userId = await userIdOf(ctx, deps.session);
      if (userId === null) {
        return "错误: 会话不存在，无法确定当前用户";
      }
      const graph = await deps.graphDefinition.findFirst({
        where: { id: args.id, userId },
      });
      if (!graph) {
        return "错误: 工作流不存在（可先用 list_workflows 核对 id）";
      }
      const run = await deps.runs.findFirst({
        where: { graphId: args.id },
        orderBy: { startedAt: "desc" },
      });
      if (!run) {
        return "暂无运行记录（run_workflow 触发后此处可查）";
      }
      const lines = [
        `运行 ${run.status}（runId=${run.id}，开始于 ${run.startedAt.toISOString()}）`,
        `耗时: ${formatRunDuration(run.durationMs)}`,
      ];
      if (run.error) {
        lines.push(`失败原因: ${run.error}`);
      }
      const last = lastSuccessTrace(run.graphTrace);
      if (last?.preview != null) {
        lines.push(
          last.preview.length > 500
            ? `输出: ${last.preview.slice(0, 500)}…`
            : `输出: ${last.preview}`,
        );
      }
      // 终点完整输出（≤FINAL_OUTPUT_LIMIT，超出截断标注）：行集结果
      // 回喂聊天模型的透传通道（show_table/show_summary 消费）
      if (deps.runNodes && last?.nodeId) {
        const full = await finalNodeOutput(deps.runNodes, run.id, last.nodeId);
        if (full !== null) {
          lines.push(
            full.length > FINAL_OUTPUT_LIMIT
              ? `完整输出: ${full.slice(0, FINAL_OUTPUT_LIMIT)}…（已截断）`
              : `完整输出: ${full}`,
          );
        }
      }
      return lines.join("\n");
    },
  };
}

/** durationMs → 秒文本（一位小数；null/未结束显示 -） */
function formatRunDuration(durationMs: number | null): string {
  return durationMs === null ? "-" : `${(durationMs / 1000).toFixed(1)}s`;
}

/** graphTrace JSON → 最后一个 success 节点（预览 + 节点 id——完整输出
 * 经 id 反查 graphRunNode；executor traceSuccess 只写 outputPreview——
 * 200 字截断，无 output 字段；无 success 条目/解析失败返回 null） */
function lastSuccessTrace(
  graphTrace: string | null,
): { nodeId?: string; preview: string | null } | null {
  if (!graphTrace) {
    return null;
  }
  try {
    const entries = JSON.parse(graphTrace) as Array<{
      id?: string;
      status?: string;
      outputPreview?: string;
    }>;
    const hit = [...entries].reverse().find((e) => e.status === "success");
    if (!hit) {
      return null;
    }
    return {
      nodeId: typeof hit.id === "string" ? hit.id : undefined,
      preview: typeof hit.outputPreview === "string" ? hit.outputPreview : null,
    };
  } catch {
    return null;
  }
}

/** 终点节点全量输出（graphRunNode 详情行反查；无匹配行/非 success/
 * 空输出 → null——保持「无则不附加」的旧形态） */
async function finalNodeOutput(
  runNodes: WorkflowRunNodePrismaLike,
  runId: number,
  nodeId: string,
): Promise<string | null> {
  const rows = await runNodes.findMany({ where: { runId } });
  const row = rows.find((r) => r.nodeId === nodeId && r.status === "success");
  return row?.output ? row.output : null;
}
