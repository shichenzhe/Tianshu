/**
 * 自动化重试纯函数（批3A，spec docs/design/automation-scheduled-tasks.md
 * §6-4）：60s 固定冷却 → 指数退避（60/180/540s），并按 classifyError
 * （./error-classify.ts）错误分类区分可重试面——网络/限流/超时/未知等
 * 瞬时态重试；AUTH_FAILED/MODEL_NOT_FOUND/IMAGE_UNSUPPORTED 配置类
 * 不重试（重试无益：本机三元组 workspace/model/graph_missing 走
 * failRun 停调度先例，不在此面）。双端调度器（桌面/server）同构消费。
 */

/** 退避基准：第 1 次失败后冷却 60s */
export const RETRY_BASE_MS = 60_000;
/** 退避封顶（3^(attempt-1) 第 3 级即到顶；防脏数据放大延迟） */
export const RETRY_MAX_DELAY_MS = 540_000;

/** 指数退避：attempt 为「已失败的那次尝试」序号，返回再试 attempt+1 前的
 * 冷却毫秒——1→60s、2→180s、3→540s；attempt<1 与非法输入按第 1 级 */
export function nextRetryDelay(attempt: number): number {
  const level = Number.isFinite(attempt) && attempt > 1 ? attempt : 1;
  return Math.min(
    RETRY_BASE_MS * 3 ** (level - 1),
    RETRY_MAX_DELAY_MS,
  );
}

/** classifyError 配置类错误码：重试无益，不进重试扫描 */
const CONFIG_ERROR_CODES = new Set([
  "AUTH_FAILED",
  "MODEL_NOT_FOUND",
  "IMAGE_UNSUPPORTED",
]);

/** 错误码可重试判定：配置类 false；网络/限流/超时/UNKNOWN 及未收录码
 * （interrupted/graph_disabled/附件解析等遗留码）true——未收录默认
 * 可重试保留既有行为，避免新码面误杀 */
export function isRetryableErrorCode(code: string): boolean {
  return !CONFIG_ERROR_CODES.has(code.trim().toUpperCase());
}

/** run.error 提取错误码：剥离图运行聚合前缀 `node:<id> ` 后取首个
 * `:` 前段（prompt 型 `CODE: message` / 裸码 `interrupted`）；
 * null/空白 → 空串 */
export function parseRunErrorCode(
  error: string | null | undefined,
): string {
  if (!error) {
    return "";
  }
  const stripped = error.replace(/^node:\S+\s+/, "");
  const code = stripped.split(":")[0]?.trim() ?? "";
  return code;
}

/** run 行错误可重试判定（重试扫描消费）：error 缺席无法判定 → true，
 * 不放大破坏面 */
export function isRetryableRunError(
  error: string | null | undefined,
): boolean {
  if (!error) {
    return true;
  }
  return isRetryableErrorCode(parseRunErrorCode(error));
}
