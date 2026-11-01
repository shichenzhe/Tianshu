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
 * 2026-10-29 并行批并入（合并双线）：会话应用作用域（切片 C——run/read/
 * write 按会话 appId 收窄，新建图自动入应用集合）、typed 输入链（切片 D
 * ——run_workflow 输入按 inputSchema 归一校验，清单附类型摘要）、校验回喂
 * 与描述软检查（切片 E——字段级可自纠问题清单 + description 补写提示）、
 * get_workflow_run 终点完整输出（graphRunNode 反查）。
 */
import { z } from "zod";
import {
  normalizeGraph,
  validateGraph,
  normalizeGraphInputs,
  parseInputSchema,
  type GraphInputValue,
} from "../../../../src-react/domains/ai/orchestration/api/graph.schema";
import type { ToolContext, ToolDefinition } from "../agent/file-tools";
import { graphTestInflight } from "./graph-inflight";
import { WORKFLOW_NODE_COOKBOOK } from "./graph-cookbook";

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
      /** typed 输入摘要（切片 D4）：workflow_read 清单需读 inputSchema 供
       *  LLM 填参——prisma findMany 本就返回全标量列，接口面补声明 */
      graphJson?: string;
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
 * 会话应用作用域（切片 C P1）：run/workflow_read/workflow_write 的可见集合
 * 在此收窄——比 filterToolsBySession（纯函数、按工具名）更顺的层次是工具
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
  return formatGraphIssues(issues);
}

/** 回喂行数上限（LLM 上下文友好；超出折叠计数） */
const FEEDBACK_ISSUE_LIMIT = 12;

/** 图级（非 schema）错误码 → 中文一句话（含期望形态） */
const GRAPH_ISSUE_HINTS: Record<string, string> = {
  duplicateNodeId: "节点 id 重复——每个节点 id 必须唯一（kebab-case）",
  reservedNodeId: "节点 id 占用了保留字（inputs/nodes/route）——换一个 id",
  uniqueEntry:
    "入口不唯一——全图必须恰有一个无入边的节点（start→首业务节点），请检查连线",
  danglingEdge:
    "边引用了不存在的节点 id——边的 from/to 须指向图中节点（终点可为 END）",
  conditionNotBranchable:
    "条件边挂在非分支节点上——只有 condition/intent/分支模式 llm/code 可挂条件边",
  conditionValueOutOfRange:
    "条件边的 label 不在源节点分支选项内——须为分支名或兜底名之一",
  branchOptionsRequired: "分支模式节点必须携带非空 branchOptions",
  iterateItemsRequired: "循环节点（array 模式）必须提供 itemsSource 表达式",
  iterateCountRequired: "循环节点（count 模式）必须提供 countSource",
  iterateBreakRequired: "循环节点（while 模式）必须提供 breakCondition",
  duplicateStartNode: "start 节点至多一个",
  startIncomingEdge: "start 节点不得有入边",
};

/** 常见误填字段的期望形态（按 path 末段匹配；inputSchema 前缀特判） */
const FIELD_EXPECTATIONS: Record<string, string> = {
  modelId: "正整数（模型表 id）",
  prompt: "非空字符串（支持 {{input.x}}/{{nodes.<id>.output}} 占位）",
  script: "非空脚本文本",
  language: "nodejs / python / bash 三者之一",
  engine: "sqlite / postgres / mysql / oracle / sqlserver 之一",
  sqlitePath: "SQLite 文件相对工作空间的路径（如 demo.db）",
  sql: "单条 SQL 文本（值用 ? 占位、经 params 参数化，勿内插）",
  params: '字符串数组，如 ["{{input.amount}}","{{input.category}}"]',
  variables: '字符串数组（变量名清单，如 ["amount","category"]）',
  url: "完整 URL（支持 {{}} 占位）",
  graphId: "子工作流的真实 id（正整数，可用 workflow_read 查）",
  inputs: "键值数组 [{key, value}]，value 支持 {{}} 占位",
  timeoutMs: "毫秒数（整数，按各节点上限）",
  maxRows: "正整数（行数上限）",
  retries: "0-5 的整数",
  position: "{x: 数值, y: 数值}（画布坐标，可省略）",
};

/** inputSchema 路径 → 期望形态（D 批双形态） */
const INPUT_SCHEMA_EXPECTATION =
  '简写 "string" 或对象 {type: "string"|"number"|"boolean"|"enum"|"date", required?, default?, enumValues?（enum 必填非空不重复）, description?}';

