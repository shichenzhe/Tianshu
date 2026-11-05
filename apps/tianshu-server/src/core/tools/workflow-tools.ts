/**
 * 工作流六件（F1 2026-10-29）：自 mirror electron/domains/ai/orchestration/
 * create-workflow.ts 移植，执行基建换 server 自己的 GraphService.run
 * （runId 即时回执——六类触发源齐备的本仓优势）。typed 输入入口归一走
 * @tianshu/core normalizeGraphInputs（D 批共享，dist 已重建）；E1 字段级
 * 回喂的 union 展开在 core validateGraph（共享直接受益），消息渲染器与
 * 期望表、E2 cookbook 为桌面单份——此处精简复刻并保持文案同源。
 * 边界（桌面态能力，server 会话不可见即正确）：应用作用域（C 批 app:*、
 * session.appId 路由）与数据源引用（B 批 dataSourceId 配置面）不移植；
 * create 落库广播 notify（渲染层缓存失效）在 server 无消费面，省略。
 */
import { z } from 'zod';
import type { ToolContext, ToolDefinition } from './tool-definition';
import {
  normalizeGraph,
  validateGraph,
  normalizeGraphInputs,
  parseInputSchema,
  type GraphInputValue,
} from '@tianshu/core';

/** 四件名（2026-11-01 审查批对齐 mirror 2026-10-29 六件坍缩：write/read
 * 二合一，run 双件未改名）；老名（create/update/list/get_workflow）经
 * @tianshu/core tool-alias 归一路由，历史回喂透明，DB 不迁移 */
export const WORKFLOW_TOOL_NAMES = [
  'workflow_write',
  'workflow_read',
  'run_workflow',
  'get_workflow_run',
] as const;

/** 伴生用户（graph 域归属约定；chat 会话 userId 缺席时回落） */
const FALLBACK_USER_ID = 1;

/** 图行（list 轻量 + get 全量共用投影） */
interface GraphRowLike {
  id: number;
  name: string;
  description: string | null;
  version: number;
  graphJson: string;
}

/** 图运行行（get_workflow_run 消费） */
interface RunRowLike {
  id: number;
  status: string;
  error: string | null;
  graphTrace: string | null;
  startedAt: Date;
  durationMs: number | null;
}

/** 节点级运行详情行（终点完整输出——mirror 2026-10-28 同款透传通道） */
interface RunNodeRowLike {
  nodeId: string;
  status: string;
  output: string | null;
}

/** prisma 依赖投影（PrismaService 可直接赋形） */
export interface WorkflowPrismaLike {
  graphDefinition: {
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
    }): Promise<GraphRowLike[]>;
    findFirst(args: {
      where: { id: number; userId: number };
    }): Promise<GraphRowLike | null>;
    updateMany(args: {
      where: { id: number; userId: number; version: number };
      data: {
        name?: string;
        description?: string | null;
        graphJson?: string;
        version?: number;
      };
    }): Promise<{ count: number }>;
  };
  automationRun: {
    findFirst(args: {
      where: { graphId: number };
      orderBy: { startedAt: 'desc' };
    }): Promise<RunRowLike | null>;
  };
  graphRunNode: {
    findMany(args: { where: { runId: number } }): Promise<RunNodeRowLike[]>;
  };
}

/** 执行基建注入：GraphService.run（受理即返 runId；错误经 Error message） */
export type RunGraphFn = (dto: {
  graphId: number;
  inputs?: Record<string, GraphInputValue>;
  workspaceId?: number;
}) => Promise<{ runId: number }>;

