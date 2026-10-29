/**
 * plan-item 内置工具组（自 mirror electron/domains/ai/agent/plan-tools.ts
 * 移植，prisma 经 deps 结构注入：生产 ChatRunnerService 装配真 client，
 * 测试传内存 stub）。五件：创建任务/流转状态/追加进展/列表/详情，共享
 * ctx.projectId 属地校验（非项目会话无计划上下文，直接拒绝）。
 * execute 错误一律转「错误: ...」字符串回喂模型，不抛出；写类三件
 * kind:"write" → 走统一审批门禁。
 * 伴随常量（PLAN_STATUSES/PLAN_PRIORITIES/appendAiSummaryLine）自 mirror
 * electron/domains/project/plan-item.entity.ts 摘取内联（该 entity 其余为
 * 前端记录形状，未移植）。
 */
import { format } from 'date-fns';
import { z } from 'zod';
import type { ToolContext, ToolDefinition } from './tool-definition';

/** 状态枚举：not_started 待开始 / in_progress 进行中 / paused 已暂停 / done 已完成 */
export const PLAN_STATUSES = [
  'not_started',
  'in_progress',
  'paused',
  'done',
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** 优先级枚举：P0 最高 / P1 默认 / P2 / P3 最低 */
export const PLAN_PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;

/** AI 进展摘要追加一行（与 repo 工具通道共用格式——单点生效）：
 * 已有摘要尾接「[yyyy-MM-dd] text」，空摘要首行无前导换行 */
export function appendAiSummaryLine(
  current: string | null,
  text: string,
  now: Date,
): { line: string; next: string } {
  const line = `[${format(now, 'yyyy-MM-dd')}] ${text}`;
  return { line, next: current ? `${current}\n${line}` : line };
}

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
  status: 'not_started';
  priority: string;
  assigneeId: null;
  startDate: null;
  dueDate: Date | null;
  source: 'ai';
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
    orderBy: { sortOrder: 'desc' };
    select: { sortOrder: true };
  }): Promise<{ sortOrder: number } | null>;
  findMany(args: {
    where: { projectId: number };
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }];
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
  not_started: '待开始',
  in_progress: '进行中',
  paused: '已暂停',
  done: '已完成',
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
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  });
  return (last?.sortOrder ?? 0) + 1;
}

const createItemSchema = z.object({
  title: z.string().describe('任务标题'),
  priority: z.enum(PLAN_PRIORITIES).optional().describe('优先级，缺省 P1'),
  dueDate: z.string().optional().describe('截止日期，格式 yyyy-MM-dd'),
  tags: z.array(z.string()).optional().describe('标签列表'),
});

const updateStatusSchema = z.object({
  id: z.number().describe('任务 id（#<id> 引用）'),
  status: z.enum(PLAN_STATUSES).describe('目标状态'),
});

const appendSummarySchema = z.object({
  id: z.number().describe('任务 id（#<id> 引用）'),
  text: z.string().describe('一行进展描述'),
});

const listItemsSchema = z.object({});

const getItemSchema = z.object({
  id: z.number().describe('任务 id（#<id> 引用）'),
});

