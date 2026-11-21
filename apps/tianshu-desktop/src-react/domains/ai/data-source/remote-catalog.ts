/**
 * 配置清单域远程适配器（HD-T3，spec §2.3）：远程 providerBundle /
 * assistantList 通道 → 本地 ModelRecord/ProviderRecord/AssistantRecord
 * 形状转换。UI 消费零变化。不映射字段（model contextWindow、行时间戳、
 * 专家 systemPrompt/builtin 等）缺省——远程编辑/详情面由 caps 门控或走
 * providerSave 通道，本地 UI 对缺省走既有分支。
 */
import type {
  ModelCapabilities,
  ModelRecord,
  ModelType,
  TestConnectionResult,
  ListRemoteResult,
  ModelCreateParams,
  ModelUpdateParams,
} from "../api/model.api";
import { MODEL_TYPES } from "../api/model.api";
import type {
  ProviderRecord,
  ProviderType,
  ProviderCreateParams,
  ProviderUpdateParams,
} from "../api/provider.api";
import { PROVIDER_TYPES } from "../api/provider.api";
import type { AssistantRecord } from "../api/assistant.api";
import type { SkillRecord } from "../skills/api/skill.api";
import type { WorkspaceRecord } from "../api/workspace.api";
import ServerApi from "../server/api/server.api";
import type { RemoteModel, RemoteProvider } from "../server/api/server.api";
import type { RemoteWorkspaceBrief } from "@tianshu/protocol";
// orchestration 域适配器（路由化批 2026-11-10）——编排页数据面形状与
// 远端编排 API（server/api/graph.api.ts，GA-T8 + 本批三端点）
import type {
  GraphRecord,
  GraphRunPage,
  GraphRunNodeRow,
} from "../orchestration/api/orchestration.api";
import RemoteGraphApi, {
  type RemoteGraphRecord,
  type RemoteWebhookConfig,
  type RemoteWebhookManage,
  type RemoteTaskRecord,
  type RemoteTaskSaveParams,
  toTaskSaveParams,
} from "../server/api/graph.api";
// automation/library 域适配器（automation/library 路由化批 2026-11-10）
import type {
  RunPage,
  TaskCreateParams,
  TaskRecord,
} from "../automation/api/automation.api";
import type {
  AutomationRunDetail,
  RunGroupRecord,
  RunSessionResult,
} from "@tianshu/protocol";
import type { LibraryItem } from "../library/api/library.api";
import RemoteLibraryApi, {
  type RemoteLibraryItem,
} from "../server/api/library.api";
import { computeStats } from "@tianshu/core/automation-stats";
import type { AutomationStats } from "@tianshu/core/automation-stats";
import { invoke as invokeIpc } from "@/lib/ipc";

/** RemoteModel → ModelRecord（type 五值收窄防远程新类型炸枚举面；
 * null → 缺省；时间戳远端不透出缺省空串）。批5：能力矩阵 JSON 安全
 * 解析 + 单价/备选/contextWindow 透传（此前 contextWindow 亦漏映射） */
function parseRemoteCapabilities(
  raw: string | null | undefined,
): ModelCapabilities | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as ModelCapabilities)
      : undefined;
  } catch {
    return undefined;
  }
}

function toModelRecord(row: RemoteModel): ModelRecord {
  const type: ModelType = MODEL_TYPES.includes(row.type as ModelType)
    ? (row.type as ModelType)
    : "llm";
  return {
    id: row.id,
    providerId: row.providerId,
    modelId: row.modelId,
    ...(row.name != null ? { name: row.name } : {}),
    enabled: row.enabled,
    type,
    ...(row.temperature != null ? { temperature: row.temperature } : {}),
    ...(row.topP != null ? { topP: row.topP } : {}),
    ...(row.maxTokens != null ? { maxTokens: row.maxTokens } : {}),
    ...(row.contextWindow != null ? { contextWindow: row.contextWindow } : {}),
    capabilities: parseRemoteCapabilities(row.capabilities),
    ...(row.priceInPerMTokens != null
      ? { priceInPerMTokens: row.priceInPerMTokens }
      : {}),
    ...(row.priceOutPerMTokens != null
      ? { priceOutPerMTokens: row.priceOutPerMTokens }
      : {}),
    ...(row.fallbackModelId != null
      ? { fallbackModelId: row.fallbackModelId }
      : {}),
    createdAt: "",
    updatedAt: "",
  };
}

