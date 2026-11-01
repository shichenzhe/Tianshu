/**
 * 聊天采样参数（三级覆盖：model 默认 < assistant < 单次请求）
 */
export interface ChatModelParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

/**
 * 模型上下文窗口空配置（model.contextWindow = NULL）时的生效兜底
 * （2026-11-01 用户裁定 128K）：历史截断（truncateHistory）与自动压缩
 * 阈值均以 contextWindow 为据，NULL 不兜底则两者整体失效——实测长会话
 * 单轮 input 可失控至数百万 token。取 131072（1024 进制 128K，与前端
 * ModelDialog 新建预填/model-summary 默认判定的既有缺省同源）；DB 仍存
 * NULL（默认语义单点可调，不写死存量数据）
 */
export const DEFAULT_CONTEXT_WINDOW = 131_072;

const PARAM_KEYS = ["temperature", "topP", "maxTokens"] as const;

/**
 * 逐字段合并，靠后的层优先；全空字段返回 undefined（调用方不传给 SDK）
 */
export function mergeParams(
  layers: (ChatModelParams | undefined)[],
): ChatModelParams {
  const merged: ChatModelParams = {};
  for (const key of PARAM_KEYS) {
    for (let i = layers.length - 1; i >= 0; i--) {
      const value = layers[i]?.[key];
      if (value !== undefined && value !== null) {
        merged[key] = value;
        break;
      }
    }
  }
  return merged;
}
