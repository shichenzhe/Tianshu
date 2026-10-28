// src-react/domains/ai/orchestration/lib/graph-editor-model.ts
/**
 * 图编辑器双模式状态纯函数（spec §7）：JSON 容错解析、统一序列化、节点/
 * 边结构化编辑（改 id 同步边引用、删节点级联删边）、模板预填与保存可用
 * 性判定。组件只做接线，可测逻辑收口在此（先例 automation/lib/task-form.ts）。
 */
import {
  graphJsonSchema,
  isLlmNode,
  validateGraph,
  type CodeNode,
  type DatabaseNode,
  type ExcelReadNode,
  type ExcelWriteNode,
  type CsvReadNode,
  type CsvWriteNode,
  type VariableNode,
  type AggregateNode,
  type EmailNode,
  type MergeNode,
  type FileReadNode,
  type GraphEdge,
  type GraphIssue,
  type GraphJson,
  type GraphNode,
  type HttpNode,
  type IterateNode,
  type LibrarySearchNode,
  type JsonParseNode,
  type JsonStringifyNode,
  type ConditionNode,
  type IntentNode,
  type DelayNode,
  type VectorSearchNode,
  type VectorizeNode,
  type DocExtractNode,
  type FileWriteNode,
  type ImageGenNode,
  type LlmNode,
  type NotifyNode,
  type StartNode,
  type SubflowNode,
} from "../api/graph.schema";
import type { GraphTemplate } from "../api/orchestration.api";

/** 编辑模式：画布（默认主模式）⇄ JSON 源码 */
export type EditorMode = "canvas" | "json";

/** 保存比对快照：名称/描述/规范化 graphJson */
export interface DraftSnapshot {
  name: string;
  description: string;
  graphJson: string;
}

/** 结构化模式局部补丁（可选字段允许显式 undefined = 清除）。
 * kind 字段冲突使直接交叉坍缩为 never——剔除 kind 后取交叉（宽松单字段
 * 透传，kind 分流走 switchNodeKind 专口） */
export type GraphNodePatch = Partial<Omit<StartNode, "kind">> &
  Partial<Omit<LlmNode, "kind">> &
  Partial<Omit<CodeNode, "kind">> &
  Partial<Omit<HttpNode, "kind">> &
  Partial<Omit<FileReadNode, "kind">> &
  Partial<Omit<NotifyNode, "kind">> &
  Partial<Omit<SubflowNode, "kind">> &
  Partial<Omit<IterateNode, "kind">> &
  Partial<Omit<LibrarySearchNode, "kind">> &
  Partial<Omit<JsonParseNode, "kind">> &
  Partial<Omit<ConditionNode, "kind">> &
  Partial<Omit<IntentNode, "kind">> &
  Partial<Omit<FileWriteNode, "kind">> &
  Partial<Omit<DocExtractNode, "kind">> &
  Partial<Omit<ImageGenNode, "kind">> &
  Partial<Omit<DelayNode, "kind">> &
  Partial<Omit<VectorizeNode, "kind">> &
  Partial<Omit<VectorSearchNode, "kind">> &
  Partial<Omit<DatabaseNode, "kind">> &
  Partial<Omit<ExcelReadNode, "kind">> &
  Partial<Omit<ExcelWriteNode, "kind">> &
  Partial<Omit<CsvReadNode, "kind">> &
  Partial<Omit<CsvWriteNode, "kind">> &
  Partial<Omit<VariableNode, "kind">> &
  Partial<Omit<AggregateNode, "kind">> &
  Partial<Omit<EmailNode, "kind">> &
  Partial<Omit<MergeNode, "kind">>;

export const NODE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** 新节点默认：modelId 0 占位（zod 拦保存，引导先选模型）；异常处理
 * 缺省：180s 超时/不重试/中断（与 schema default 同口径，编辑器态
 * 未过 zod 也须完整） */
export function newNode(id: string): GraphNode {
  return {
    id,
    name: "",
    kind: "llm",
    modelId: 0,
    prompt: "",
    tools: false,
    outputMode: "text",
    timeoutMs: 180_000,
    retries: 0,
    onError: "abort",
  };
}

