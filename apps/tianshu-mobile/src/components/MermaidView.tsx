import { useState } from "react";
import { Text, View } from "react-native";
import { useColorScheme } from "nativewind";
import { Workflow } from "lucide-react-native";
import { WebView } from "react-native-webview";

import { CodeBlock } from "@/components/CodeBlock";
import { buildMermaidSrcDoc, parseMermaidFrame } from "@/logic/mermaid-srcdoc";
import { WIDGET_INITIAL_HEIGHT } from "@/logic/widget-srcdoc";
import { useThemeColors } from "@/store/theme";

/**
 * mermaid 图渲染卡（富内容批，桌面 MermaidBlock 语义移植）：```mermaid
 * 围栏经沙箱 WebView 渲染（runtime CDN 加载——本地资产化留后续，网络
 * 不可达降级），失败（网络/语法错误）降级代码块显源码；高度自适应复用
 * widget 桥（clamp 40-800）。
 */
export function MermaidView({ code }: { code: string }) {
  const dark = useColorScheme().colorScheme === "dark";
  const colors = useThemeColors();
  const [height, setHeight] = useState(WIDGET_INITIAL_HEIGHT);
  const [failed, setFailed] = useState(false);

  // 失败降级：代码块显源码（模型语法错误可见原文，长按可复制修正——
  // 对齐桌面语义）
  if (failed) {
    return <CodeBlock node={{ type: "code", lang: "mermaid", code }} />;
  }

  return (
    <View className="my-2 overflow-hidden rounded-2xl bg-card dark:bg-[#1C1C1E]">
      <View className="flex-row items-center gap-1.5 border-b border-sep bg-field px-3 py-1.5 dark:border-[#545458A6] dark:bg-[#2C2C2E]">
        <Workflow size={13} color={colors.primary} />
        <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
          mermaid
        </Text>
      </View>
      <WebView
        source={{ html: buildMermaidSrcDoc(code, dark) }}
        javaScriptEnabled
        originWhitelist={["*"]}
        style={{ height, backgroundColor: "transparent" }}
        onMessage={(e) => {
          const frame = parseMermaidFrame(e.nativeEvent.data);
          if (frame == null) return;
          if (frame.type === "error") {
            setFailed(true);
            return;
          }
          setHeight(frame.height);
        }}
      />
    </View>
  );
}
