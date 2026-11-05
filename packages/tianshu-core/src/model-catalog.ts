/**
 * 内置模型目录（provider-model §6 项 1b/5，Task 9 批 5）：常见模型 id →
 * contextWindow/价格（USD 每 1M token）/能力（vision/tools）静态表——本地
 * 数据零外部依赖、零网络请求。定位是「DB 显式值的回填层」而非真相源：
 * model 表显式 contextWindow / priceIn·OutPerMTokens 恒优先，目录只在
 * DB 为空时兜底（effectiveContextWindow 四层链 model > 目录 > provider >
 * DEFAULT_CONTEXT_WINDOW）。价格与窗口为收录时点近似值（各厂商页为准），
 * 用户可在模型表单显式覆盖。
 *
 * 别名容错（lookupModelCatalog 归一序）：小写/去空白 → ollama 冒号 tag
 * （qwen3:8b → qwen3，含 :latest）→ provider 路径前缀（openai/gpt-4o →
 * gpt-4o）→ OpenAI 日期后缀（gpt-4o-2024-07-18 → gpt-4o）→ 显式别名表
 * （claude-3-5-sonnet → claude-3-5-sonnet-latest 等市场惯用短名）。
 */
import { DEFAULT_CONTEXT_WINDOW } from "./param-merge";

export interface ModelCatalogEntry {
  /** 上下文窗口（token） */
  contextWindow?: number;
  /** 输入单价（USD / 1M token）；本地模型缺省（≠ 0） */
  priceInPerMTokens?: number;
  /** 输出单价（USD / 1M token） */
  priceOutPerMTokens?: number;
  /** 视觉输入（多模态图片） */
  vision?: boolean;
  /** function-calling / 工具调用 */
  tools?: boolean;
}

