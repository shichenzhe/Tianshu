/**
 * url 凭据脱敏与预览截断（共用工具）：自 RequestLoggerInterceptor 抽取
 * （operation-log 拦截器复用同口径，DRY）；打码/截断语义不变，原单测
 * （request-logger.spec）继续守护。
 */

/** 敏感值打码占位符 */
export const MASKED_VALUE = '***';

/** url 预览截断上限（桌面审计链 commandPreview 同款 100 字符口径：
 *  只落预览不落全量入参，operation-log details 与安全审计共用） */
export const URL_PREVIEW_MAX_LENGTH = 100;

/**
 * url 的 token 泄露面打码：query 参数值 + /webhook/ 路径段（webhook
 * token 是 URL path 的一部分，2026-11-02 审查曾整段明文落按日日志）
 */
export function maskUrlToken(url: string): string {
  let masked = url.replace(/([?&])token=[^&]*/gi, `$1token=${MASKED_VALUE}`);
  masked = masked.replace(
    /(\/webhook\/)[a-f0-9]{16,}/gi,
    `$1${MASKED_VALUE}`,
  );
  return masked;
}

/**
 * url 预览（operation-log details 口径，security.md §6 P0-2）：token 面
 * 打码后截断 100 字符——对齐桌面审计链 commandPreview 的「预览不落全量」
 * 脱敏先例（IP/UA 由 operation_log 表列既有承载）
 */
export function urlPreview(url: string): string {
  return maskUrlToken(url).slice(0, URL_PREVIEW_MAX_LENGTH);
}