/** 开始节点默认：固定中文名「开始」（i18n 无关常量，画布展示由 name
 * 承载）、空输入变量表 */
export function newStartNode(id: string): StartNode {
  return { id, name: "开始", kind: "start", variables: [] };
}

/** 代码节点默认：bash 起步、空脚本、30s 超时、text 输出 */
export function newCodeNode(id: string): CodeNode {
  return {
    id,
    name: "",
    kind: "code",
    language: "bash",
    script: "",
    timeoutMs: 30_000,
    outputMode: "text",
    retries: 0,
  };
}

/** 节点类型联合（编辑器 kind 切换/加节点入口） */
export type NodeKind =
  | "start"
  | "llm"
  | "code"
  | "http"
  | "fileRead"
  | "notify"
  | "subflow"
  | "iterate"
  | "librarySearch"
  | "jsonParse"
  | "jsonStringify"
  | "condition"
  | "intent"
  | "fileWrite"
  | "docExtract"
  | "imageGen"
  | "delay"
  | "vectorize"
  | "vectorSearch"
  | "database"
  | "excelRead"
  | "excelWrite"
  | "csvRead"
  | "csvWrite"
  | "variable"
  | "aggregate"
  | "email"
  | "merge";

/** HTTP 节点默认：GET、空 URL/头参、无鉴权、无 body、不重试、120s 超时 */
export function newHttpNode(id: string): HttpNode {
  return {
    id,
    name: "",
    kind: "http",
    method: "GET",
    url: "",
    headers: [],
    query: [],
    auth: { type: "none" },
    bodyType: "none",
    retries: 0,
    timeoutMs: 120_000,
  };
}

/** method 切到带体方法（POST/PUT/PATCH）且 bodyType 尚为 none 时建议
 * json（请求体输入区随方法自动出现，免手动先切 Body 类型）；GET/DELETE
 * 与已显式选过的类型不干预 */
export function suggestHttpBodyType(
  method: HttpNode["method"],
  currentBodyType: HttpNode["bodyType"],
): HttpNode["bodyType"] {
  return method !== "GET" && method !== "DELETE" && currentBodyType === "none"
    ? "json"
    : currentBodyType;
}

/** 文件读取节点默认：空路径（工作空间内相对/绝对皆可） */
export function newFileReadNode(id: string): FileReadNode {
  return { id, name: "", kind: "fileRead", path: "" };
}

/** 通知节点默认：空标题、仅桌面通知（webhook 关） */
export function newNotifyNode(id: string): NotifyNode {
  return {
    id,
    name: "",
    kind: "notify",
    title: "",
    body: "",
    webhookProvider: "none",
    webhookUrl: "",
  };
}

/** 子工作流节点默认：graphId 0 占位（属性面板选图后生效） */
export function newSubflowNode(id: string): SubflowNode {
  return {
    id,
    name: "",
    kind: "subflow",
    graphId: 0,
    inputs: [],
    async: false,
  };
}

/** 循环节点默认：数组模式、来源 {{nodes.x.output}}、每项注入 item、
 * 上限 100 */
export function newIterateNode(id: string): IterateNode {
  return {
    id,
    name: "",
    kind: "iterate",
    loopMode: "array",
    itemsSource: "",
    graphId: 0,
    itemVariable: "item",
    carryInitial: "",
    maxItems: 100,
    concurrency: 1,
    onItemError: "abort",
  };
}

/** 资料库检索节点默认：空关键词、最多 5 段命中 */
export function newLibrarySearchNode(id: string): LibrarySearchNode {
  return { id, name: "", kind: "librarySearch", keywords: "", maxResults: 5 };
}

/** 节点类型切换：id/name/分支配置保留、其余专属字段按目标类型重建/
 * 丢弃，边引用不动（引用键是 id）；同 kind 原样返回（保持引用相等便于
 * memo）。分支配置跨 llm/code 保留（http v1 无分支） */