/** RemoteProvider → ProviderRecord（type 四值收窄；apiKey 脱敏掩码
 * 原样直传——只读展示语义，编辑保存由 providerSave 掩码回传约定承载） */
function toProviderRecord(row: RemoteProvider): ProviderRecord {
  const type: ProviderType = (PROVIDER_TYPES as readonly string[]).includes(
    row.type,
  )
    ? (row.type as ProviderType)
    : "openai-compatible";
  return {
    id: row.id,
    name: row.name,
    type,
    baseUrl: row.baseUrl,
    ...(row.apiKey != null ? { apiKey: row.apiKey } : {}),
    ...(row.extraHeaders != null ? { extraHeaders: row.extraHeaders } : {}),
    enabled: row.enabled,
    createdAt: "",
    updatedAt: "",
  };
}

/** RemoteWorkspaceBrief → WorkspaceRecord（HD-A2：侧栏远端树分组数据；
 * null → undefined 走 UI 既有缺省分支；时间戳远端不透出缺省空串） */
function toWorkspaceRecord(brief: RemoteWorkspaceBrief): WorkspaceRecord {
  return {
    id: brief.id,
    name: brief.name,
    ...(brief.directoryPath != null
      ? { directoryPath: brief.directoryPath }
      : {}),
    ...(brief.defaultModelId != null
      ? { defaultModelId: brief.defaultModelId }
      : {}),
    createdAt: "",
    updatedAt: "",
  };
}

/** 远端工作空间列表（单 UI 远程态侧栏分组树） */
export async function remoteWorkspaceList(
  connId: string,
): Promise<WorkspaceRecord[]> {
  const briefs = await ServerApi.workspaceList(connId);
  return briefs.map(toWorkspaceRecord);
}

/** 远端工作空间写面（2026-11-09 批）：Brief → Record 同款转换
 *  （时间戳远端不透出缺省空串——消费面不依赖） */
export async function remoteWorkspaceCreate(
  params: { name: string; icon?: string; defaultModelId?: number },
  connId: string,
): Promise<WorkspaceRecord> {
  return toWorkspaceRecord(await ServerApi.workspaceCreate(params, connId));
}

export async function remoteWorkspaceUpdate(
  params: {
    id: number;
    name?: string;
    icon?: string;
    defaultModelId?: number;
  },
  connId: string,
): Promise<WorkspaceRecord> {
  return toWorkspaceRecord(await ServerApi.workspaceUpdate(params, connId));
}

export async function remoteWorkspaceDelete(
  id: number,
  connId: string,
): Promise<void> {
  await ServerApi.workspaceDelete(id, connId);
}

export async function remoteModelList(connId: string): Promise<ModelRecord[]> {
  const bundle = await ServerApi.providerBundle(connId);
  return bundle.models.map(toModelRecord);
}

/** 远程技能概要行（skillsQuery 返回；protocol RemoteSkillBrief 同构） */
interface RemoteSkillBrief {
  name: string;
  description?: string | null;
  enabled?: boolean;
}

/** 远程技能行 → SkillRecord（id 恒 0——远端无库内行 id，消费面按 name
 * 索引，管理页（唯一 id 消费点）远程态已整页门控；enabled 缺省 true
 * ——远端未上报视作启用，联想面不丢技能） */
function toSkillRecord(brief: RemoteSkillBrief): SkillRecord {
  return {
    id: 0,
    name: brief.name,
    slug: null,
    version: null,
    source: "",
    dir: "",
    description: brief.description ?? null,
    enabled: brief.enabled ?? true,
    installedAt: "",
    scenarios: null,
  };
}

/** 远程技能清单（联想候选/启停子菜单/专家表单消费面） */
export async function remoteSkillList(connId: string): Promise<SkillRecord[]> {
  const briefs = await ServerApi.skillsQuery(connId);
  return briefs.map(toSkillRecord);
}

export async function remoteProviderList(
  connId: string,
): Promise<ProviderRecord[]> {
  const bundle = await ServerApi.providerBundle(connId);
  return bundle.providers.map(toProviderRecord);
}

/** 模型连通测试：远程无按模型行端点——bundle 查归属 provider 走
 * providerTest（轻探上游 /models），{ok,message} → TestConnectionResult */
