/**
 * 相对时间格式化（T13 会话列表行时间；M2c 增未来分支供自动化 nextRunAt）。
 * 返回 i18n 描述子而非成品文案：logic 层保持纯函数零语言假设，
 * 渲染侧经 t("chat:relativeXxx") 映射（date 分支为数字串无需翻译）。
 * 语义阶梯：60s 内刚刚 → 60min 内 N 分钟前 → 同日 N 小时前 →
 * 上一自然日昨天 → 同年 MM-DD / 跨年 YYYY-MM-DD（本地时区口径）。
 * 未来（M2c）：60s 内即将 → 60min 内 N 分钟后 → 同日 N 小时后 →
 * 同年 MM-DD / 跨年 YYYY-MM-DD（间隔向上取整：5.5 分钟报 6 分钟后）。
 */

export type RelativeTimeMsg =
  | { key: "justNow" }
  | { key: "minutesAgo"; count: number }
  | { key: "hoursAgo"; count: number }
  | { key: "yesterday" }
  | { key: "date"; text: string }
  | { key: "inMoments" }
  | { key: "inMinutes"; count: number }
  | { key: "inHours"; count: number };

/** 同一自然日（本地时区） */
function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** b 是否为 a 的上一自然日（以 a 的零点前推 1 天比对，避开月初/月末算术） */
function isPreviousDay(a: Date, b: Date): boolean {
  const startOfA = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const dayBefore = new Date(startOfA.getTime() - 24 * 60 * 60 * 1000);
  return isSameDay(dayBefore, b);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatRelative(iso: string, now: Date = new Date()): RelativeTimeMsg {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) {
    return { key: "date", text: "" };
  }
  const sameYear = now.getFullYear() === then.getFullYear();
  const absText = sameYear
    ? `${pad2(then.getMonth() + 1)}-${pad2(then.getDate())}`
    : `${then.getFullYear()}-${pad2(then.getMonth() + 1)}-${pad2(then.getDate())}`;
  const diffMs = now.getTime() - then.getTime();
  if (diffMs >= 0) {
    if (diffMs < 60 * 1000) return { key: "justNow" };
    if (diffMs < 60 * 60 * 1000) {
      return { key: "minutesAgo", count: Math.floor(diffMs / 60_000) };
    }
    if (isSameDay(now, then)) {
      return { key: "hoursAgo", count: Math.floor(diffMs / 3_600_000) };
    }
    if (isPreviousDay(now, then)) return { key: "yesterday" };
    return { key: "date", text: absText };
  }
  // 未来（nextRunAt 语义）：间隔向上取整，跨日直接给绝对日期
  const aheadMs = -diffMs;
  if (aheadMs < 60 * 1000) return { key: "inMoments" };
  if (aheadMs < 60 * 60 * 1000) {
    return { key: "inMinutes", count: Math.ceil(aheadMs / 60_000) };
  }
  if (isSameDay(now, then)) {
    return { key: "inHours", count: Math.ceil(aheadMs / 3_600_000) };
  }
  return { key: "date", text: absText };
}

/** 绝对时间（执行详情批 run 级开始/结束）：同年 MM-DD HH:mm、跨年
 * YYYY-MM-DD HH:mm（本地时区）；畸形 iso 空串防御（formatRelative 同款） */
export function formatAbsolute(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const hm = `${pad2(then.getHours())}:${pad2(then.getMinutes())}`;
  const sameYear = now.getFullYear() === then.getFullYear();
  const date = sameYear
    ? `${pad2(then.getMonth() + 1)}-${pad2(then.getDate())}`
    : `${then.getFullYear()}-${pad2(then.getMonth() + 1)}-${pad2(then.getDate())}`;
  return `${date} ${hm}`;
}

/** 耗时格式化（运行历史行/执行详情共用）：<60s 秒一位小数、否则分钟
 * 整数；运行中/无值空串 */
export function durationLabel(ms: number | undefined): string {
  if (ms == null) return "";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