export function switchNodeKind(
  graph: GraphJson,
  nodeId: string,
  kind: NodeKind,
): GraphJson {
  const target = graph.nodes.find((node) => node.id === nodeId);
  if (!target || target.kind === kind) {
    return graph;
  }
  const shared =
    (target.kind === "llm" || target.kind === "code") &&
    target.outputMode === "branch"
      ? {
          outputMode: "branch" as const,
          ...(target.branchOptions?.length
            ? { branchOptions: target.branchOptions }
            : {}),
        }
      : {};
  const rebuilt: GraphNode = {
    ...FACTORY[kind](nodeId),
    name: target.name,
    ...shared,
  };
  return {
    ...graph,
    nodes: graph.nodes.map((node) => (node.id === nodeId ? rebuilt : node)),
  };
}

/** 空图骨架：start 起点直连首 llm（校验问题引导补名称/提示词/模型） */
export function emptyGraph(): GraphJson {
  return {
    version: 1,
    inputSchema: {},
    nodes: [FACTORY.start("start"), newNode("node-1")],
    edges: [{ from: "start", to: "node-1" }],
  };
}

/** start 节点变量编辑：节点与 inputSchema 同一次提交同步写
 *  （inputSchema 仍为执行/试运行/AI 协议的读取单一事实源）；输入兜底
 *  去重（StringListInput 默认去重，JSON 手改/AI 生成的入参再保一道，
 *  保证节点 variables 与 inputSchema 键一致） */
export function patchStartVariables(
  graph: GraphJson,
  variables: string[],
): GraphJson {
  const unique = [...new Set(variables)];
  return {
    ...graph,
    inputSchema: Object.fromEntries(unique.map((key) => [key, "string"])),
    nodes: graph.nodes.map((node) =>
      node.kind === "start" ? { ...node, variables: unique } : node,
    ),
  };
}

/** 下一个可用节点 id：node-<最大序号+1>（自定义 id 不占序号） */
export function nextNodeId(nodes: GraphNode[]): string {
  let max = 0;
  for (const node of nodes) {
    const matched = /^node-(\d+)$/.exec(node.id);
    if (matched) {
      max = Math.max(max, Number(matched[1]));
    }
  }
  return `node-${max + 1}`;
}

/** JSON 容错解析：语法错或不符合 GraphJson 形状 → parsed null（禁切回结构化） */
export function parseOrKeep(raw: string): { parsed: GraphJson | null } {
  const parsed = graphJsonSchema.safeParse(safeJsonParse(raw));
  return parsed.success ? { parsed: parsed.data } : { parsed: null };
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** 统一序列化：双模式往返、保存提交、变更比对共用同一形态 */
export function serializeGraph(graph: GraphJson): string {
  return JSON.stringify(graph, null, 2);
}

/** 已存 graphJson 串 → 规范形态（解析失败原样返回，保守视为有变更） */
export function canonicalJson(raw: string): string {
  const { parsed } = parseOrKeep(raw);
  return parsed ? serializeGraph(parsed) : raw;
}

const TEMPLATE_PREFILL_KEY = "tianshu:graph-template-prefill";

/** 预填快照存储抽象（注入便于单测；组件传 sessionStorage） */
export interface SnapshotStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function isGraphTemplate(value: unknown): value is GraphTemplate {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as GraphTemplate).titleI18nKey === "string" &&
    typeof (value as GraphTemplate).graphJson === "object" &&
    (value as GraphTemplate).graphJson !== null
  );
}

/** 读模板预填（GraphEditorView 挂载一次性消费）：路由 state 命中 → 写
 * 快照供下一次挂载；state 空 → 读快照（命中即删）。StrictMode 双挂载
 * 时预填消费 effect 已 replace 清掉路由 state，第二次挂载的 useState
 * 初始化器重跑读不到——快照兜底，防「从模板新建却是空图」；快照命中即
 * 删则保持「刷新/后退不重复预填」的原语义 */
