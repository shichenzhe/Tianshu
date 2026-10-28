import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Text, View } from "react-native";
import { BarChart3 } from "lucide-react-native";
import { WebView } from "react-native-webview";

import {
  buildWidgetSrcDoc,
  parseWidgetResize,
  WIDGET_INITIAL_HEIGHT,
} from "@/logic/widget-srcdoc";
import { useThemeColors } from "@/store/theme";

/**
 * show_widget 可视化卡（MR-T1，桌面 WidgetRenderer 语义移植）：
 * 沙箱 WebView 渲染模型产出的 HTML/JS——独立原生视图无同源共享，安全
 * 语义不弱于桌面 iframe sandbox=allow-scripts；文档内自带 CSP 与高度
 * 上报脚本（ReactNativeWebView 桥），onMessage 解析 clamp 40-800。
 * running/awaiting-approval 加载占位，其余终态一次性注入。
 */
export function WidgetCard({
  title,
  code,
  state,
}: {
  title?: string;
  code: string;
  /** 工具执行态（与 ChatStreamChunk tool-update.state 同词表） */
  state: string;
}) {
  const { t } = useTranslation("chat");
  const colors = useThemeColors();
  const [height, setHeight] = useState(WIDGET_INITIAL_HEIGHT);
  const ready = state !== "running" && state !== "awaiting-approval";

  return (
    <View className="my-2 overflow-hidden rounded-2xl bg-card dark:bg-[#1C1C1E]">
      <View className="flex-row items-center gap-1.5 border-b border-sep bg-field px-3 py-1.5 dark:border-[#545458A6] dark:bg-[#2C2C2E]">
        <BarChart3 size={13} color={colors.primary} />
        <Text
          numberOfLines={1}
          className="flex-1 text-xs text-label2 dark:text-[#EBEBF599]"
        >
          {title ?? t("widgetDefaultTitle")}
        </Text>
      </View>
      {ready ? (
        <WebView
          source={{ html: buildWidgetSrcDoc(code) }}
          javaScriptEnabled
          originWhitelist={["*"]}
          style={{ height, backgroundColor: "transparent" }}
          onMessage={(e) => {
            const next = parseWidgetResize(e.nativeEvent.data);
            if (next != null) setHeight(next);
          }}
        />
      ) : (
        <View
          className="flex-row items-center justify-center gap-2 px-3 py-6"
          style={{ height: WIDGET_INITIAL_HEIGHT }}
        >
          <ActivityIndicator size="small" color="#8E8E93" />
          <Text className="text-xs text-label2 dark:text-[#EBEBF599]">
            {t("widgetLoading")}
          </Text>
        </View>
      )}
    </View>
  );
}
