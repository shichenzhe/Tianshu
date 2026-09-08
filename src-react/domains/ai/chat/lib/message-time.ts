/**
 * 消息时间戳格式化（user 消息 hover 操作栏）：基于 Intl.DateTimeFormat 三档
 * - 同日 → HH:mm（24 小时制，时/分两位补零）
 * - 同年不同日 → zh-CN「9月6日 14:30」/ en-US「Sep 6, 14:30」（月日不补零）
 * - 跨年 → zh-CN「2025/1/1 10:00」/ en-US「Jan 1, 2025, 10:00」
 * 纯函数；now 注入以便单测（缺省取当前时钟），无效日期返回空串
 */

/** 同日判断按本地时区年月日比较（时间戳随应用本地时钟展示） */
function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 当天档：仅时分（h23 固定 24 小时制，避免 hour12 在部分环境映射为 h24） */
function timeOnly(locale: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

/** 同年不同日档：短月名 + 日（均不补零） */
function monthDay(locale: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

/** 跨年档：中文数字月日（2025/1/1），西文短月名带年份 */
function fullDate(locale: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: locale.startsWith("zh") ? "numeric" : "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

export function formatMessageTime(
  iso: string,
  locale: string,
  now?: Date,
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const ref = now ?? new Date();
  if (isSameDay(date, ref)) {
    return timeOnly(locale).format(date);
  }
  return date.getFullYear() === ref.getFullYear()
    ? monthDay(locale).format(date)
    : fullDate(locale).format(date);
}