export function readTemplatePrefill(
  state: unknown,
  storage?: SnapshotStorage,
): GraphTemplate | undefined {
  const fromState = (state as { graphTemplate?: unknown } | null)
    ?.graphTemplate;
  if (isGraphTemplate(fromState)) {
    try {
      storage?.setItem(TEMPLATE_PREFILL_KEY, JSON.stringify(fromState));
    } catch {
      // 快照写失败不阻断预填（下次挂载退化为旧行为）
    }
    return fromState;
  }
  let raw: string | null;
  try {
    raw = storage?.getItem(TEMPLATE_PREFILL_KEY) ?? null;
  } catch {
    raw = null;
  }
  if (raw === null) {
    return undefined;
  }
  try {
    storage?.removeItem(TEMPLATE_PREFILL_KEY);
  } catch {
    // 同上，尽力而为
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isGraphTemplate(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** t 签名同 run-display.ts 款（纯函数，文案走 i18n 便于测试复用） */
type TFunc = (key: string, opts?: Record<string, unknown>) => string;

/** 校验问题 → 本地化文案：code 查 `validation.<code>` 键带插值（zod 层
 * code:"schema" 的 message 原样展示）；编辑器双模式红字清单共用 */
export function localizeGraphIssue(issue: GraphIssue, t: TFunc): string {
  return t(`chat:orchestration.validation.${issue.code}`, issue.params);
}

/** JSON 模式实时校验出口：语法失败 issues 为空（调用方补「解析失败」文案） */
export function validateRaw(raw: string): {
  ok: boolean;
  issues: GraphIssue[];
} {
  try {
    const result = validateGraph(JSON.parse(raw));
    return result.ok
      ? { ok: true, issues: [] }
      : { ok: false, issues: result.issues };
  } catch {
    return { ok: false, issues: [] };
  }
}

/** 校验清单去噪：图内 >1 start 时 uniqueEntry 与 duplicateStartNode 双报
 *  （多余 start 必然多出无入边节点，uniqueEntry 只是同一病灶的衍生报），
 *  编辑器红字清单只保留 duplicateStartNode——修复指引更聚焦 */
export function dedupeUniqueEntry(issues: GraphIssue[]): GraphIssue[] {
  if (!issues.some((issue) => issue.code === "duplicateStartNode")) {
    return issues;
  }
  return issues.filter((issue) => issue.code !== "uniqueEntry");
}

/** 结构化改节点 id：同步改边引用；id 不合法/重复时原样返回 */
export function renameNode(
  graph: GraphJson,
  oldId: string,
  nextId: string,
): GraphJson {
  if (oldId === nextId || !NODE_ID_PATTERN.test(nextId)) {
    return graph;
  }
  if (graph.nodes.some((node) => node.id === nextId)) {
    return graph;
  }
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === oldId ? { ...node, id: nextId } : node,
    ),
    edges: graph.edges.map((edge) => ({
      ...edge,
      from: edge.from === oldId ? nextId : edge.from,
      to: edge.to === oldId ? nextId : edge.to,
    })),
  };
}

/** 删节点：级联删除其出/入边，防悬空引用 */
export function removeNode(graph: GraphJson, nodeId: string): GraphJson {
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => node.id !== nodeId),
    edges: graph.edges.filter(
      (edge) => edge.from !== nodeId && edge.to !== nodeId,
    ),
  };
}

/** 新边默认：首节点 → END（无节点时调用方禁用添加按钮） */
export function newEdge(graph: GraphJson): GraphEdge {
  return { from: graph.nodes[0]?.id ?? "", to: "END" };
}

/** 模板预填：后端模板必合法，防御性兜底空图骨架。模板 llm 节点的
 * modelId 为 0 占位（后端无法预知用户模型），过不了 schema 的
 * positive 校验——装载期临时抬 1 过校验、装载后还原 0（保存期
 * validateGraph 拦截引导选模型，newNode 同语义），否则 llm 模板装载
 * 必回退空图。iterate/subflow 的 graphId 0 占位（子图未选）同款处理 */