export async function remoteModelTest(
  id: number,
  connId: string,
): Promise<TestConnectionResult> {
  const bundle = await ServerApi.providerBundle(connId);
  const row = bundle.models.find((m) => m.id === id);
  if (!row) {
    throw new Error("远程主机不存在该模型（列表已过期，请刷新后重试）");
  }
  const result = await ServerApi.providerTest(row.providerId, connId);
  return { success: result.ok, message: result.message };
}

/** 远程专家概要行 → AssistantRecord（发送选专家消费面：name/icon/
 * description/quickPrompts；systemPrompt 远端不透出缺省空串） */
export async function remoteAssistantList(
  connId: string,
): Promise<AssistantRecord[]> {
  const rows = await ServerApi.assistantList(connId);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    systemPrompt: "",
    ...(row.icon != null ? { icon: row.icon } : {}),
    ...(row.description != null ? { description: row.description } : {}),
    ...(row.quickPrompts != null ? { quickPrompts: row.quickPrompts } : {}),
    builtin: false,
    createdAt: "",
    updatedAt: "",
  }));
}

// —— provider/model 写面（HD-P3a：单 UI 模型页远程可编辑，upsert 语义） ——

/** 差量合并：undefined 键不覆盖基线（显式 null 清空保留） */
function mergeDefined<T extends object>(base: T, patch: Partial<T>): T {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      out[key as keyof T] = value as T[keyof T];
    }
  }
  return out;
}

/** 新建 provider：upsert（不带 id）后自 save 返回 bundle 与保存前 diff
 * 取新行（save 端点不指明新建行；create 非高频，多一次 bundle 拉取可容） */
export async function remoteProviderCreate(
  params: ProviderCreateParams,
  connId: string,
): Promise<ProviderRecord> {
  const before = await ServerApi.providerBundle(connId);
  const beforeIds = new Set(before.providers.map((p) => p.id));
  const bundle = await ServerApi.providerSave({ providers: [params] }, connId);
  const row =
    bundle.providers.find((p) => !beforeIds.has(p.id)) ??
    bundle.providers.at(-1)!;
  return toProviderRecord(row);
}

/** 更新 provider：带 id upsert。无头端 save DTO 必填 type/baseUrl（差量
 * 项拒 5000——ProviderPanel 全量表单同语义），先拉 bundle 现值补全差量
 * 为全量；undefined 键不覆盖，null 清空如实透传；apiKey 基线不含掩码
 * （未填新 key 时无该键 = 远端不改） */
export async function remoteProviderUpdate(
  params: ProviderUpdateParams,
  connId: string,
): Promise<ProviderRecord> {
  const bundle = await ServerApi.providerBundle(connId);
  const row = bundle.providers.find((p) => p.id === params.id);
  if (!row) {
    throw new Error("远程主机不存在该服务商（列表已过期，请刷新后重试）");
  }
  const saved = await ServerApi.providerSave(
    {
      providers: [
        mergeDefined(
          {
            name: row.name,
            type: row.type,
            baseUrl: row.baseUrl,
            enabled: row.enabled,
          },
          params,
        ),
      ],
    },
    connId,
  );
  return toProviderRecord(saved.providers.find((p) => p.id === params.id)!);
}

export async function remoteProviderDelete(
  id: number,
  connId: string,
): Promise<void> {
  await ServerApi.providerDelete({ providerIds: [id] }, connId);
}

/** 新建 model：同 provider 款 bundle diff 取新行。capabilities 在本地 API
 *  形为对象（批5），server save DTO 为 JSON 字符串——发送前序列化 */
type ModelSaveWire = Omit<ModelUpdateParams, "capabilities"> & {
  capabilities?: string | null;
};

function toModelSaveWire(
  params: ModelCreateParams | ModelUpdateParams,
): ModelSaveWire {
  // 联合形态先归一到 Update 形（结构子集，仅剥 capabilities 后展开）
  const { capabilities, ...rest } = params as ModelUpdateParams;
  return {
    ...rest,
    ...(capabilities !== undefined
      ? {
          capabilities:
            capabilities === null ? null : JSON.stringify(capabilities),
        }
      : {}),
  };
}

export async function remoteModelCreate(
  params: ModelCreateParams,
  connId: string,
): Promise<ModelRecord> {
  const before = await ServerApi.providerBundle(connId);
  const beforeIds = new Set(before.models.map((m) => m.id));
  const bundle = await ServerApi.providerSave(
    { models: [toModelSaveWire(params)] },
    connId,
  );
  const row =
    bundle.models.find((m) => !beforeIds.has(m.id)) ?? bundle.models.at(-1)!;
  return toModelRecord(row);
}