export function makeWorkflowTools(deps: {
  prisma: WorkflowPrismaLike;
  runGraph: RunGraphFn;
}): ToolDefinition[] {
  const userIdOf = (ctx: ToolContext): number => ctx.userId ?? FALLBACK_USER_ID;

  /** ============ E1 字段级回喂（桌面单份精简复刻，文案同源） ============ */

  const GRAPH_ISSUE_HINTS: Record<string, string> = {
    duplicateNodeId: '节点 id 重复——每个节点 id 必须唯一（kebab-case）',
    reservedNodeId: '节点 id 占用了保留字（inputs/nodes/route）——换一个 id',
    uniqueEntry:
      '入口不唯一——全图必须恰有一个无入边的节点（start→首业务节点），请检查连线',
    danglingEdge:
      '边引用了不存在的节点 id——边的 from/to 须指向图中节点（终点可为 END）',
    conditionNotBranchable:
      '条件边挂在非分支节点上——只有 condition/intent/分支模式 llm/code 可挂条件边',
    conditionValueOutOfRange:
      '条件边的 label 不在源节点分支选项内——须为分支名或兜底名之一',
    branchOptionsRequired: '分支模式节点必须携带非空 branchOptions',
    iterateItemsRequired: '循环节点（array 模式）必须提供 itemsSource 表达式',
    iterateCountRequired: '循环节点（count 模式）必须提供 countSource',
    iterateBreakRequired: '循环节点（while 模式）必须提供 breakCondition',
    duplicateStartNode: 'start 节点至多一个',
    startIncomingEdge: 'start 节点不得有入边',
  };

  const FIELD_EXPECTATIONS: Record<string, string> = {
    modelId: '正整数（模型表 id）',
    prompt: '非空字符串（支持 {{input.x}}/{{nodes.<id>.output}} 占位）',
    script: '非空脚本文本',
    language: 'nodejs / python / bash 三者之一',
    engine: 'sqlite / postgres / mysql / oracle / sqlserver 之一',
    sqlitePath: 'SQLite 文件相对工作空间的路径（如 demo.db）',
    sql: '单条 SQL 文本（值用 ? 占位、经 params 参数化，勿内插）',
    params: '字符串数组，如 ["{{input.amount}}","{{input.category}}"]',
    variables: '字符串数组（变量名清单，如 ["amount","category"]）',
    url: '完整 URL（支持 {{}} 占位）',
    graphId: '子工作流的真实 id（正整数，可用 workflow_read 无参清单查）',
    inputs: '键值数组 [{key, value}]，value 支持 {{}} 占位',
    timeoutMs: '毫秒数（整数，按各节点上限）',
    maxRows: '正整数（行数上限）',
    retries: '0-5 的整数',
    position: '{x: 数值, y: 数值}（画布坐标，可省略）',
  };

  const INPUT_SCHEMA_EXPECTATION =
    '简写 "string" 或对象 {type: "string"|"number"|"boolean"|"enum"|"date"|"json", required?, default?（json 为对象/数组）, enumValues?（enum 必填非空不重复）, description?}';

  function translateZodMessage(message: string): string {
    if (message === 'Required') {
      return '缺少必填字段';
    }
    const enumMatch =
      /^Invalid enum value(?:\(s\))?\.\s*Expected (.+?)(?:,|$|\.)/.exec(
        message,
      );
    if (enumMatch) {
      return `取值必须是 ${enumMatch[1]} 之一`;
    }
    const literalMatch = /^Invalid literal value,\s*expected (.+)$/.exec(
      message,
    );
    if (literalMatch) {
      return `取值必须是 ${literalMatch[1]}`;
    }
    if (/String must contain at least 1 character/.test(message)) {
      return '不能为空串';
    }
    const missingMatch =
      /^Invalid input: expected (.+?), received undefined$/.exec(message);
    if (missingMatch) {
      return `缺少必填字段（应为 ${missingMatch[1]}）`;
    }
    const typeMatch = /^Invalid input: expected (.+?), received (.+)$/.exec(
      message,
    );
    if (typeMatch) {
      return `类型应为 ${typeMatch[1]}（收到 ${typeMatch[2]}）`;
    }
    if (message === 'Invalid input') {
      return '取值或形态不符';
    }
    if (/Number must be/.test(message) || /^Invalid input/.test(message)) {
      return `数值/格式不符：${message}`;
    }
    return message;
  }

  function formatGraphIssues(
    issues: Array<{ code: string; params?: Record<string, string | number> }>,
  ): string {
    const lines: string[] = [];
    for (const issue of issues.slice(0, 12)) {
      if (issue.code !== 'schema') {
        lines.push(`- ${GRAPH_ISSUE_HINTS[issue.code] ?? issue.code}`);
        continue;
      }
      const params = issue.params ?? {};
      const path = typeof params.path === 'string' ? params.path : '';
      const nodeId = typeof params.nodeId === 'string' ? params.nodeId : null;
      const message =
        typeof params.message === 'string'
          ? params.message
          : String(issue.code);
      const where = nodeId
        ? `节点「${nodeId}」${path.replace(/^nodes\.[^.]+\./, '')}`
        : `图级 ${path || '(根)'}`;
      const expectation = path.startsWith('inputSchema')
        ? INPUT_SCHEMA_EXPECTATION
        : (FIELD_EXPECTATIONS[path.split('.').pop() ?? path] ?? null);
      lines.push(
        `- ${where}：${translateZodMessage(message)}${
          expectation ? `。期望：${expectation}` : ''
        }`,
      );
    }
    if (issues.length > 12) {
      lines.push(`- …另有 ${issues.length - 12} 项问题（同类修正即可）`);
    }
    return lines.join('\n');
  }

  /** ============ typed 输入摘要（D4 同源复刻） ============ */

  function inputSummaryOf(graphJson: string | undefined): string | null {
    if (typeof graphJson !== 'string' || graphJson === '') {
      return null;
    }
    try {
      const fields = parseInputSchema(
        (JSON.parse(graphJson) as { inputSchema?: unknown }).inputSchema as
          Record<string, unknown> | undefined,
      );
      if (fields.length === 0) {
        return null;
      }
      return fields
        .map((field) => {
          const head =
            field.type === 'enum' && field.enumValues?.length
              ? `${field.key}:enum[${field.enumValues.join('|')}]`
              : `${field.key}:${field.type}`;
          const qualifiers = [field.required ? '必填' : '可选'];
          if (field.default !== undefined) {
            qualifiers.push(
              `默认:${
                field.default === 'today'
                  ? '当天'
                  : field.default !== null &&
                      typeof field.default === 'object'
                    ? JSON.stringify(field.default)
                    : String(field.default)
              }`,
            );
          }
          return `${head}(${qualifiers.join('，')})`;
        })
        .join('，');
    } catch {
      return null;
    }
  }

  /** 图 graphJson → 入口归一（run_workflow 用；空声明直通=旧图语义） */
  function normalizeInputsForGraph(
    graphJson: string,
    raw: Record<string, unknown>,
  ):
    | { ok: true; inputs: Record<string, GraphInputValue> }
    | { ok: false; error: string } {
    let schema: unknown = {};
    try {
      schema = (JSON.parse(graphJson) as { inputSchema?: unknown }).inputSchema;
    } catch {
      return { ok: true, inputs: raw as Record<string, string> };
    }
    const result = normalizeGraphInputs(
      parseInputSchema(schema as Record<string, unknown> | undefined),
      raw,
    );
    if (!result.ok) {
      return {
        ok: false,
        error: `错误: 输入参数无效：\n${result.issues
          .map((issue) => `- ${issue.message}`)
          .join('\n')}`,
      };
    }
    return { ok: true, inputs: result.inputs };
  }

  const writeSchema = z.object({
    id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('目标工作流 id（修改必填；省略=新建）'),
    version: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('当前版本号（修改必填，先 workflow_read 获取；不符会冲突）'),
    name: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('工作流名称（新建必填；同名会冲突）'),
    description: z.string().max(500).optional().describe('一句话用途说明'),
    graphJson: z
      .object({})
      .passthrough()
      .optional()
      .describe('图定义对象（新建必填；节点与连线规范见工具描述速查）'),
  });

  const write: ToolDefinition<z.infer<typeof writeSchema>> = {
    name: 'workflow_write',
    description: `新建或修改工作流（无 id=新建，name+graphJson 必填；id+version=修改，先 workflow_read 取 version；校验失败按节点/字段返回可自纠问题清单）；写操作需批准。\n${WORKFLOW_NODE_COOKBOOK}`,
    parameters: writeSchema,
    kind: 'write',
    execute: async (ctx, args) => {
      // ---- 新建分支（无 id；与原 create_workflow 参数兼容）----
      if (args.id === undefined) {
        if (args.name === undefined || args.graphJson === undefined) {
          return '错误: 新建须提供 name 与 graphJson（修改已有图请带 id+version）';
        }
        const userId = userIdOf(ctx);
        const result = validateGraph(args.graphJson);
        if (!result.ok) {
          return `校验未通过（问题按「节点/字段/原因/期望」逐条列出），请修正 graphJson 后重试：\n${formatGraphIssues(result.issues)}`;
        }
        try {
          const row = await deps.prisma.graphDefinition.create({
            data: {
              name: args.name,
              description: args.description ?? null,
              graphJson: JSON.stringify(normalizeGraph(result.value)),
              userId,
            },
          });
          // E3 软提示（精简复刻）：read 路由依据是名称+描述+类型摘要
          const hints: string[] = [];
          if (!args.description || args.description.trim() === '') {
            hints.push(
              '提示：未写 description——workflow_read 按名称+描述路由选图，建议补一句用途说明',
            );
          }
          const missing = parseInputSchema(result.value.inputSchema)
            .filter((field) => !field.description)
            .map((field) => field.key);
          if (missing.length > 0) {
            hints.push(
              `提示：输入变量 [${missing.join('、')}] 未写 description，建议补写（类型摘要行含描述更利填参）`,
            );
          }
          return `成功: 工作流「${row.name}」已创建（id=${row.id}）${hints.length ? `\n${hints.join('\n')}` : ''}`;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (message.includes('UNIQUE')) {
            return `错误: 工作流「${args.name}」已存在，请换个名称`;
          }
          return `错误: 创建失败 ${message}`;
        }
      }
      // ---- 修改分支（id+version；与原 update_workflow 参数兼容）----
      if (args.version === undefined) {
        return '错误: 修改须提供 version（先 workflow_read 获取当前版本）';
      }
      const userId = userIdOf(ctx);
      let serialized: string | undefined;
      let hints: string[] = [];
      if (args.graphJson !== undefined) {
        const result = validateGraph(args.graphJson);
        if (!result.ok) {
          return `校验未通过（问题按「节点/字段/原因/期望」逐条列出），请修正 graphJson 后重试：\n${formatGraphIssues(result.issues)}`;
        }
        serialized = JSON.stringify(normalizeGraph(result.value));
        if (!args.description) {
          hints.push(
            '提示：未写 description——建议补一句用途说明（read 路由依据）',
          );
        }
        const missing = parseInputSchema(result.value.inputSchema)
          .filter((field) => !field.description)
          .map((field) => field.key);
        if (missing.length > 0) {
          hints.push(`提示：输入变量 [${missing.join('、')}] 未写 description`);
        }
      }
      const res = await deps.prisma.graphDefinition.updateMany({
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
        const exists = await deps.prisma.graphDefinition.findFirst({
          where: { id: args.id, userId },
        });
        return exists
          ? `错误: 版本冲突（当前 version=${exists.version}），请重新 workflow_read 后再更新`
          : '错误: 工作流不存在（可先用 workflow_read 核对 id）';
      }
      return `成功: 工作流 id=${args.id} 已更新（新 version=${args.version + 1}）${hints.length ? `\n${hints.join('\n')}` : ''}`;
    },
  };

  const readSchema = z.object({
    id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('工作流 id（与 name 二选一；省略=已保存清单）'),
    name: z.string().min(1).optional().describe('工作流名称（与 id 二选一）'),
  });

  async function findGraph(
    ctx: ToolContext,
    args: Pick<z.infer<typeof readSchema>, 'id' | 'name'>,
  ): Promise<GraphRowLike | null | 'MISSING_ARGS'> {
    const userId = userIdOf(ctx);
    if (args.id !== undefined) {
      return deps.prisma.graphDefinition.findFirst({
        where: { id: args.id, userId },
      });
    }
    if (args.name !== undefined) {
      const rows = await deps.prisma.graphDefinition.findMany({
        where: { userId },
      });
      const hit = rows.find((row) => row.name === args.name);
      return hit ?? null;
    }
    return 'MISSING_ARGS';
  }

  const read: ToolDefinition<z.infer<typeof readSchema>> = {
    name: 'workflow_read',
    description:
      '读取工作流：无参=已保存清单（id/名称/说明/输入类型摘要，子图引用须用真实 id）；带 id 或 name=完整定义（修改前必先调用取 version——乐观锁）',
    parameters: readSchema,
    kind: 'read',
    execute: async (ctx, args) => {
      // ---- 清单分支（无参；与原 list_workflows 兼容）----
      if (args.id === undefined && args.name === undefined) {
        const rows = await deps.prisma.graphDefinition.findMany({
          where: { userId: userIdOf(ctx) },
          orderBy: { createdAt: 'desc' },
        });
        if (rows.length === 0) {
          return '暂无已保存的工作流';
        }
        return rows
          .map((row) => {
            const summary = inputSummaryOf(row.graphJson);
            return `id=${row.id} ${row.name}${row.description ? ` — ${row.description}` : ''}${summary ? ` · 输入: ${summary}` : ''}`;
          })
          .join('\n');
      }
      // ---- 单图分支（与原 get_workflow 兼容）----
      const row = await findGraph(ctx, args);
      if (row === 'MISSING_ARGS') {
        return '错误: id 与 name 至少提供一个';
      }
      if (!row) {
        return '错误: 工作流不存在（可先用 workflow_read 无参清单核对 id）';
      }
      return [
        `id=${row.id} version=${row.version}`,
        `name=${row.name}`,
        row.description ? `description=${row.description}` : '',
        'graphJson:',
        row.graphJson,
      ]
        .filter(Boolean)
        .join('\n');
    },
  };

  const runSchema = z.object({
    id: z.number().int().positive().describe('要运行的工作流 id'),
    inputs: z
      .record(
        z.string(),
        z.union([
          z.string(),
          z.number(),
          z.boolean(),
          z.record(z.string(), z.unknown()),
          z.array(z.unknown()),
        ]),
      )
      .optional()
      .describe(
        '输入变量（键与类型以 workflow_read 各工作流的输入说明为准；number 直传、enum 限值域、date 为 yyyy-MM-dd、json 为对象/数组原生直传）',
      ),
  });

  const run: ToolDefinition<z.infer<typeof runSchema>> = {
    name: 'run_workflow',
    description:
      '异步试运行工作流（真实执行，受理即返 runId）；inputs 键与类型以 workflow_read 各工作流的「输入」说明为准（number 直传数值、enum 限值域、date 为 yyyy-MM-dd、json 为对象/数组原生直传）；写操作需批准',
    parameters: runSchema,
    kind: 'write',
    execute: async (ctx, args) => {
      const userId = userIdOf(ctx);
      const row = await deps.prisma.graphDefinition.findFirst({
        where: { id: args.id, userId },
      });
      if (!row) {
        return '错误: 工作流不存在（可先用 workflow_read 无参清单核对 id）';
      }
      const normalized = normalizeInputsForGraph(
        row.graphJson,
        args.inputs ?? {},
      );
      if (!normalized.ok) {
        return normalized.error;
      }
      try {
        const { runId } = await deps.runGraph({
          graphId: args.id,
          inputs: normalized.inputs,
          // ctx.workspaceId 缺席时 GraphService 挂用户最近空间（server 约定）
          ...(ctx.workspaceId !== undefined
            ? { workspaceId: ctx.workspaceId }
            : {}),
        });
        return `已启动试运行（runId=${runId}）。结果可稍后调用 get_workflow_run 查询`;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.includes('GRAPH_ALREADY_RUNNING')) {
          return '错误: 该工作流正在运行中（同一图同时至多一个试运行），请稍后用 get_workflow_run 查询';
        }
        if (message.includes('WORKSPACE_NOT_FOUND')) {
          return '错误: 未找到可用工作空间，请先在控制端建工作空间';
        }
        return `错误: 启动失败 ${message}`;
      }
    },
  };

  const getRunSchema = z.object({
    id: z.number().int().positive().describe('工作流 id'),
  });

  const getRun: ToolDefinition<z.infer<typeof getRunSchema>> = {
    name: 'get_workflow_run',
    description: '查工作流最近一次运行结果（状态/输出/失败原因）；勿高频轮询',
    parameters: getRunSchema,
    kind: 'read',
    execute: async (ctx, args) => {
      const userId = userIdOf(ctx);
      const graph = await deps.prisma.graphDefinition.findFirst({
        where: { id: args.id, userId },
      });
      if (!graph) {
        return '错误: 工作流不存在（可先用 workflow_read 无参清单核对 id）';
      }
      const run = await deps.prisma.automationRun.findFirst({
        where: { graphId: args.id },
        orderBy: { startedAt: 'desc' },
      });
      if (!run) {
        return '暂无运行记录（run_workflow 触发后此处可查）';
      }
      const lines = [
        `运行 ${run.status}（runId=${run.id}，开始于 ${run.startedAt.toISOString()}）`,
        `耗时: ${run.durationMs === null ? '-' : `${(run.durationMs / 1000).toFixed(1)}s`}`,
      ];
      if (run.error) {
        lines.push(`失败原因: ${run.error}`);
      }
      // 终点完整输出（≤4000 截断）：graphRunNode 全量反查（mirror 同款
      // 透传通道——trace 预览仅 200 字，行集结果回喂需全量）
      const preview = lastSuccessPreview(run.graphTrace);
      if (preview != null) {
        lines.push(`输出: ${preview}`);
      }
      const nodes = await deps.prisma.graphRunNode.findMany({
        where: { runId: run.id },
      });
      const nodeId = lastSuccessNodeId(run.graphTrace);
      const finalRow = nodes.find(
        (row) => row.nodeId === nodeId && row.status === 'success',
      );
      if (finalRow?.output) {
        lines.push(
          finalRow.output.length > 4000
            ? `完整输出: ${finalRow.output.slice(0, 4000)}…（已截断）`
            : `完整输出: ${finalRow.output}`,
        );
      }
      return lines.join('\n');
    },
  };

  function lastSuccessNodeId(graphTrace: string | null): string | undefined {
    if (!graphTrace) {
      return undefined;
    }
    try {
      const entries = JSON.parse(graphTrace) as Array<{
        id?: string;
        status?: string;
      }>;
      const hit = [...entries]
        .reverse()
        .find((entry) => entry.status === 'success');
      return typeof hit?.id === 'string' ? hit.id : undefined;
    } catch {
      return undefined;
    }
  }

  function lastSuccessPreview(graphTrace: string | null): string | null {
    if (!graphTrace) {
      return null;
    }
    try {
      const entries = JSON.parse(graphTrace) as Array<{
        status?: string;
        outputPreview?: string;
      }>;
      const hit = [...entries]
        .reverse()
        .find((entry) => entry.status === 'success');
      return hit?.outputPreview ?? null;
    } catch {
      return null;
    }
  }

  return [write, read, run, getRun];
}

