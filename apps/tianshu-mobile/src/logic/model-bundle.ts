/**
 * provider/query wire 判别（T15 ModelPicker 数据源）：ProviderBundleDto
 * `{providers, models}` 收敛为「按服务商分组的可对话模型」——仅 llm +
 * enabled（桌面 ModelPicker 同口径：embedding/tts 等专项端点模型不可
 * 对话），畸形行静默滤除（历史数据容错）。
 */

export interface ProviderBrief {
  id: number;
  name: string;
}

export interface ModelBrief {
  id: number;
  providerId: number;
  /** 展示名（可空——回落 modelId 标识） */
  name: string | null;
  /** API 模型标识（name 空时兜底展示） */
  modelId: string;
}

export interface ModelGroup {
  provider: ProviderBrief;
  models: ModelBrief[];
}

export interface ProviderBundle {
  providers: ProviderBrief[];
  models: ModelBrief[];
  /** 按服务商分组（空组滤除；展示序 = providers wire 序） */
  groups: ModelGroup[];
}

/** 展示标签：name 空（或空白）回落 modelId 标识 */
export function modelLabel(m: ModelBrief): string {
  return m.name && m.name.trim() !== "" ? m.name : m.modelId;
}

function toProviders(data: unknown): ProviderBrief[] {
  if (!Array.isArray(data)) return [];
  const out: ProviderBrief[] = [];
  for (const p of data) {
    if (typeof p !== "object" || p === null) continue;
    const row = p as { id?: unknown; name?: unknown };
    if (typeof row.id !== "number" || typeof row.name !== "string") continue;
    out.push({ id: row.id, name: row.name });
  }
  return out;
}

function toModels(data: unknown): ModelBrief[] {
  if (!Array.isArray(data)) return [];
  const out: ModelBrief[] = [];
  for (const m of data) {
    if (typeof m !== "object" || m === null) continue;
    const row = m as {
      id?: unknown;
      providerId?: unknown;
      modelId?: unknown;
      name?: unknown;
      type?: unknown;
      enabled?: unknown;
    };
    if (
      typeof row.id !== "number" ||
      typeof row.providerId !== "number" ||
      typeof row.modelId !== "string"
    ) {
      continue;
    }
    // 会话补全只认 llm + 启用（disabled !== false 容忍老数据缺字段）
    if (row.enabled === false) continue;
    if ((row.type ?? "llm") !== "llm") continue;
    out.push({
      id: row.id,
      providerId: row.providerId,
      name: typeof row.name === "string" ? row.name : null,
      modelId: row.modelId,
    });
  }
  return out;
}

/** wire 判别 + 分组（纯函数；畸形输入退空 bundle） */
export function parseProviderBundle(data: unknown): ProviderBundle {
  const d = (data ?? {}) as { providers?: unknown; models?: unknown };
  const providers = toProviders(d.providers);
  const models = toModels(d.models);
  const groups = providers
    .map((provider) => ({
      provider,
      models: models.filter((m) => m.providerId === provider.id),
    }))
    .filter((g) => g.models.length > 0);
  return { providers, models, groups };
}

/** 模型行 id → 展示名反查表（B5 消息元信息：getById wire modelId → 模型名；
 *  可对话模型口径与选择器一致——含孤儿行，name 空回落 modelId 标识） */
export function modelNameMap(data: unknown): Map<number, string> {
  return new Map(
    parseProviderBundle(data).models.map((m) => [m.id, modelLabel(m)]),
  );
}

/** 存在可对话模型（llm + enabled，与 ModelPicker 同口径；B5 无模型引导条
 *  显隐判据——bundle 未拉取/拉取失败时调用方不得据 false 展示引导） */
export function hasUsableModels(data: unknown): boolean {
  return parseProviderBundle(data).models.length > 0;
}
