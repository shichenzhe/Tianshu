/**
 * 配置清单域远程适配器（HD-T3，spec §2.3）：远程 providerBundle /
 * assistantList 通道 → 本地 ModelRecord/ProviderRecord/AssistantRecord
 * 形状转换。UI 消费零变化。不映射字段（model contextWindow、行时间戳、
 * 专家 systemPrompt/builtin 等）缺省——远程编辑/详情面由 caps 门控或走
 * providerSave 通道，本地 UI 对缺省走既有分支。
 */
import type {
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

/** RemoteModel → ModelRecord（type 五值收窄防远程新类型炸枚举面；
 * null → 缺省；时间戳远端不透出缺省空串） */
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

/** 新建 model：同 provider 款 bundle diff 取新行 */
export async function remoteModelCreate(
  params: ModelCreateParams,
  connId: string,
): Promise<ModelRecord> {
  const before = await ServerApi.providerBundle(connId);
  const beforeIds = new Set(before.models.map((m) => m.id));
  const bundle = await ServerApi.providerSave({ models: [params] }, connId);
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
          params,
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