/** zod 英文消息 → 中文 + 期望（模式表；未命中原样透传——自定义
 *  superRefine 消息本就是中文） */
function translateZodMessage(message: string): string {
  if (/^Required$/.test(message)) {
    return "缺少必填字段";
  }
  // 兼容 zod 各版消息形态：value. / value(s).
  const enumMatch =
    /^Invalid enum value(?:\(s\))?\.\s*Expected (.+?)(?:,|$|\.)/.exec(message);
  if (enumMatch) {
    return `取值必须是 ${enumMatch[1]} 之一`;
  }
  const literalMatch = /^Invalid literal value,\s*expected (.+)$/.exec(message);
  if (literalMatch) {
    return `取值必须是 ${literalMatch[1]}`;
  }
  if (/String must contain at least 1 character/.test(message)) {
    return "不能为空串";
  }
  // zod v4 缺字段/类型不符形态（union 展开后到达此处）
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
  if (/^Expected (.+?), received (.+)$/.test(message)) {
    return message.replace(
      /^Expected (.+?), received (.+)$/,
      "类型应为 $1（收到 $2）",
    );
  }
  if (message === "Invalid input") {
    // union 塌缩的裸消息（如 inputSchema 联合）——形态提示在期望行
    return "取值或形态不符";
  }
  if (/Number must be/.test(message) || /^Invalid input/.test(message)) {
    return `数值/格式不符：${message}`;
  }
  return message;
}

/** path 的字段尾段（inputSchema.amount.type → inputSchema 期望特判） */
function expectationOf(path: string): string | null {
  if (path.startsWith("inputSchema")) {
    return INPUT_SCHEMA_EXPECTATION;
  }
  const tail = path.split(".").pop() ?? path;
  return FIELD_EXPECTATIONS[tail] ?? null;
}

/**
 * 校验问题 → 字段级可自纠回喂（切片 E1）：哪个节点哪个字段什么问题、
 * 期望什么形态；zod 英文译中文、图级错误码带一句话期望；超限折叠。
 * 供 workflow_write 新建/修改两分支共用，导出直测
 */
export function formatGraphIssues(
  issues: Array<{ code: string; params?: Record<string, string | number> }>,
): string {
  const total = issues.length;
  const lines: string[] = [];
  for (const issue of issues.slice(0, FEEDBACK_ISSUE_LIMIT)) {
    if (issue.code !== "schema") {
      lines.push(`- ${GRAPH_ISSUE_HINTS[issue.code] ?? issue.code}`);
      continue;
    }
    const params = issue.params ?? {};
    const path = typeof params.path === "string" ? params.path : "";
    const nodeId = typeof params.nodeId === "string" ? params.nodeId : null;
    const message =
      typeof params.message === "string" ? params.message : String(issue.code);
    const where = nodeId
      ? `节点「${nodeId}」${path.replace(/^nodes\.[^.]+\./, "")}`
      : `图级 ${path || "(根)"}`;
    const translated = translateZodMessage(message);
    const expectation = expectationOf(path);
    lines.push(
      `- ${where}：${translated}${expectation ? `。期望：${expectation}` : ""}`,
    );
  }
  if (total > FEEDBACK_ISSUE_LIMIT) {
    lines.push(
      `- …另有 ${total - FEEDBACK_ISSUE_LIMIT} 项问题（同类修正即可）`,
    );
  }
  return lines.join("\n");
}

/** 字段 → LLM 可读摘要（切片 D4）：amount:number(必填) /
 *  category:enum[餐饮|交通](可选，默认:餐饮) / spent_at:date(必填，默认:当天) */
function formatInputField(field: {
  key: string;
  type: string;
  required: boolean;
  default?: string | number | boolean;
  enumValues?: string[];
}): string {
  const head =
    field.type === "enum" && field.enumValues?.length
      ? `${field.key}:enum[${field.enumValues.join("|")}]`
      : `${field.key}:${field.type}`;
  const qualifiers = [field.required ? "必填" : "可选"];
  if (field.default !== undefined) {
    qualifiers.push(
      `默认:${field.default === "today" ? "当天" : String(field.default)}`,
    );
  }
  return `${head}(${qualifiers.join("，")})`;
}