/** todo_read：项目内全量任务 → 行摘要（跨项目行不可见，只增数据不加幻觉） */
async function listItems(
  deps: PlanToolsDeps,
  ctx: ToolContext,
): Promise<string> {
  if (ctx.projectId == null) {
    return fail('当前会话未关联项目');
  }
  const rows = await deps.prisma.planItem.findMany({
    where: { projectId: ctx.projectId },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  if (rows.length === 0) {
    return '当前项目计划清单为空（共 0 项）';
  }
  const lines = rows.map((row) => {
    const lastSummary = row.aiSummary
      ? row.aiSummary.split('\n').filter(Boolean).at(-1)
      : undefined;
    return `#${row.id}《${row.title}》｜${STATUS_LABELS[row.status as PlanStatus]}${
      lastSummary
        ? `｜最近进展: ${lastSummary.replace(/^\[[^\]]+\]\s*/, '')}`
        : ''
    }`;
  });
  return `当前项目计划清单（共 ${rows.length} 项）：\n${lines.join('\n')}`;
}

/** todo_read：属地校验 → 完整详情（含描述/全文进展——AI 推进的内容依据） */
async function getItem(
  deps: PlanToolsDeps,
  ctx: ToolContext,
  id: number,
): Promise<string> {
  if (ctx.projectId == null) {
    return fail('当前会话未关联项目');
  }
  const row = await findOwnedItem(deps, ctx, id);
  if (!row) {
    return fail('任务不存在或不属于当前项目');
  }
  const parts = [
    `#${row.id}《${row.title}》`,
    `状态: ${STATUS_LABELS[row.status as PlanStatus]}`,
    `优先级: ${row.priority}`,
    `截止: ${row.dueDate ? format(row.dueDate, 'yyyy-MM-dd') : '无'}`,
    `来源: ${row.source}`,
  ];
  if (row.description) {
    parts.push(`[描述]\n${row.description}`);
  }
  if (row.aiSummary) {
    parts.push(`[进展]\n${row.aiSummary}`);
  }
  return parts.join('\n');
}

/** todo_write：ctx.projectId/标题/日期校验 → source=ai 建行（未指派） */
async function createItem(
  deps: PlanToolsDeps,
  ctx: ToolContext,
  args: z.infer<typeof createItemSchema>,
): Promise<string> {
  const projectId = ctx.projectId;
  if (projectId == null) {
    return fail('当前会话未关联项目');
  }
  const title = args.title.trim();
  if (!title) {
    return fail('标题不能为空');
  }
  const dueDate =
    args.dueDate === undefined ? undefined : parseDueDate(args.dueDate);
  if (dueDate === null) {
    return fail('无效的截止日期格式（应为 yyyy-MM-dd）');
  }
  const project = await deps.prisma.project.findUnique({
    where: { id: projectId },
    select: { ownerId: true },
  });
  if (!project) {
    return fail('项目不存在');
  }
  const row = await deps.prisma.planItem.create({
    data: {
      projectId,
      title,
      description: null,
      status: 'not_started',
      priority: args.priority ?? 'P1',
      // 设计裁决：AI 建的任务默认未指派（assigneeId null），人可后续指派
      assigneeId: null,
      startDate: null,
      dueDate: dueDate ?? null,
      source: 'ai',
      tags: args.tags !== undefined ? JSON.stringify(args.tags) : undefined,
      customFields: null,
      sortOrder: await nextSortOrder(deps, projectId, 'not_started'),
      createdById: project.ownerId,
    },
  });
  return `已创建任务 #${row.id}《${title}》`;
}

/** todo_write：属地校验 → 状态流转（变更时落目标列尾列序） */
async function updateStatus(
  deps: PlanToolsDeps,
  ctx: ToolContext,
  args: z.infer<typeof updateStatusSchema>,
): Promise<string> {
  const projectId = ctx.projectId;
  if (projectId == null) {
    return fail('当前会话未关联项目');
  }
  const row = await findOwnedItem(deps, ctx, args.id);
  if (!row) {
    return fail('任务不存在或不属于当前项目');
  }
  const data: { status: string; sortOrder?: number } = { status: args.status };
  if (row.status !== args.status) {
    data.sortOrder = await nextSortOrder(deps, projectId, args.status);
  }
  await deps.prisma.planItem.update({ where: { id: args.id }, data });
  return `任务 #${args.id} 已流转为：${STATUS_LABELS[args.status]}`;
}

/** todo_write：属地校验 → 旧摘要追加「[yyyy-MM-dd] text」行回写 */
async function appendSummary(
  deps: PlanToolsDeps,
  ctx: ToolContext,
  args: z.infer<typeof appendSummarySchema>,
): Promise<string> {
  if (ctx.projectId == null) {
    return fail('当前会话未关联项目');
  }
  const text = args.text.trim();
  if (!text) {
    return fail('进展描述不能为空');
  }
  const row = await findOwnedItem(deps, ctx, args.id);
  if (!row) {
    return fail('任务不存在或不属于当前项目');
  }
  const { line, next } = appendAiSummaryLine(row.aiSummary, text, new Date());
  await deps.prisma.planItem.update({
    where: { id: args.id },
    data: { aiSummary: next },
  });
  return `已记录进展 #${args.id}：${line}`;
}

export function makePlanTools(deps: PlanToolsDeps): ToolDefinition[] {
  // 逐工具显式 ToolDefinition<z.infer<...>> 注解（execute args 得到类型）
  // 心智模型锚点（防呆，压缩保留）：计划清单是结构化数据（非文件系统），
  // 掐掉模型在文件系统里找任务文件的错误路径——挂在建/查两个入口工具上
  const GROUNDING_NOTE = '清单不在文件系统';
  const createItemTool: ToolDefinition<z.infer<typeof createItemSchema>> = {
    name: 'todo_write',
    description: `在当前项目计划清单中创建任务。${GROUNDING_NOTE}`,
    parameters: createItemSchema,
    kind: 'write',
    execute: async (ctx, args) => {
      try {
        return await createItem(deps, ctx, args);
      } catch (e) {
        return fail(toMessage(e));
      }
    },
  };
  const updateStatusTool: ToolDefinition<z.infer<typeof updateStatusSchema>> = {
    name: 'todo_write',
    description: '流转计划任务状态（待开始/进行中/已暂停/已完成）',
    parameters: updateStatusSchema,
    kind: 'write',
    execute: async (ctx, args) => {
      try {
        return await updateStatus(deps, ctx, args);
      } catch (e) {
        return fail(toMessage(e));
      }
    },
  };
  const appendSummaryTool: ToolDefinition<z.infer<typeof appendSummarySchema>> =
    {
      name: 'todo_write',
      description: '为计划任务追加带日期的进展摘要（只增不改）；推进任务后调用',
      parameters: appendSummarySchema,
      kind: 'write',
      execute: async (ctx, args) => {
        try {
          return await appendSummary(deps, ctx, args);
        } catch (e) {
          return fail(toMessage(e));
        }
      },
    };
  const listItemsTool: ToolDefinition<z.infer<typeof listItemsSchema>> = {
    name: 'todo_read',
    description: `查看当前项目全量计划清单（#id/标题/状态/最近进展）；${GROUNDING_NOTE}`,
    parameters: listItemsSchema,
    kind: 'read',
    execute: async (ctx) => {
      try {
        return await listItems(deps, ctx);
      } catch (e) {
        return fail(toMessage(e));
      }
    },
  };
  const getItemTool: ToolDefinition<z.infer<typeof getItemSchema>> = {
    name: 'todo_read',
    description: '按 id 查看计划任务完整详情（含描述与全部进展）',
    parameters: getItemSchema,
    kind: 'read',
    execute: async (ctx, args) => {
      try {
        return await getItem(deps, ctx, args.id);
      } catch (e) {
        return fail(toMessage(e));
      }
    },
  };
  return [
    createItemTool,
    updateStatusTool,
    appendSummaryTool,
    listItemsTool,
    getItemTool,
  ];
}
