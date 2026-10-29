/**
 * plan-item 内置工具组（项目模块子系统 F；2026-10-29 工具名精简批次
 * 五件坍缩二件——todo_write 批量写 + todo_read 二合一读）。
 * 纯 Node 实现（禁止 import electron），可被 vitest 直接测试；
 * prisma 经 deps 结构注入（生产 ChatService 装配真 client，测试传内存 stub，
 * create-skill 先例）。todo_write kind:"write" → 走统一两级审批门禁；
 * execute 错误一律转「错误: ...」字符串回喂模型，不抛出。
 * 两工具共享 ctx.projectId 属地校验（非项目会话无计划上下文，直接拒绝）。
 * 坍缩语义裁定：不做 TodoWrite 式 omission-delete 全量覆写——计划清单
 * 人机共享（source 区分 ai/manual），漏项即删会误删人类任务；进展行
 * （原 plan_append_summary）保持只增不改。批量内逐项错误隔离（第 N 项
 * 前缀），单项失败不阻断其余项。
 */
import { format } from "date-fns";
import { z } from "zod";
import {
  appendAiSummaryLine,
  PLAN_PRIORITIES,
  PLAN_STATUSES,
  type PlanStatus,
} from "../../project/plan-item.entity";
import type { ToolContext, ToolDefinition } from "./file-tools";

/** planItem 行最小消费形状（prisma 全行结构满足；stub 只需这几列） */
interface PlanItemDbRow {
  id: number;
  projectId: number | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  dueDate: Date | null;
  source: string;
  aiSummary: string | null;
}

/** planItem.create 载荷（与 PlanItemRepository.create 同口径的字段集） */
interface PlanItemCreateData {
  projectId: number;
  title: string;
  description: null;
  status: "not_started";
  priority: string;
  assigneeId: null;
  startDate: null;
  dueDate: Date | null;
  source: "ai";
  tags?: string;
  customFields: null;
  sortOrder: number;
  createdById: number;
}

/** prisma planItem 结构子集（注入 stub/真实客户端均可） */
interface PlanItemPrismaLike {
  findUnique(args: { where: { id: number } }): Promise<PlanItemDbRow | null>;
  findFirst(args: {
    where: { projectId: number | null; status: string };
    orderBy: { sortOrder: "desc" };
    select: { sortOrder: true };
  }): Promise<{ sortOrder: number } | null>;
  findMany(args: {
    where: { projectId: number };
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }];
  }): Promise<PlanItemDbRow[]>;
  create(args: { data: PlanItemCreateData }): Promise<{ id: number }>;
  update(args: {
    where: { id: number };
    data: { status: string; sortOrder?: number } | { aiSummary: string };
  }): Promise<unknown>;
}

/** prisma project 结构子集（create 时取 ownerId 作 createdById） */
interface ProjectPrismaLike {
  findUnique(args: {
    where: { id: number };
    select: { ownerId: true };
  }): Promise<{ ownerId: number } | null>;
}

/** 工具组依赖（生产传真 prisma；测试注入内存 stub） */
export interface PlanToolsDeps {
  prisma: { planItem: PlanItemPrismaLike; project: ProjectPrismaLike };
}

/** 状态枚举 → 中文标签（成功文案用） */
const STATUS_LABELS: Record<PlanStatus, string> = {
  not_started: "待开始",
  in_progress: "进行中",
  paused: "已暂停",
  done: "已完成",
};

/** 工具失败的统一文案（回喂模型，不抛出；与 file-tools 同口径） */
function fail(message: string): string {
  return `错误: ${message}`;
}

/** 异常 → 字符串文案（prisma 异常兜底，不打断工具循环） */
function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** yyyy-MM-dd → Date（当日零点 UTC）；格式非法返回 null */
function parseDueDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 属地校验：行存在且属于当前项目才返回，否则 null（跨项目视同不存在） */
async function findOwnedItem(
  deps: PlanToolsDeps,
  ctx: ToolContext,
  id: number,
): Promise<PlanItemDbRow | null> {
  const row = await deps.prisma.planItem.findUnique({ where: { id } });
  return row && row.projectId === ctx.projectId ? row : null;
}