/** 图行 graphJson → typed 输入摘要行（无声明/解析失败返回 null） */
export function inputSummaryOf(graphJson: string | undefined): string | null {
  if (typeof graphJson !== "string" || graphJson === "") {
    return null;
  }
  try {
    const schema = (JSON.parse(graphJson) as { inputSchema?: unknown })
      .inputSchema;
    const fields = parseInputSchema(schema as Record<string, unknown>);
    return fields.length > 0
      ? fields.map((field) => formatInputField(field)).join("，")
      : null;
  } catch {
    return null;
  }
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

export function makeWorkflowWriteTool(deps: {
  graphDefinition: WorkflowGraphPrismaLike;
  session: SessionPrismaLike;
  /** 会话应用作用域（切片 C）：应用会话内新建的图自动入应用集合 */
  app?: AppDefinitionPrismaLike;
  /** 写库成功后通知（repo 注 notifyGraphsChanged 广播渲染层失效——
   *  全局 staleTime 30s 失效驱动，工具写库无此广播则列表页 30s 内
   *  不见新图；纯 Node 禁 electron 故经注入） */
  notify?: () => void;
}): ToolDefinition<z.infer<typeof workflowWriteSchema>> {
  return {
    name: "workflow_write",
    description: `新建或修改工作流（无 id=新建，name+graphJson 必填；id+version=修改，先 workflow_read 取 version；校验失败按节点/字段返回可自纠问题清单；应用会话内创建会自动加入该应用）；写操作需批准。\n${WORKFLOW_NODE_COOKBOOK}`,
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
          return `校验未通过（问题按「节点/字段/原因/期望」逐条列出），请修正 graphJson 后重试（节点规范可 read_skill 读取 workflow-creator 技能）：\n${formatIssues(result.issues)}`;
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
          // 应用会话内新建 → 自动入应用集合（切片 C 作用域闭环：新建的
          // 图立即可被本会话 run/read 看见）；悬空绑定不入集（应用已删）
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
          const hints = descriptionHints({
            description: args.description,
            inputSchema: result.value.inputSchema,
          });
          return `成功: 工作流「${row.name}」已创建（id=${row.id}），可在左侧「工作流」页面查看与编辑${appNote}${hints.length ? `\n${hints.join("\n")}` : ""}`;
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
      let hints: string[] = [];
      if (args.graphJson !== undefined) {
        const result = validateGraph(args.graphJson);
        if (!result.ok) {
          return `校验未通过（问题按「节点/字段/原因/期望」逐条列出），请修正 graphJson 后重试：\n${formatIssues(result.issues)}`;
        }
        serialized = JSON.stringify(normalizeGraph(result.value));
        hints = descriptionHints({
          description: args.description,
          inputSchema: result.value.inputSchema,
        });
        // description 提示降噪（切片 E3）：本次未传且库中已有描述则不提
        if (args.description === undefined) {
          const existing = await deps.graphDefinition.findFirst({
            where: { id: args.id, userId },
          });
          if (existing?.description) {
            hints = hints.filter((hint) => !hint.startsWith("提示：未写"));
          }
        }
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
      return `成功: 工作流 id=${args.id} 已更新（新 version=${args.version + 1}）${hints.length ? `\n${hints.join("\n")}` : ""}`;
    },
  };
}

/** workflow_read：无参=已保存清单（id/名称/说明/输入类型摘要，供子图
 *  引用查真实 graphId；应用会话内仅列该应用的工作流——切片 C）；id/name
 *  二选一=单图完整定义（修改前必取 version——乐观锁） */
export function makeWorkflowReadTool(deps: {
  graphDefinition: WorkflowGraphPrismaLike;
  session: SessionPrismaLike;
  /** 会话应用作用域（切片 C）：应用会话内仅列该应用的工作流 */
  app?: AppDefinitionPrismaLike;
}): ToolDefinition<z.infer<typeof workflowReadSchema>> {
  return {
    name: "workflow_read",
    description:
      "读取工作流：无参=已保存清单（id/名称/说明/输入类型摘要，应用会话内仅该应用的工作流）；带 id 或 name=完整定义（修改前必先调用取 version）",
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
        // typed 输入摘要（切片 D4）：每行附输入说明——LLM 填参的类型面
        //（静态工具描述无法按会话拼数据，list 即每请求可见的类型描述位）
        const listing = visible
          .map((row) => {
            const summary = inputSummaryOf(row.graphJson);
            return `id=${row.id} ${row.name}${row.description ? ` — ${row.description}` : ""}${summary ? ` · 输入: ${summary}` : ""}`;
          })
          .join("\n");
        if (scope && !scope.dangling) {
          return `当前会话已绑定应用「${scope.name}」，仅列出该应用的工作流：\n${listing}`;
        }
        if (scope?.dangling) {
          return `${listing}\n（注：会话绑定的应用已不存在，暂列全部工作流，可让用户重新绑定）`;
        }
        return listing;
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
 * fire-and-forget；测试注 stub 免拉 executor 重依赖。inputs 为 typed
 * 归一后值——切片 D） */
export type LaunchTestRunFn = (params: {
  graph: WorkflowGraphRow;
  inputs: Record<string, GraphInputValue>;
  workspace: { id: number; directoryPath: string | null };
}) => void;

const runWorkflowSchema = z.object({
  id: z.number().int().positive().describe("要运行的工作流 id"),
  inputs: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe(
      "输入变量（键与类型以 workflow_read 清单返回的输入说明为准；number 直传、boolean 为 true/false、enum 须在值域内）",
    ),
});

/** 描述完整性软检查（切片 E3）：成功回执追加提示引导补写（不阻断）
 *  ——workflow_read 的类型摘要行+描述是 LLM 选工作流的全部依据 */
function descriptionHints(params: {
  description?: string | null;
  /** 已校验通过的图（取归一后的 inputSchema） */
  inputSchema: Record<string, unknown>;
}): string[] {
  const hints: string[] = [];
  if (!params.description || params.description.trim() === "") {
    hints.push(
      "提示：未写 description——workflow_read 按名称+描述路由选图，建议 workflow_write 补一句用途说明",
    );
  }
  const missing = parseInputSchema(params.inputSchema)
    .filter((field) => !field.description)
    .map((field) => field.key);
  if (missing.length > 0) {
    hints.push(
      `提示：输入变量 [${missing.join("、")}] 未写 description，建议补写（类型摘要行含描述更利填参）`,
    );
  }
  return hints;
}

/** 图 graphJson → 入口归一（切片 D，run_workflow 用）：required 校验 +
 * default 填充 + 类型归一；schema 不可解析按无声明直通（旧图不设障） */
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
    return { ok: true, inputs: raw as Record<string, GraphInputValue> };
  }
  const result = normalizeGraphInputs(
    parseInputSchema(schema as Record<string, unknown>),
    raw,
  );
  if (!result.ok) {
    return {
      ok: false,
      error: `错误: 输入参数无效：\n${result.issues.map((issue) => `- ${issue.message}`).join("\n")}`,
    };
  }
  return { ok: true, inputs: result.inputs };
}

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
      "异步试运行工作流（真实执行，触发即返；应用会话内仅可运行该应用的工作流）；inputs 键与类型以 workflow_read 清单各工作流的「输入」说明为准（number 直传数值、enum 限值域、date 为 yyyy-MM-dd）；写操作需批准",
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
      // 应用作用域闸（切片 C）：集合外的工作流对该会话不可运行——
      // 悬空绑定不拦（应用已删，按未作用域处理）
      const scope = await resolveSessionAppScope(
        ctx,
        deps.session,
        deps.app,
        userId,
      );
      if (scope && !scope.dangling && !scope.graphIds.has(args.id)) {
        return `错误: 工作流 id=${args.id} 不在当前应用「${scope.name}」的作用域内（该应用的可用工作流见 workflow_read 清单）`;
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
      // 入口归一（切片 D）：按图 inputSchema 做 required 校验 + default
      // 填充 + 类型归一——缺参/类型不符在此结构化回喂（模型可自纠重试），
      // 不再等模板渲染期才炸「模板变量未定义」
      const normalized = normalizeInputsForGraph(
        row.graphJson,
        args.inputs ?? {},
      );
      if (!normalized.ok) {
        return normalized.error;
      }
      deps.launch({
        graph: row,
        inputs: normalized.inputs,
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
 *  预览/失败原因）；graphTrace 缺失时只报状态。终点完整输出自 graphRunNode
 *  节点级详情行反查（demo 切片 2026-10-28：trace 预览仅 200 字，查账明细
 *  一类行集结果会被截断，聊天模型拿不到全量即无法透传 show_table 渲染——
 *  runNodes delegate 缺席时回退仅预览，行为与旧装配一致） */
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
 *  经 id 反查 graphRunNode；executor traceSuccess 只写 outputPreview——
 *  200 字截断，无 output 字段；无 success 条目/解析失败返回 null） */
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
 *  空输出 → null——保持「无则不附加」的旧形态） */
async function finalNodeOutput(
  runNodes: WorkflowRunNodePrismaLike,
  runId: number,
  nodeId: string,
): Promise<string | null> {
  const rows = await runNodes.findMany({ where: { runId } });
  const row = rows.find((r) => r.nodeId === nodeId && r.status === "success");
  return row?.output ? row.output : null;
}
