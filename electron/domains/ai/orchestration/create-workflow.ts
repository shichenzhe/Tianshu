// electron/domains/ai/orchestration/create-workflow.ts
/**
 * workflow_write / workflow_read 内置工具（AI 聊天建工作流；2026-10-29
 * 工具名精简批次六件坍缩四件：create+update 二模式合一为 workflow_write，
 * list+get 二合一为 workflow_read；run_workflow/get_workflow_run 保留）。
 * 模型按 workflow-creator 技能规范生成 graphJson，经 workflow_write 落库
 * （kind write → 统一审批）；校验复用前后端共享的 validateGraph——结构化
 * 问题（带节点定位）回传给模型自纠重试。workflow_read 清单态供
 * iterate/subflow 引用已有图时查真实 graphId。纯 Node（禁 import
 * electron），prisma 注入可测；userId 经 ctx.sessionId 反查 session
 * （工具上下文无 userId）。落库成功经注入的 notify 广播 graphs-changed
 * （渲染层列表缓存失效——工具写库绕过 IPC CRUD 的调用方 invalidate 链路）。
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
  }): Promise<{ userId: number } | null>;
}

/** workflow_write：无 id=新建（name+graphJson 必填）；id+version=修改
 *  （name/description/graphJson 字段级差量，与原 create/update 参数
 *  超集兼容——老名调用经 tool-alias 别名层路由后参数透明） */
const workflowWriteSchema = z.object({
  id: z.number().int().positive().optional().describe("目标工作流 id（修改时必填）"),
  version: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("当前版本号（修改时必填；先 workflow_read 获取，不符会冲突）"),
  name: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("工作流名称（新建必填；修改可改名，用户可读，同名会冲突）"),
  description: z
    .string()
    .max(500)
    .optional()
    .describe("一句话用途说明（可省略不改）"),
  graphJson: z
    .object({})
    .passthrough()
    .optional()
    .describe("图定义对象（新建必填；修改可省略，节点与连线规范见 workflow-creator 技能）"),
});

/** workflow_read：无参=清单；id/name 二选一=单图完整定义 */
const workflowReadSchema = z.object({
  id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("工作流 id（与 name 二选一；缺省两者=列清单）"),
  name: z
    .string()
    .min(1)
    .optional()
    .describe("工作流名称（与 id 二选一，重名时用 id）"),
});

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
 *  sessionId null 返回 null——工具回「会话不存在」正确降级） */
async function userIdOf(
  ctx: ToolContext,
  session: SessionPrismaLike,
): Promise<number | null> {
  if (ctx.sessionId === null) return null;
  const row = await session.findUnique({ where: { id: ctx.sessionId } });
  return row?.userId ?? null;
}

export function makeWorkflowWriteTool(deps: {
  graphDefinition: WorkflowGraphPrismaLike;
  session: SessionPrismaLike;
  /** 写库成功后通知（repo 注 notifyGraphsChanged 广播渲染层失效——
   *  全局 staleTime 30s 失效驱动，工具写库无此广播则列表页 30s 内
   *  不见新图；纯 Node 禁 electron 故经注入） */
  notify?: () => void;
}): ToolDefinition<z.infer<typeof workflowWriteSchema>> {
  return {
    name: "workflow_write",
    description:
      "新建或修改工作流（无 id=新建，name+graphJson 必填；id+version=修改，先 workflow_read 取 version）；写操作需批准",
    parameters: workflowWriteSchema,
    kind: "write",
    execute: async (ctx, args) => {
      const userId = await userIdOf(ctx, deps.session);
      if (userId === null) {
        return "错误: 会话不存在，无法确定当前用户";
      }
      // ---- 新建分支（无 id；与原 create_workflow 参数兼容）----
      if (args.id === undefined) {
        if (args.name === undefined || args.graphJson === undefined) {
          return "错误: 新建须提供 name 与 graphJson（修改已有图请带 id+version）";
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
          deps.notify?.();
          return `成功: 工作流「${row.name}」已创建（id=${row.id}），可在左侧「工作流」页面查看与编辑`;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (message.includes("UNIQUE")) {
            return `错误: 工作流「${args.name}」已存在，请换个名称`;
          }
          return `错误: 创建失败 ${message}`;
        }
      }
      // ---- 修改分支（带 id；与原 update_workflow 参数兼容）----
      if (args.version === undefined) {
        return "错误: 更新须提供 version（先 workflow_read 获取当前版本）";
      }
      if (
        args.name === undefined &&
        args.description === undefined &&
        args.graphJson === undefined
      ) {
        return "错误: 更新至少提供一个待改字段（name/description/graphJson）";
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
          ? `错误: 版本冲突（当前 version=${exists.version}），请重新 workflow_read 获取后再更新`
          : "错误: 工作流不存在（可先用 workflow_read 查询核对 id）";
      }
      deps.notify?.();
      return `成功: 工作流 id=${args.id} 已更新（新 version=${args.version + 1}）`;
    },
  };
}