export async function remoteModelUpdate(
  params: ModelUpdateParams,
  connId: string,
): Promise<ModelRecord> {
  // 同 provider 款：DTO 必填项经 bundle 现值补全（差量 → 全量）
  const bundle = await ServerApi.providerBundle(connId);
  const row = bundle.models.find((m) => m.id === params.id);
  if (!row) {
    throw new Error("远程主机不存在该模型（列表已过期，请刷新后重试）");
  }
  const saved = await ServerApi.providerSave(
    {
      models: [
        mergeDefined(
          {
            providerId: row.providerId,
            modelId: row.modelId,
            type: row.type,
            enabled: row.enabled,
          },
          toModelSaveWire(params),
        ),
      ],
    },
    connId,
  );
  return toModelRecord(saved.models.find((m) => m.id === params.id)!);
}

export async function remoteModelDelete(
  id: number,
  connId: string,
): Promise<void> {
  await ServerApi.providerDelete({ modelIds: [id] }, connId);
}

/** 拉取上游模型清单：providerFetchModels 形状转换（name → ownedBy） */
export async function remoteModelListRemote(
  providerId: number,
  connId: string,
): Promise<ListRemoteResult> {
  const result = await ServerApi.providerFetchModels(providerId, connId);
  return {
    success: result.success,
    ...(result.errorCode != null ? { errorCode: result.errorCode } : {}),
    message: result.message,
    models: result.models.map((m) => ({
      modelId: m.modelId,
      ...(m.name != null ? { ownedBy: m.name } : {}),
    })),
  };
}
// ============ orchestration 域适配器（orchestration 路由化批 2026-11-10） ============
// 编排页 GraphApi 的远程数据面：graph/automation 端点（GA-T8 九端点 +
// 本批 toggle/runs/runNodes）→ 编排页 GraphRecord/GraphRunPage 形状。
// 深水功能（导入导出/AI 润色/单节点测试）依赖本地文件系统或本地
// executor，远程态由 api 层显式拒绝（orchestration.api.ts 门控），
// 不在此补适配。

/** RemoteGraphRecord → GraphRecord（老无头端 updatedAt/nodeCount 缺席
 * 兜底：nodeCount 客户端从 graphJson 派生、updatedAt 回落 createdAt） */
function toGraphRecord(row: RemoteGraphRecord): GraphRecord {
  let nodeCount = row.nodeCount ?? 0;
  if (nodeCount === 0 && row.graphJson) {
    try {
      const nodes = (JSON.parse(row.graphJson) as { nodes?: unknown }).nodes;
      if (Array.isArray(nodes)) {
        nodeCount = nodes.length;
      }
    } catch {
      // 坏 JSON 兜底 0（server 侧同款容错）
    }
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    graphJson: row.graphJson,
    version: row.version,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? row.createdAt,
    nodeCount,
  };
}

const ORCH_LIST_PAGE_SIZE = 200;

/** 图列表全量拉取（编排页 list 无分页语义——大页续页到取完） */
export async function remoteGraphList(connId: string): Promise<GraphRecord[]> {
  const records: RemoteGraphRecord[] = [];
  let page = 1;
  for (;;) {
    const result = await RemoteGraphApi.graphList(
      { page, pageSize: ORCH_LIST_PAGE_SIZE },
      connId,
    );
    records.push(...result.records);
    if (records.length >= result.total || result.records.length === 0) {
      break;
    }
    page += 1;
  }
  return records.map(toGraphRecord);
}

export async function remoteGraphSave(
  params: {
    id?: number;
    name: string;
    description?: string;
    graphJson: string;
    version?: number;
  },
  connId: string,
): Promise<GraphRecord> {
  return toGraphRecord(await RemoteGraphApi.graphSave(params, connId));
}

export async function remoteGraphDelete(
  id: number,
  connId: string,
): Promise<void> {
  await RemoteGraphApi.graphDelete(id, connId);
}

export async function remoteGraphToggle(
  id: number,
  enabled: boolean,
  connId: string,
): Promise<GraphRecord> {
  return toGraphRecord(await RemoteGraphApi.graphToggle(id, enabled, connId));
}

