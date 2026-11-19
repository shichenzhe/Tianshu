/**
 * 请求级隐藏系统上下文：仅用于模型调用，不落用户消息、不进会话 UI。
 * 图 AI 的编排指令与当前图快照经此随每轮发送刷新。
 */
export function mergeRequestSystem(
  sessionSystem: string | undefined,
  requestSystem: string | undefined,
): string | undefined {
  const parts = [sessionSystem, requestSystem].filter((part): part is string =>
    Boolean(part?.trim()),
  );
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
