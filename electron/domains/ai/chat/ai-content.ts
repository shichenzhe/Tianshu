/** LangChain AIMessage.content → 纯文本（string 直取；content block 数组
 * 拼 text 块；与 handover-summary defaultModelText 同口径） */
export function aiMessageContentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text"
          ? String((part as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
  }
  return String(content ?? "");
}