/** 图运行历史（wire 剔 graphTrace 精简面——桌面 RunRecord.graphTrace
 * 可选，节点级详情走 runNodes 主路径，老 run trace 预览远程态缺省） */
export async function remoteGraphRuns(
  graphId: number,
  page: number,
  connId: string,
  topLevelOnly?: boolean,
): Promise<GraphRunPage> {
  const result = topLevelOnly
    ? await RemoteGraphApi.graphRuns(graphId, page, connId, undefined, true)
    : await RemoteGraphApi.graphRuns(graphId, page, connId);
  return {
    total: result.total,
    items: result.items as GraphRunPage["items"],
  };
}

export async function remoteGraphRunNodes(
  runId: number,
  connId: string,
): Promise<GraphRunNodeRow[]> {
  return (await RemoteGraphApi.graphRunNodes(
    runId,
    connId,
  )) as GraphRunNodeRow[];
}

/** 试运行：远端只跑库内版本——draftJson 与库内不一致时先保存再跑
 * （远程态「试跑=保存后跑」，与本地「试跑草稿不落库」的语义差异在
 * 此收敛；workspaceId 为远端空间 id——GraphTestRunDialog 的空间选择
 * 已走路由化 workspace api，天然取到远端 id） */
export async function remoteGraphRunTest(
  id: number,
  inputs: Record<string, unknown>,
  workspaceId: number,
  draftJson: string | undefined,
  connId: string,
): Promise<void> {
  const page = await RemoteGraphApi.graphList(
    { page: 1, pageSize: ORCH_LIST_PAGE_SIZE },
    connId,
  );
  const row = page.records.find((r) => r.id === id);
  if (!row) {
    throw new Error("GRAPH_NOT_FOUND");
  }
  if (draftJson != null && draftJson !== row.graphJson) {
    await RemoteGraphApi.graphSave(
      {
        id,
        version: row.version,
        name: row.name,
        description: row.description,
        graphJson: draftJson,
      },
      connId,
    );
  }
  await RemoteGraphApi.graphRun(
    id,
    connId,
    inputs as Record<string, string>,
    workspaceId,
  );
}

/** 中止试运行：远端 runAbort 按 runId——查该图最新 running run 归位
 * （graphTestInflight 互斥保证单图至多一个在途 run；查不到对齐本地
 * GRAPH_NOT_RUNNING 语义） */
export async function remoteGraphCancelTestRun(
  graphId: number,
  connId: string,
): Promise<void> {
  const runs = await RemoteGraphApi.graphRuns(graphId, 1, connId, "running");
  const runId = (runs.items as Array<{ id: number }>)[0]?.id;
  if (runId == null) {
    throw new Error("GRAPH_NOT_RUNNING");
  }
  await RemoteGraphApi.graphRunAbort(runId, connId);
}

/** webhook 三件：远端 url 为相对路径（/webhook/<token>），direct 连接
 * 拼 baseUrl 成绝对地址（GraphPanel 同口径）；relay 无 baseUrl 时保留
 * 相对路径（webhook 本为 HTTP 入站面，relay 场景天然受限） */
async function absolutizeWebhookUrl(
  manage: RemoteWebhookManage,
  connId: string,
): Promise<RemoteWebhookManage> {
  if (!manage.url || manage.url.startsWith("http")) {
    return manage;
  }
  const list = await ServerApi.listConnections();
  const conn = list.connections.find((c) => c.id === connId);
  if (conn?.baseUrl) {
    return {
      ...manage,
      url: `${conn.baseUrl.replace(/\/+$/, "")}${manage.url}`,
    };
  }
  return manage;
}

export async function remoteGraphWebhook(
  action: "enable" | "disable" | "status",
  graphId: number,
  connId: string,
  config?: RemoteWebhookConfig,
): Promise<RemoteWebhookManage> {
  const manage =
    action === "enable"
      ? await RemoteGraphApi.webhookEnable(graphId, connId, config)
      : action === "disable"
        ? await RemoteGraphApi.webhookDisable(graphId, connId)
        : await RemoteGraphApi.webhookStatus(graphId, connId);
  return absolutizeWebhookUrl(manage, connId);
}

// —— automation 域适配器（automation/library 路由化批 2026-11-10）——
// 任务页数据面：RemoteTaskRecord 与 TaskRecord 字段同构（scheduleJson
// 两侧均为 JSON 序列字符串，组件层 JSON.parse 还原），直转补 storagePath
// 类兜底即可；toggle 无专端点——查行读改写走 save 全量（Ruling 12，与
// GraphPanel 启停先例同款）。