export function templateGraph(graphJson: object): GraphJson {
  const raw = JSON.parse(JSON.stringify(graphJson)) as {
    nodes?: Array<{ id?: unknown; modelId?: unknown; graphId?: unknown }>;
  };
  const placeholderModelIds = new Set<string>();
  const placeholderGraphIds = new Set<string>();
  for (const node of raw.nodes ?? []) {
    if (typeof node.id !== "string") {
      continue;
    }
    if (node.modelId === 0) {
      placeholderModelIds.add(node.id);
      node.modelId = 1;
    }
    if (node.graphId === 0) {
      placeholderGraphIds.add(node.id);
      node.graphId = 1;
    }
  }
  const parsed = graphJsonSchema.safeParse(raw);
  if (!parsed.success) {
    return emptyGraph();
  }
  return {
    ...parsed.data,
    nodes: parsed.data.nodes.map((node) => {
      const restore: Record<string, unknown> = {};
      if (isLlmNode(node) && placeholderModelIds.has(node.id)) {
        restore.modelId = 0;
      }
      if (
        (node.kind === "iterate" || node.kind === "subflow") &&
        placeholderGraphIds.has(node.id)
      ) {
        restore.graphId = 0;
      }
      return Object.keys(restore).length > 0 ? { ...node, ...restore } : node;
    }),
  };
}

/** 保存可用性一环：草稿相对基线无变化 → 不可保存（描述空白差异忽略） */
export function draftChanged(
  current: DraftSnapshot,
  baseline: DraftSnapshot,
): boolean {
  return (
    current.name !== baseline.name ||
    current.description.trim() !== baseline.description.trim() ||
    current.graphJson !== baseline.graphJson
  );
}

/** 超时秒输入 → timeoutMs（空/非法回退默认值；http 与向量节点字段区
 * 共用——code/llm 默认值不同，各自内联转换保留） */
export function timeoutSecToMs(raw: string, fallbackMs: number): number {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return fallbackMs;
  }
  const sec = Number(trimmed);
  return Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : fallbackMs;
}

/** JSON 反序列化节点默认：空来源、无路径、不展开数组 */
export function newJsonParseNode(id: string): JsonParseNode {
  return {
    id,
    name: "",
    kind: "jsonParse",
    source: "",
    path: "",
    arrayLines: false,
  };
}

/** JSON 序列化节点默认：空来源 */
export function newJsonStringifyNode(id: string): JsonStringifyNode {
  return { id, name: "", kind: "jsonStringify", source: "" };
}

/** 条件分支节点默认：单分支空条件（引导配置） */
export function newConditionNode(id: string): ConditionNode {
  return {
    id,
    name: "",
    kind: "condition",
    branches: [{ name: "分支一", conditions: [] }],
  };
}

/** 意图识别节点默认：模型待选（0 占位）、两意图示例、60s 超时 */
export function newIntentNode(id: string): IntentNode {
  return {
    id,
    name: "",
    kind: "intent",
    modelId: 0,
    querySource: "{{input.query}}",
    intents: [
      { name: "意图一", description: "" },
      { name: "意图二", description: "" },
    ],
    timeoutMs: 60_000,
  };
}

/** 文件写入节点默认：追加模式、空内容 */
export function newFileWriteNode(id: string): FileWriteNode {
  return {
    id,
    name: "",
    kind: "fileWrite",
    path: "",
    mode: "append",
    content: "",
  };
}

/** 文档提取节点默认：64KB 截断 */
export function newDocExtractNode(id: string): DocExtractNode {
  return { id, name: "", kind: "docExtract", path: "", maxChars: 64_000 };
}

/** 图像生成节点默认：openai 协议、modelId 0 占位（zod 拦保存引导先选
 * 模型）、1024 方图；comfyui 默认值同口径（randomizeSeed/timeoutMs） */
export function newImageGenNode(id: string): ImageGenNode {
  return {
    id,
    name: "",
    kind: "imageGen",
    protocol: "openai",
    modelId: 0,
    prompt: "",
    size: "1024x1024",
    randomizeSeed: true,
    timeoutMs: 300_000,
  };
}

/** 延时节点默认：60s */
export function newDelayNode(id: string): DelayNode {
  return { id, name: "", kind: "delay", seconds: 60 };
}

/** 向量化入库节点默认：空集合/条目/文本，模型 0 占位（选 Embedding 模型），
 * embedding 调用 120s 超时 */
export function newVectorizeNode(id: string): VectorizeNode {
  return {
    id,
    name: "",
    kind: "vectorize",
    collection: "",
    sourceName: "",
    text: "",
    modelId: 0,
    timeoutMs: 120_000,
    chunkSize: 500,
    chunkOverlap: 100,
  };
}