/** 目标状态列下一个列内序（与 PlanItemRepository.nextSortOrder 同口径） */
async function nextSortOrder(
  deps: PlanToolsDeps,
  projectId: number,
  status: string,
): Promise<number> {
  const last = await deps.prisma.planItem.findFirst({
    where: { projectId, status },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  return (last?.sortOrder ?? 0) + 1;
}

/** todo_write 单项形状（无 id=新建；有 id=更新） */
const todoItemSchema = z.object({
  id: z.number().optional().describe("既有任务 id（#<id> 引用）；缺省=新建"),
  title: z.string().optional().describe("任务标题（新建必填）"),
  status: z
    .enum(PLAN_STATUSES)
    .optional()
    .describe("目标状态：not_started/in_progress/paused/done"),
  priority: z
    .enum(PLAN_PRIORITIES)
    .optional()
    .describe("优先级（新建可选，缺省 P1）"),
  dueDate: z.string().optional().describe("截止日期 yyyy-MM-dd（仅新建）"),
  tags: z.array(z.string()).optional().describe("标签列表（仅新建）"),
  progress: z
    .string()
    .optional()
    .describe("追加一行带日期进展（只增不改；推进任务后记录）"),
});

const todoWriteSchema = z.object({
  items: z
    .array(todoItemSchema)
    .min(1)
    .describe(
      "批量操作：无 id=新建（title 必填）；有 id=更新（status/progress 任选或同提）",
    ),
});

const todoReadSchema = z.object({
  id: z.number().optional().describe("任务 id（#<id> 引用）；缺省=全量清单"),
});

/** todo_read 清单态：项目内全量任务 → 行摘要（跨项目行不可见） */
async function listItems(
  deps: PlanToolsDeps,
  ctx: ToolContext,
): Promise<string> {
  const rows = await deps.prisma.planItem.findMany({
    where: { projectId: ctx.projectId },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
  if (rows.length === 0) {
    return "当前项目计划清单为空（共 0 项）";
  }
  const lines = rows.map((row) => {
    const lastSummary = row.aiSummary
      ? row.aiSummary.split("\n").filter(Boolean).at(-1)
      : undefined;
    return `#${row.id}《${row.title}》｜${STATUS_LABELS[row.status as PlanStatus]}${
      lastSummary
        ? `｜最近进展: ${lastSummary.replace(/^\[[^\]]+\]\s*/, "")}`
        : ""
    }`;
  });
  return `当前项目计划清单（共 ${rows.length} 项）：\n${lines.join("\n")}`;
}

/** todo_read 详情态：属地校验 → 完整详情（含描述/全文进展——AI 推进的内容依据） */
async function getItem(
  deps: PlanToolsDeps,
  ctx: ToolContext,
  id: number,
): Promise<string> {
  const row = await findOwnedItem(deps, ctx, id);
  if (!row) {
    return fail("任务不存在或不属于当前项目");
  }
  const parts = [
    `#${row.id}《${row.title}》`,
    `状态: ${STATUS_LABELS[row.status as PlanStatus]}`,
    `优先级: ${row.priority}`,
    `截止: ${row.dueDate ? format(row.dueDate, "yyyy-MM-dd") : "无"}`,
    `来源: ${row.source}`,
  ];
  if (row.description) {
    parts.push(`[描述]\n${row.description}`);
  }
  if (row.aiSummary) {
    parts.push(`[进展]\n${row.aiSummary}`);
  }
  return parts.join("\n");
}

/** 新建项核心（校验由调用方先行；返回成功文案行） */
async function createOne(
  deps: PlanToolsDeps,
  ctx: ToolContext,
  item: { title: string; priority?: string; dueDate?: string; tags?: string[] },
  ownerId: number,
): Promise<string> {
  const dueDate =
    item.dueDate === undefined ? undefined : parseDueDate(item.dueDate);
  const row = await deps.prisma.planItem.create({
    data: {
      projectId: ctx.projectId as number,
      title: item.title,
      description: null,
      status: "not_started",
      priority: item.priority ?? "P1",
      // 设计裁决：AI 建的任务默认未指派（assigneeId null），人可后续指派
      assigneeId: null,
      startDate: null,
      dueDate: dueDate ?? null,
      source: "ai",
      tags: item.tags !== undefined ? JSON.stringify(item.tags) : undefined,
      customFields: null,
      sortOrder: await nextSortOrder(
        deps,
        ctx.projectId as number,
        "not_started",
      ),
      createdById: ownerId,
    },
  });
  return `已创建任务 #${row.id}《${item.title}》`;
}

/** 更新项核心：状态流转（变更时落目标列尾列序）→ 成功文案行 */
async function transitionOne(
  deps: PlanToolsDeps,
  ctx: ToolContext,
  row: PlanItemDbRow,
  status: PlanStatus,
): Promise<string> {
  const projectId = ctx.projectId as number;
  const data: { status: string; sortOrder?: number } = { status };
  if (row.status !== status) {
    data.sortOrder = await nextSortOrder(deps, projectId, status);
  }
  await deps.prisma.planItem.update({ where: { id: row.id }, data });
  return `任务 #${row.id} 已流转为：${STATUS_LABELS[status]}`;
}

/** 更新项核心：旧摘要追加「[yyyy-MM-dd] text」行回写 → 成功文案行 */
async function appendProgressOne(
  deps: PlanToolsDeps,
  row: PlanItemDbRow,
  text: string,
): Promise<string> {
  // 格式与 repo 工具通道共用 entity 纯函数（单点生效）
  const { line, next } = appendAiSummaryLine(row.aiSummary, text, new Date());
  await deps.prisma.planItem.update({
    where: { id: row.id },
    data: { aiSummary: next },
  });
  return `已记录进展 #${row.id}：${line}`;
}

/**
 * todo_write 单项应用：错误行带「第 N 项」前缀（批量内逐项隔离），
 * 单项失败不阻断其余项
 */
async function applyItem(
  deps: PlanToolsDeps,
  ctx: ToolContext,
  item: z.infer<typeof todoItemSchema>,
  index: number,
  ownerId: number,
): Promise<string> {
  if (item.id === undefined) {
    // 新建：title/dueDate 前置校验（不触库）
    if (!item.title || !item.title.trim()) {
      return fail(`第 ${index} 项标题不能为空`);
    }
    if (item.dueDate !== undefined && parseDueDate(item.dueDate) === null) {
      return fail(`第 ${index} 项无效的截止日期格式（应为 yyyy-MM-dd）`);
    }
    return createOne(
      deps,
      ctx,
      {
        title: item.title.trim(),
        priority: item.priority,
        dueDate: item.dueDate,
        tags: item.tags,
      },
      ownerId,
    );
  }
  // 更新：title 显式拒绝（防静默忽略）
  if (item.title !== undefined) {
    return fail(`第 ${index} 项暂不支持修改标题`);
  }
  if (item.status === undefined && item.progress === undefined) {
    return fail(`第 ${index} 项更新项须含 status 或 progress`);
  }
  if (item.progress !== undefined && !item.progress.trim()) {
    return fail(`第 ${index} 项进展描述不能为空`);
  }
  const row = await findOwnedItem(deps, ctx, item.id);
  if (!row) {
    return fail(`第 ${index} 项任务不存在或不属于当前项目`);
  }
  const lines: string[] = [];
  if (item.status !== undefined) {
    lines.push(await transitionOne(deps, ctx, row, item.status));
  }
  if (item.progress !== undefined) {
    lines.push(await appendProgressOne(deps, row, item.progress.trim()));
  }
  return lines.join("\n");
}

export function makePlanTools(deps: PlanToolsDeps): ToolDefinition[] {
  // 心智模型锚点（防呆，压缩保留）：计划清单是结构化数据（非文件系统），
  // 掐掉模型在文件系统里找任务文件的错误路径——挂在写/读两个工具上
  const GROUNDING_NOTE = "清单不在文件系统";
  const todoWriteTool: ToolDefinition<z.infer<typeof todoWriteSchema>> = {
    name: "todo_write",
    description: `批量维护当前项目计划清单：一次提交多项（无 id=新建任务；有 id=流转状态/追加进展）。${GROUNDING_NOTE}`,
    parameters: todoWriteSchema,
    kind: "write",
    execute: async (ctx, args) => {
      try {
        if (ctx.projectId == null) {
          return fail("当前会话未关联项目");
        }
        // 含新建项时一次性前置项目校验（批级错误，不带「第 N 项」前缀）
        let ownerId: number | null = null;
        if (args.items.some((item) => item.id === undefined)) {
          const project = await deps.prisma.project.findUnique({
            where: { id: ctx.projectId },
            select: { ownerId: true },
          });
          if (!project) {
            return fail("项目不存在");
          }
          ownerId = project.ownerId;
        }
        const lines: string[] = [];
        for (const [index, item] of args.items.entries()) {
          lines.push(
            await applyItem(deps, ctx, item, index + 1, ownerId as number),
          );
        }
        return lines.join("\n");
      } catch (e) {
        return fail(toMessage(e));
      }
    },
  };
  const todoReadTool: ToolDefinition<z.infer<typeof todoReadSchema>> = {
    name: "todo_read",
    description: `查看当前项目计划清单：无参=全量（#id/标题/状态/最近进展）；带 id=单任务完整详情。${GROUNDING_NOTE}`,
    parameters: todoReadSchema,
    kind: "read",
    execute: async (ctx, args) => {
      try {
        if (ctx.projectId == null) {
          return fail("当前会话未关联项目");
        }
        return args.id === undefined
          ? await listItems(deps, ctx)
          : await getItem(deps, ctx, args.id);
      } catch (e) {
        return fail(toMessage(e));
      }
    },
  };
  return [todoWriteTool, todoReadTool];
}