/** RemoteTaskRecord → TaskRecord（同构直转；catchUpLimit server toDto
 * 兜 1 不可缺） */
function toTaskRecord(row: RemoteTaskRecord): TaskRecord {
  return {
    ...row,
    catchUpLimit: row.catchUpLimit ?? 1,
  };
}

const AUTOMATION_LIST_PAGE_SIZE = 200;

/** 任务列表全量拉取（任务页 list 无分页语义——大页续页到取完） */
export async function remoteAutomationList(
  connId: string,
): Promise<TaskRecord[]> {
  const records: RemoteTaskRecord[] = [];
  let page = 1;
  for (;;) {
    const result = await RemoteGraphApi.automationList(
      { page, pageSize: AUTOMATION_LIST_PAGE_SIZE },
      connId,
    );
    records.push(...result.records);
    if (records.length >= result.total || result.records.length === 0) {
      break;
    }
    page += 1;
  }
  return records.map(toTaskRecord);
}

/** TaskCreateParams → save 全量载荷（schedule 已是对象直传；编辑保存
 * 不携 enabled——server Ruling 14 缺省不动，与桌面 update 不碰启停一致；
 * create 携 enabled: true 对齐桌面建任务缺省启用） */
function toAutomationSaveWire(
  params: TaskCreateParams,
  id?: number,
): RemoteTaskSaveParams {
  return {
    ...(id !== undefined ? { id } : {}),
    name: params.name,
    prompt: params.prompt,
    workspaceId: params.workspaceId,
    modelId: params.modelId,
    temperature: params.temperature,
    targetKind: params.targetKind,
    graphId: params.graphId,
    eventJson: params.eventJson,
    schedule: params.schedule as unknown as Record<string, unknown>,
    scheduleText: params.scheduleText,
    startAt: params.startAt,
    endAt: params.endAt,
    missedPolicy: params.missedPolicy,
    catchUpLimit: params.catchUpLimit,
    accessMode: params.accessMode,
    templateSlug: params.templateSlug,
    projectId: params.projectId,
    enabled: true,
  };
}

export async function remoteAutomationSave(
  params: TaskCreateParams,
  id: number | undefined,
  connId: string,
): Promise<TaskRecord> {
  const row = await RemoteGraphApi.automationSave(
    toAutomationSaveWire(params, id),
    connId,
  );
  return toTaskRecord(row);
}

/** 启停：无 toggle 端点——查行后 save 全量携翻转 enabled（Ruling 12） */
export async function remoteAutomationToggle(
  id: number,
  enabled: boolean,
  connId: string,
): Promise<TaskRecord> {
  const tasks = await remoteAutomationList(connId);
  const row = tasks.find((t) => t.id === id);
  if (!row) {
    throw new Error("AUTOMATION_NOT_FOUND");
  }
  const saved = await RemoteGraphApi.automationSave(
    toTaskSaveParams(row, enabled),
    connId,
  );
  return toTaskRecord(saved);
}

export async function remoteAutomationDelete(
  ids: number[],
  connId: string,
): Promise<void> {
  await RemoteGraphApi.automationDelete(ids, connId);
}

/** 手动触发一次（202 受理，结果经 automation.changed 事件刷新） */
export async function remoteAutomationRunNow(
  id: number,
  connId: string,
): Promise<void> {
  await RemoteGraphApi.automationRunNow(id, connId);
}

/** 任务口径运行历史（wire = AutomationRunRecord 剔 graphTrace 精简面，
 * 与 RunRecord 同构直断——同 remoteGraphRuns 先例） */
export async function remoteAutomationRuns(
  page: number,
  taskId: number | undefined,
  status: "running" | "success" | "failed" | "skipped" | undefined,
  connId: string,
): Promise<RunPage> {
  const result = await RemoteGraphApi.automationRuns(
    page,
    connId,
    taskId,
    status,
  );
  return {
    total: result.total,
    items: result.items as RunPage["items"],
  };
}

export async function remoteAutomationRunGroups(
  connId: string,
): Promise<RunGroupRecord[]> {
  return RemoteGraphApi.automationRunGroups(connId);
}

export async function remoteAutomationRunById(
  runId: number,
  connId: string,
): Promise<AutomationRunDetail> {
  return RemoteGraphApi.automationRunById(runId, connId);
}

