/**
 * provider/save upsert 契约（A1 批自无头端 ProviderSaveDto 收编——单份权威
 * 源；class-validator 装饰器 DTO 类留 apps/tianshu-server 原位，此处仅类型
 * 层形状。三态语义：undefined=未传保留现值；null=显式清除；脱敏掩码
 * REDACTED_SECRET 由服务端按未传处理，防回写覆盖真实密钥）。
 */

/** 服务商配置项（save upsert 语义：带 id 更新，不带 id 新建） */
export interface ProviderSaveItem {
  /** 服务商标识；缺省新建 */
  id?: number;
  name: string;
  /** 服务商类型（openai-compatible/anthropic/gemini/ollama/comfyui） */
  type: string;
  baseUrl: string;
  /** API 密钥（未传保留现值；显式 null 清除；未配置为 null） */
  apiKey?: string | null;
  /** 额外请求头 JSON 字符串（形如 {"X-Key":"v"}；语义同 apiKey） */
  extraHeaders?: string | null;
  /** 是否启用；新建缺省 true */
  enabled?: boolean;
}

/** 模型配置项（save upsert 语义同上；经所属 provider 校验归属） */
export interface ModelSaveItem {
  /** 模型行标识（库内行标识）；缺省新建 */
  id?: number;
  /** 所属服务商（新建必填；更新时校验 {id,providerId} 对账） */
  providerId: number;
  /** 模型标识（上游模型名） */
  modelId: string;
  /** 展示名 */
  name?: string | null;
  /** 类型 llm|embedding|tts|reranker|asr；缺省 llm */
  type?: string;
  enabled?: boolean;
  temperature?: number | null;
  topP?: number | null;
  maxTokens?: number | null;
  contextWindow?: number | null;
}

/** provider/save 请求体：两数组均可选、至少一项为数组；非全量覆盖 */
export interface ProviderSavePayload {
  providers?: ProviderSaveItem[];
  models?: ModelSaveItem[];
}