/** workflow_read：无参=已保存清单（id/名称/说明，供子图引用查真实
 *  graphId）；id/name 二选一=单图完整定义（修改前必取 version——乐观锁） */
export function makeWorkflowReadTool(deps: {
  graphDefinition: WorkflowGraphPrismaLike;
  session: SessionPrismaLike;
}): ToolDefinition<z.infer<typeof workflowReadSchema>> {
  return {
    name: "workflow_read",
    description:
      "读取工作流：无参=已保存清单（id/名称/说明）；带 id 或 name=完整定义（修改前必先调用取 version）",
    parameters: workflowReadSchema,
    kind: "read",
    execute: async (ctx, args) => {
      const userId = await userIdOf(ctx, deps.session);
      if (userId === null) {
        return "错误: 会话不存在，无法确定当前用户";
      }
      // ---- 清单分支（无参；与原 list_workflows 兼容）----
      if (args.id === undefined && args.name === undefined) {
        const rows = await deps.graphDefinition.findMany({
          where: { userId },
          orderBy: { createdAt: "desc" },
        });
        if (rows.length === 0) {
          return "暂无已保存的工作流";
        }
        return rows
          .map(
            (row) =>
              `id=${row.id} ${row.name}${row.description ? ` — ${row.description}` : ""}`,
          )
          .join("\n");
      }
      // ---- 详情分支（与原 get_workflow 兼容）----
      let row: WorkflowGraphRow | null;
      if (args.id !== undefined) {
        row = await deps.graphDefinition.findFirst({
          where: { id: args.id, userId },
        });
      } else {
        const rows = await deps.graphDefinition.findMany({ where: { userId } });
        row =
          (rows.find((item) => item.name === args.name) as
            | WorkflowGraphRow
            | undefined) ?? null;
        // findMany 轻量行无 version/graphJson，再按 id 取全量
        if (row) {
          row = await deps.graphDefinition.findFirst({
            where: { id: row.id, userId },
          });
        }
      }
      if (!row) {
        return "错误: 工作流不存在（可先用 workflow_read 无参列清单核对 id）";
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

/** 试运行发射器注入（run_workflow 用；repo 的 launchTestRun 包装，
 * fire-and-forget；测试注 stub 免拉 executor 重依赖） */
export type LaunchTestRunFn = (params: {
  graph: WorkflowGraphRow;
  inputs: Record<string, string>;
  workspace: { id: number; directoryPath: string | null };
}) => void;

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
}): ToolDefinition<z.infer<typeof runWorkflowSchema>> {
  return {
    name: "run_workflow",
    description: "异步试运行工作流（真实执行，触发即返）；写操作需批准",
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
        return "错误: 工作流不存在（可先用 workflow_read 无参列清单核对 id）";
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

const getWorkflowRunSchema = z.object({
  id: z.number().int().positive().describe("工作流 id"),
});

/** get_workflow_run：查该工作流最近一次运行（status/耗时/终点输出
 * 预览/失败原因）；graphTrace 缺失时只报状态 */
export function makeGetWorkflowRunTool(deps: {
  graphDefinition: WorkflowGraphPrismaLike;
  session: SessionPrismaLike;
  runs: WorkflowRunPrismaLike;
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
        return "错误: 工作流不存在（可先用 workflow_read 无参列清单核对 id）";
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
      const preview = lastTraceOutput(run.graphTrace);
      if (preview !== null) {
        lines.push(
          preview.length > 500
            ? `输出: ${preview.slice(0, 500)}…`
            : `输出: ${preview}`,
        );
      }
      return lines.join("\n");
    },
  };
}

/** durationMs → 秒文本（一位小数；null/未结束显示 -） */
function formatRunDuration(durationMs: number | null): string {
  return durationMs === null ? "-" : `${(durationMs / 1000).toFixed(1)}s`;
}

/** graphTrace JSON → 最后一个 success 节点的输出预览（executor traceSuccess
 * 只写 outputPreview——200 字截断，无 output 字段；无则 null） */
function lastTraceOutput(graphTrace: string | null): string | null {
  if (!graphTrace) {
    return null;
  }
  try {
    const entries = JSON.parse(graphTrace) as Array<{
      status?: string;
      outputPreview?: string;
    }>;
    const hit = [...entries].reverse().find((e) => e.status === "success");
    return hit?.outputPreview ?? null;
  } catch {
    return null;
  }
}