/** 目录主体：厂商 API 原生 id 为键（小写） */
const CATALOG: Record<string, ModelCatalogEntry> = {
  // —— DeepSeek ——
  "deepseek-chat": {
    contextWindow: 128_000,
    priceInPerMTokens: 0.27,
    priceOutPerMTokens: 1.1,
    tools: true,
  },
  "deepseek-reasoner": {
    contextWindow: 128_000,
    priceInPerMTokens: 0.55,
    priceOutPerMTokens: 2.19,
    tools: true,
  },
  // —— Kimi（月之暗面）——
  "kimi-k2-instruct": {
    contextWindow: 131_072,
    priceInPerMTokens: 0.6,
    priceOutPerMTokens: 2.5,
    tools: true,
  },
  "kimi-k2-0711-preview": {
    contextWindow: 131_072,
    priceInPerMTokens: 0.6,
    priceOutPerMTokens: 2.5,
    tools: true,
  },
  "moonshot-v1-8k": {
    contextWindow: 8_192,
    priceInPerMTokens: 1.7,
    priceOutPerMTokens: 1.7,
    tools: true,
  },
  "moonshot-v1-32k": {
    contextWindow: 32_768,
    priceInPerMTokens: 3.4,
    priceOutPerMTokens: 3.4,
    tools: true,
  },
  "moonshot-v1-128k": {
    contextWindow: 131_072,
    priceInPerMTokens: 8.5,
    priceOutPerMTokens: 8.5,
    tools: true,
  },
  // —— 通义千问（Qwen 商用线）——
  "qwen-max": {
    contextWindow: 32_768,
    priceInPerMTokens: 0.24,
    priceOutPerMTokens: 0.92,
    tools: true,
  },
  "qwen-plus": {
    contextWindow: 131_072,
    priceInPerMTokens: 0.08,
    priceOutPerMTokens: 0.28,
    tools: true,
  },
  "qwen-turbo": {
    contextWindow: 131_072,
    priceInPerMTokens: 0.05,
    priceOutPerMTokens: 0.2,
    tools: true,
  },
  "qwen-vl-max": {
    contextWindow: 32_768,
    priceInPerMTokens: 0.28,
    priceOutPerMTokens: 0.85,
    vision: true,
    tools: true,
  },
  // —— 智谱 GLM ——
  "glm-4.5": {
    contextWindow: 131_072,
    priceInPerMTokens: 0.6,
    priceOutPerMTokens: 2.2,
    tools: true,
  },
  "glm-4.5-air": {
    contextWindow: 131_072,
    priceInPerMTokens: 0.1,
    priceOutPerMTokens: 0.4,
    tools: true,
  },
  "glm-4-plus": {
    contextWindow: 131_072,
    priceInPerMTokens: 0.7,
    priceOutPerMTokens: 0.7,
    tools: true,
  },
  "glm-4-flash": {
    contextWindow: 131_072,
    priceInPerMTokens: 0,
    priceOutPerMTokens: 0,
    tools: true,
  },
  "glm-4v-plus": {
    contextWindow: 8_192,
    priceInPerMTokens: 0.14,
    priceOutPerMTokens: 0.14,
    vision: true,
  },
  // —— OpenAI ——
  "gpt-4o": {
    contextWindow: 128_000,
    priceInPerMTokens: 2.5,
    priceOutPerMTokens: 10,
    vision: true,
    tools: true,
  },
  "gpt-4o-mini": {
    contextWindow: 128_000,
    priceInPerMTokens: 0.15,
    priceOutPerMTokens: 0.6,
    vision: true,
    tools: true,
  },
  "gpt-4.1": {
    contextWindow: 1_048_576,
    priceInPerMTokens: 2,
    priceOutPerMTokens: 8,
    vision: true,
    tools: true,
  },
  "gpt-4.1-mini": {
    contextWindow: 1_048_576,
    priceInPerMTokens: 0.4,
    priceOutPerMTokens: 1.6,
    vision: true,
    tools: true,
  },
  "gpt-4.1-nano": {
    contextWindow: 1_048_576,
    priceInPerMTokens: 0.1,
    priceOutPerMTokens: 0.4,
    vision: true,
    tools: true,
  },
  "gpt-5": {
    contextWindow: 400_000,
    priceInPerMTokens: 1.25,
    priceOutPerMTokens: 10,
    vision: true,
    tools: true,
  },
  "gpt-5-mini": {
    contextWindow: 400_000,
    priceInPerMTokens: 0.25,
    priceOutPerMTokens: 2,
    vision: true,
    tools: true,
  },
  o3: {
    contextWindow: 200_000,
    priceInPerMTokens: 2,
    priceOutPerMTokens: 8,
    vision: true,
    tools: true,
  },
  "o4-mini": {
    contextWindow: 200_000,
    priceInPerMTokens: 1.1,
    priceOutPerMTokens: 4.4,
    vision: true,
    tools: true,
  },
  "gpt-4-turbo": {
    contextWindow: 128_000,
    priceInPerMTokens: 10,
    priceOutPerMTokens: 30,
    vision: true,
    tools: true,
  },
  // —— Anthropic ——
  "claude-opus-4-1": {
    contextWindow: 200_000,
    priceInPerMTokens: 15,
    priceOutPerMTokens: 75,
    vision: true,
    tools: true,
  },
  "claude-sonnet-4-5": {
    contextWindow: 200_000,
    priceInPerMTokens: 3,
    priceOutPerMTokens: 15,
    vision: true,
    tools: true,
  },
  "claude-haiku-4-5": {
    contextWindow: 200_000,
    priceInPerMTokens: 1,
    priceOutPerMTokens: 5,
    vision: true,
    tools: true,
  },
  "claude-3-7-sonnet-latest": {
    contextWindow: 200_000,
    priceInPerMTokens: 3,
    priceOutPerMTokens: 15,
    vision: true,
    tools: true,
  },
  "claude-3-5-sonnet-latest": {
    contextWindow: 200_000,
    priceInPerMTokens: 3,
    priceOutPerMTokens: 15,
    vision: true,
    tools: true,
  },
  "claude-3-5-haiku-latest": {
    contextWindow: 200_000,
    priceInPerMTokens: 0.8,
    priceOutPerMTokens: 4,
    tools: true,
  },
  // —— Google Gemini ——
  "gemini-2.5-pro": {
    contextWindow: 1_048_576,
    priceInPerMTokens: 1.25,
    priceOutPerMTokens: 10,
    vision: true,
    tools: true,
  },
  "gemini-2.5-flash": {
    contextWindow: 1_048_576,
    priceInPerMTokens: 0.3,
    priceOutPerMTokens: 2.5,
    vision: true,
    tools: true,
  },
  "gemini-2.0-flash": {
    contextWindow: 1_048_576,
    priceInPerMTokens: 0.1,
    priceOutPerMTokens: 0.4,
    vision: true,
    tools: true,
  },
  "gemini-1.5-pro": {
    contextWindow: 2_097_152,
    priceInPerMTokens: 1.25,
    priceOutPerMTokens: 5,
    vision: true,
    tools: true,
  },
  "gemini-1.5-flash": {
    contextWindow: 1_048_576,
    priceInPerMTokens: 0.075,
    priceOutPerMTokens: 0.3,
    vision: true,
    tools: true,
  },
  // —— Ollama / 本地开源系（无价格；窗口为常用发行默认，量化变体同基）——
  qwen3: { contextWindow: 131_072, tools: true },
  "qwen3-coder": { contextWindow: 262_144, tools: true },
  "qwen2.5": { contextWindow: 131_072, tools: true },
  "deepseek-r1": { contextWindow: 131_072 },
  llama3: { contextWindow: 8_192 },
  "llama3.1": { contextWindow: 128_000, tools: true },
  "llama3.2": { contextWindow: 128_000, tools: true },
  "llama3.3": { contextWindow: 128_000, tools: true },
  mistral: { contextWindow: 32_768, tools: true },
  "mistral-nemo": { contextWindow: 128_000, tools: true },
  gemma3: { contextWindow: 128_000, vision: true },
  gemma2: { contextWindow: 8_192 },
  phi4: { contextWindow: 16_384 },
};

