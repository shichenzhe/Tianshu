/**
 * 聊天采样参数（三级覆盖：model 默认 < assistant < 单次请求）
 */
export interface ChatModelParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

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
