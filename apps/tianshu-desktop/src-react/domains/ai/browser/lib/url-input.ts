/**
 * 地址栏 / 新标签页共用的输入解析（复刻 WorkBuddy new-tab-input 判定）：
 * 含空白→搜索词形态（false）；显式 http(s) 协议头（file: 等其他协议不按网址
 * 处理，spec 安全模型）/ localhost / 127.0.0.1 / 形如 a.b（含点且点后有内容）
 * → 网址（true）。搜索兜底刻意不做（spec 假设 2），非网址由调用方提示
 * 「仅支持直接访问网址」。
 */

/** 判定输入是否更像「网址」而非「搜索词」 */
export function looksLikeUrl(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (/^https?:\/\//i.test(trimmed)) return true;
  // 显式 http(s) 以外的协议头（file: 等）一律不按网址处理（spec 安全模型）
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)) return false;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(trimmed)) return true;
  return /^[^\s]+\.[^\s]+/.test(trimmed);
}

/** 网址补 https:// 前缀返回；非网址/空输入返回 null（调用方提示） */
export function resolveAddressInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || !looksLikeUrl(trimmed)) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}