export async function remoteAutomationEnsureRunSession(
  runId: number,
  workspaceId: number | undefined,
  connId: string,
): Promise<RunSessionResult> {
  return RemoteGraphApi.automationEnsureRunSession(runId, workspaceId, connId);
}

/** 健康度总览（挂账收口 2026-11-10）：拉原始行集（7 天窗口，server 不
 * 做时区假设）→ computeStats 客户端聚合（core 单源，时区口径与桌面
 * 主进程 IPC 完全一致）；rollups 缺省空——server 无 automationStat
 * dailyRollup，趋势由存留 run 行聚合（无保留策略裁剪，口径完整） */
export async function remoteAutomationStats(
  connId: string,
): Promise<AutomationStats> {
  const TREND_DAYS = 7;
  const since = new Date(Date.now() - TREND_DAYS * 24 * 60 * 60 * 1000);
  const raw = await RemoteGraphApi.automationStatsRaw(
    since.toISOString(),
    connId,
  );
  return computeStats(
    raw.runs.map((row) => ({
      id: row.id,
      status: row.status as "running" | "success" | "failed" | "skipped",
      error: row.error,
      startedAt: new Date(row.startedAt),
      name: row.taskName,
      ...(row.graphId !== undefined && row.graphId !== null
        ? { graphId: row.graphId }
        : {}),
    })),
    raw.errorTasks.map((task) => ({
      id: task.id,
      name: task.name,
      statusNote: task.statusNote ?? "",
    })),
    new Date(),
  );
}

/** 跨端上传（挂账收口 2026-11-10）：主进程组合通道（授权门 + 3MB +
 * uploadFile 逐个）——「文件在控制端、库在远端」；AddFilesResult 形状
 * 对齐本地链（added 行 wire 形状转制，failed 逐文件 reason；组合通道
 * 出装配结果非信封——失败语义已内化为 failed 行） */
export async function remoteLibraryAddFiles(
  paths: string[],
  folderId: number | undefined,
  connId: string,
): Promise<{
  added: LibraryItem[];
  failed: Array<{ path: string; reason: string }>;
}> {
  const result = await invokeIpc<{
    added: RemoteLibraryItem[];
    failed: Array<{ path: string; reason: string }>;
  }>("server:libraryAddFiles", { paths, parentId: folderId ?? null }, connId);
  return {
    added: (result.added ?? []).map(toLibraryItem),
    failed: result.failed ?? [],
  };
}

/** 跨端目录导入（挂账收口 2026-11-11）：主进程组合通道同构本地
 * importFolder（目录名建根 → 递归建层 + 逐文件上传，隐藏文件跳过） */
export async function remoteLibraryImportFolder(
  dirPath: string,
  parentId: number | undefined,
  connId: string,
): Promise<{
  added: LibraryItem[];
  failed: Array<{ path: string; reason: string }>;
}> {
  const result = await invokeIpc<{
    added: RemoteLibraryItem[];
    failed: Array<{ path: string; reason: string }>;
  }>(
    "server:libraryImportFolder",
    { dirPath, parentId: parentId ?? null },
    connId,
  );
  return {
    added: (result.added ?? []).map(toLibraryItem),
    failed: result.failed ?? [],
  };
}

// —— library 域适配器（automation/library 路由化批 2026-11-10）——
// 结构 CRUD 与内容读写全直传；wire 刻意剔除 storagePath/originalPath
// （spec §1.4：不作远程读取凭证）——适配层兜 null，预览/附件读内容改走
// read/readImage 按 id 取（remoteLibraryText/remoteLibraryImageDataUrl）。

function toLibraryItem(row: RemoteLibraryItem): LibraryItem {
  return {
    ...row,
    storagePath: null,
    originalPath: null,
  };
}

export async function remoteLibraryList(
  parentId: number | undefined,
  connId: string,
): Promise<{ items: LibraryItem[]; breadcrumbs: LibraryItem[] }> {
  const result = await RemoteLibraryApi.list(parentId ?? null, connId);
  return {
    items: result.items.map(toLibraryItem),
    breadcrumbs: result.breadcrumbs.map(toLibraryItem),
  };
}

export async function remoteLibraryTree(
  connId: string,
): Promise<LibraryItem[]> {
  return (await RemoteLibraryApi.tree(connId)).map(toLibraryItem);
}