/** 语义检索节点默认：空集合（全集合）、空检索词、topK 5、120s 超时 */
export function newVectorSearchNode(id: string): VectorSearchNode {
  return {
    id,
    name: "",
    kind: "vectorSearch",
    collection: "",
    searchQuery: "",
    modelId: 0,
    timeoutMs: 120_000,
    topK: 5,
  };
}

/** 数据库节点默认：SQLite 起步、空 SQL */
export function newDatabaseNode(id: string): DatabaseNode {
  return {
    id,
    name: "",
    kind: "database",
    engine: "sqlite",
    sqlitePath: "",
    host: "",
    port: 5432,
    database: "",
    username: "",
    password: "",
    sql: "",
    params: [],
    maxRows: 1_000,
    batchSource: "",
    retries: 0,
  };
}

/** Excel 读取节点默认：空路径、第一个 sheet、maxRows 熔断 1000 */
export function newExcelReadNode(id: string): ExcelReadNode {
  return {
    id,
    name: "",
    kind: "excelRead",
    path: "",
    sheet: "",
    maxRows: 1000,
  };
}

/** Excel 写入节点默认：Sheet1、空行数据 */
export function newExcelWriteNode(id: string): ExcelWriteNode {
  return {
    id,
    name: "",
    kind: "excelWrite",
    path: "",
    sheet: "Sheet1",
    rowsSource: "",
  };
}

/** CSV 读取节点默认：逗号分隔、上限 1000 行（同 database 默认） */
export function newCsvReadNode(id: string): CsvReadNode {
  return {
    id,
    name: "",
    kind: "csvRead",
    path: "",
    delimiter: "comma",
    maxRows: 1000,
  };
}

/** CSV 写入节点默认：空行数据 */
export function newCsvWriteNode(id: string): CsvWriteNode {
  return { id, name: "", kind: "csvWrite", path: "", rowsSource: "" };
}

/** 变量节点默认：单变量空赋值 */
export function newVariableNode(id: string): VariableNode {
  return {
    id,
    name: "",
    kind: "variable",
    assignments: [{ name: "value", source: "", ops: [] }],
  };
}

/** 聚合统计节点默认：计数起步 */
export function newAggregateNode(id: string): AggregateNode {
  return {
    id,
    name: "",
    kind: "aggregate",
    source: "",
    ops: [{ type: "count" }],
  };
}

/** 邮件节点默认：465 SSL、空配置 */
export function newEmailNode(id: string): EmailNode {
  return {
    id,
    name: "",
    kind: "email",
    host: "",
    port: 465,
    secure: true,
    username: "",
    password: "",
    from: "",
    to: "",
    subject: "",
    body: "",
    retries: 0,
  };
}

/** 聚合节点默认：空模板 */
export function newMergeNode(id: string): MergeNode {
  return { id, name: "", kind: "merge", template: "" };
}

/** kind → 默认节点工厂注册表（switchNodeKind 类型切换 / 加节点 / 空图
 * 骨架共用；新 kind 必须补条目——Record<NodeKind,...> 编译期强制对账） */
export const FACTORY: Record<NodeKind, (id: string) => GraphNode> = {
  start: newStartNode,
  llm: newNode,
  code: newCodeNode,
  http: newHttpNode,
  fileRead: newFileReadNode,
  notify: newNotifyNode,
  subflow: newSubflowNode,
  iterate: newIterateNode,
  librarySearch: newLibrarySearchNode,
  jsonParse: newJsonParseNode,
  jsonStringify: newJsonStringifyNode,
  condition: newConditionNode,
  intent: newIntentNode,
  fileWrite: newFileWriteNode,
  docExtract: newDocExtractNode,
  imageGen: newImageGenNode,
  delay: newDelayNode,
  vectorize: newVectorizeNode,
  vectorSearch: newVectorSearchNode,
  database: newDatabaseNode,
  excelRead: newExcelReadNode,
  excelWrite: newExcelWriteNode,
  csvRead: newCsvReadNode,
  csvWrite: newCsvWriteNode,
  variable: newVariableNode,
  aggregate: newAggregateNode,
  email: newEmailNode,
  merge: newMergeNode,
};