/** 市场惯用短名 → 目录键（显式别名，归一序兜底前命中） */
const ALIASES: Record<string, string> = {
  "claude-3-5-sonnet": "claude-3-5-sonnet-latest",
  "claude-3-5-haiku": "claude-3-5-haiku-latest",
  "claude-3-7-sonnet": "claude-3-7-sonnet-latest",
  "claude-sonnet-4": "claude-sonnet-4-5",
  "claude-haiku-4": "claude-haiku-4-5",
  "claude-opus-4": "claude-opus-4-1",
  "deepseek-v3": "deepseek-chat",
  "kimi-k2": "kimi-k2-instruct",
};

/** OpenAI 日期后缀（gpt-4o-2024-07-18 → gpt-4o） */
const DATE_SUFFIX = /-(20\d{2})-(\d{2})-(\d{2})$/;

/** 归一候选序：原值 → 剥冒号 tag → 剥路径前缀 → 剥日期后缀（逐级再试） */
function candidatesOf(rawModelId: string): string[] {
  const id = rawModelId.trim().toLowerCase();
  if (!id) {
    return [];
  }
  const out = [id];
  // ollama tag：qwen3:8b / qwen3:latest → qwen3
  const colon = id.split(":")[0];
  if (colon && colon !== id) {
    out.push(colon);
  }
  // provider 路径前缀：openai/gpt-4o → gpt-4o（vLLM/LiteLLM 风格）
  const slash = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : "";
  if (slash) {
    out.push(slash);
    const slashColon = slash.split(":")[0];
    if (slashColon && slashColon !== slash) {
      out.push(slashColon);
    }
  }
  // OpenAI 日期后缀
  for (const base of [...out]) {
    if (DATE_SUFFIX.test(base)) {
      out.push(base.replace(DATE_SUFFIX, ""));
    }
  }
  // 别名表逐候选展开（claude-3-5-sonnet → …-latest）
  for (const base of [...out]) {
    const aliased = ALIASES[base];
    if (aliased && !out.includes(aliased)) {
      out.push(aliased);
    }
  }
  return out;
}

/** 目录查找（含别名容错）；未收录返回 undefined */
export function lookupModelCatalog(
  modelId: string,
): ModelCatalogEntry | undefined {
  for (const candidate of candidatesOf(modelId)) {
    const entry = CATALOG[candidate];
    if (entry) {
      return entry;
    }
  }
  return undefined;
}

/**
 * 生效上下文窗口四层兜底（Task 9 批 5 起）：model 显式 > 内置目录 >
 * provider 级默认 > DEFAULT_CONTEXT_WINDOW = 131_072。目录层先于 provider
 * ——目录值是按模型 id 的精确知识，provider 级是整服务商的粗默认。
 */
export function effectiveContextWindow(
  modelId: string,
  modelWindow: number | null | undefined,
  providerWindow: number | null | undefined,
): number {
  return (
    modelWindow ??
    lookupModelCatalog(modelId)?.contextWindow ??
    providerWindow ??
    DEFAULT_CONTEXT_WINDOW
  );
}