export async function remoteLibrarySearch(
  keyword: string,
  connId: string,
): Promise<LibraryItem[]> {
  return (await RemoteLibraryApi.search(keyword, connId)).map(toLibraryItem);
}

export async function remoteLibraryListRecent(
  connId: string,
): Promise<LibraryItem[]> {
  return (await RemoteLibraryApi.listRecent(connId)).map(toLibraryItem);
}

export async function remoteLibraryListFavorites(
  connId: string,
): Promise<LibraryItem[]> {
  return (await RemoteLibraryApi.listFavorites(connId)).map(toLibraryItem);
}

export async function remoteLibraryCreateFolder(
  name: string,
  parentId: number | undefined,
  connId: string,
): Promise<LibraryItem> {
  return toLibraryItem(
    await RemoteLibraryApi.createFolder(name, parentId ?? null, connId),
  );
}

export async function remoteLibraryCreateFile(
  name: string,
  folderId: number | undefined,
  connId: string,
): Promise<LibraryItem> {
  return toLibraryItem(
    await RemoteLibraryApi.createFile(name, folderId ?? null, connId),
  );
}

export async function remoteLibraryAddLink(
  url: string,
  title: string | null,
  folderId: number | undefined,
  connId: string,
): Promise<LibraryItem> {
  return toLibraryItem(
    await RemoteLibraryApi.addLink(url, title, folderId ?? null, connId),
  );
}

export async function remoteLibraryRename(
  id: number,
  name: string,
  connId: string,
): Promise<LibraryItem> {
  return toLibraryItem(await RemoteLibraryApi.rename(id, name, connId));
}

export async function remoteLibraryMove(
  ids: number[],
  targetParentId: number | undefined,
  connId: string,
): Promise<null> {
  return RemoteLibraryApi.move(ids, targetParentId ?? null, connId);
}

export async function remoteLibraryDelete(
  ids: number[],
  connId: string,
): Promise<null> {
  return RemoteLibraryApi.delete(ids, connId);
}

export async function remoteLibrarySubtreeCount(
  id: number,
  connId: string,
): Promise<number> {
  return RemoteLibraryApi.subtreeCount(id, connId);
}

export async function remoteLibraryToggleFavorite(
  id: number,
  connId: string,
): Promise<LibraryItem> {
  return toLibraryItem(await RemoteLibraryApi.toggleFavorite(id, connId));
}

export async function remoteLibraryMarkViewed(
  id: number,
  connId: string,
): Promise<LibraryItem> {
  return toLibraryItem(await RemoteLibraryApi.markViewed(id, connId));
}

export async function remoteLibraryWriteContent(
  id: number,
  content: string,
  connId: string,
): Promise<LibraryItem> {
  return toLibraryItem(
    await RemoteLibraryApi.writeContent(id, content, connId),
  );
}

/** 远端文本内容读（512KiB/NUL 守卫在服务端——预览与附件预检/发送共用） */
export async function remoteLibraryText(
  id: number,
  connId: string,
): Promise<string> {
  const result = await RemoteLibraryApi.read(id, connId);
  return result.content;
}

/** 远端图片读 → dataUrl（mime 白名单 + base64 在服务端；dev/生产同链
 * ——远程态无本地路径，生产也不能 file:// 直链） */
export async function remoteLibraryImage(
  id: number,
  connId: string,
): Promise<string> {
  const result = await RemoteLibraryApi.readImage(id, connId);
  return `data:${result.mime};base64,${result.dataBase64}`;
}

/** webview 类预览直连流式 URL（webview 批 2026-11-11）：direct 连接拼
 *  baseUrl + query token（StaticTokenGuard 双形态鉴权，webview src 导航
 *  带不了 Bearer）；relay 连接无直连 HTTP 面——返回 null 由调用方维持
 *  不支持占位（token 为实例级静态密钥，桌面本地已持有，URL 不出本机
 *  webview partition） */
export async function remoteLibraryStreamUrl(
  id: number,
  connId: string,
): Promise<string | null> {
  const list = await ServerApi.listConnections();
  const conn = list.connections.find((c) => c.id === connId);
  if (!conn?.baseUrl || !conn.token) {
    return null;
  }
  const base = conn.baseUrl.replace(/\/+$/, "");
  return `${base}/library/stream?id=${id}&token=${encodeURIComponent(conn.token)}`;
}