/** ============ E2 cookbook（桌面 graph-cookbook.ts 同源复刻） ============ */

export const WORKFLOW_NODE_COOKBOOK = `【节点速查】输入输出均为文本（节点间引用 {{nodes.<id>.output}}，输入变量 {{input.x}}）
- 流程骨架：start（图入口/变量声明载体）｜llm（模型调用，modelId+prompt）｜condition（规则分支）｜intent（语义路由）｜delay（等待）｜subflow（调用已存图，graphId）｜iterate（循环执行子图）｜merge（多上游模板聚合）
- 数据：database（SQL+params 参数化；sqlite 走 sqlitePath 工作空间相对路径，外部库可 dataSourceId 引数据源配置）｜variable（变量轻量变换）｜aggregate（行集统计）｜jsonParse（按 path 提取）/jsonStringify（转 JSON 字面量）
- 文件与表：fileRead/fileWrite（工作空间内读写）｜docExtract（PDF/Word→文本）｜excelRead/excelWrite｜csvRead/csvWrite｜librarySearch（资料库关键词）
- 外联：http（请求）｜email（SMTP）｜notify（桌面通知+IM webhook）｜imageGen（图像）
- 向量：vectorize（入库）/vectorSearch（语义检索）

【常用范式】
1. 建/改表：database 节点跑 DDL（CREATE TABLE IF NOT EXISTS …，幂等）
2. 查询渲染：database(SELECT 参数化)→merge 模板直嵌行集组装展示结构（勿用 code 节点，打包态依赖系统 node）；聚合标量用 jsonParse(path "0.x") 提取后入 merge 模板
3. LLM 加工：llm 节点（prompt 引 {{input.x}}/{{nodes.*.output}}）→结果交 show_summary/show_chart 渲染（show_* 为聊天展示工具，非节点）
4. 写类工作流经 run_workflow 触发（写操作走审批门——manual 模式挂远程应答、其余模式自动拒，config accessMode 决定）

【输入声明】inputSchema 支持对象形态 {type:"string"|"number"|"boolean"|"enum"|"date"|"json", required?, default?（json 为对象/数组）, enumValues?(enum 必填), description?}——number 参数原生传库免 CAST，enum 收口值域，date 归一 yyyy-MM-dd（default "today"=执行日），json 对象/数组原生直传（模板 {{input.x}} 处紧凑 stringify；支持字段路径 {{input.x.field}}，数字段为数组下标 {{input.x.items.0.id}}，叶子标量 String()/容器 stringify）

【照猫画虎】动手前先 workflow_read 看同类图（id 可无参清单查，如「记账」三件是 database+merge 范式的现成样板）`;
