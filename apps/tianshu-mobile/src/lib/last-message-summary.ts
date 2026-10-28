import type { SessionLastMessage } from "@tianshu/protocol";

/**
 * P1 未读角标批：末条消息摘要 → 会话行第二行文案。kind 映射本地化前缀
 * （wire 的 text 只承载语言中立内容——「[图片]/[工具]」类文案在消费端
 * 本地化）；text 直显原文（截断由渲染层 numberOfLines 承担）。
 */
export function lastMessageSummary(
  m: SessionLastMessage,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string {
  switch (m.kind) {
    case "text":
      return m.text;
    case "image":
      return t("chat:lastMsgImage");
    case "tool":
      return t("chat:lastMsgTool", { name: m.text });
    case "empty":
      return t("chat:lastMsgEmpty");
  }
}
