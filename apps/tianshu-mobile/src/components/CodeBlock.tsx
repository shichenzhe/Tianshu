import * as Clipboard from "expo-clipboard";
import { Platform, Pressable, Text } from "react-native";
import { useTranslation } from "react-i18next";

import { toast } from "@/lib/toast-bus";
import type { MarkdownNode } from "@/logic/markdown";

/** 代码块深底浅字（浅深色主题同款——语义状态色非主题色）；MONO 供
 *  行内代码等处同款字体（富内容批自 MarkdownLite 抽出，避免 MermaidView
 *  降级复用与 MarkdownLite 互引成环） */
export const CODE_BG = "#1e293b";
export const CODE_FG = "#e2e8f0";
export const MONO = Platform.select({ ios: "Menlo", android: "monospace" });

/** 代码块（长按复制——expo-clipboard + toast 总线，i18n 复用 chat 既有 key） */
export function CodeBlock({
  node,
}: {
  node: Extract<MarkdownNode, { type: "code" }>;
}) {
  const { t } = useTranslation("chat");
  const handleCopy = () => {
    void Clipboard.setStringAsync(node.code)
      .then(() => toast.info(t("copied")))
      .catch(() => toast.error(t("copyFailed")));
  };
  return (
    <Pressable
      onLongPress={handleCopy}
      accessibilityLabel={t("copy")}
      className="my-1 rounded-lg px-3 py-2"
      style={{ backgroundColor: CODE_BG }}
    >
      {node.lang !== "" && (
        <Text className="mb-1 text-[10px]" style={{ color: "#94a3b8" }}>
          {node.lang}
        </Text>
      )}
      <Text
        style={{
          fontFamily: MONO,
          fontSize: 12,
          color: CODE_FG,
          lineHeight: 17,
        }}
      >
        {node.code}
      </Text>
    </Pressable>
  );
}
