import type { RelativeTimeMsg } from "@/logic/time";

/**
 * 相对时间描述子 → 成品文案（T13 抽自 SessionRow，M2c 自动化卡 nextRunAt
 * 复用）：文案 key 单源 chat namespace 的 relative* 组（未来分支 M2c 增补）。
 * t 采用结构化窄签名——消费端 useTranslation 的 TFunction 均可直传。
 */
export function relativeTimeLabel(
  msg: RelativeTimeMsg,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string {
  switch (msg.key) {
    case "justNow":
      return t("chat:relativeJustNow");
    case "minutesAgo":
      return t("chat:relativeMinutesAgo", { n: msg.count });
    case "hoursAgo":
      return t("chat:relativeHoursAgo", { n: msg.count });
    case "yesterday":
      return t("chat:relativeYesterday");
    case "inMoments":
      return t("chat:relativeInMoments");
    case "inMinutes":
      return t("chat:relativeInMinutes", { n: msg.count });
    case "inHours":
      return t("chat:relativeInHours", { n: msg.count });
    case "date":
      return msg.text;
  }
}
