import { Tabs } from "expo-router";
import {
  MessageCircle,
  Server,
  UserRound,
  Workflow,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";

import { AppIcon } from "@/components/AppIcon";
import { ChatsHeaderActions } from "@/components/chats-header-actions";
import { useThemeColors } from "@/store/theme";

/**
 * 底部四 Tab（微信范式 P0）：聊天/主机/编排/我的。Tab 图标用 SF Symbols
 * 命名（AppIcon 同款），选中态主题 primary；「我的」无大标题栏（微信
 * 「我」范式），页面自带安全区。
 */
export default function TabsLayout() {
  const { t } = useTranslation("common");
  const colors = useThemeColors();
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: "#8E8E93",
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t("tabChats"),
          headerRight: () => <ChatsHeaderActions />,
          tabBarIcon: ({ color, size }) => (
            <AppIcon
              name="bubble.left.and.bubble.right"
              fallback={MessageCircle}
              size={size}
              color={color as string}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="connections"
        options={{
          title: t("tabHosts"),
          tabBarIcon: ({ color, size }) => (
            <AppIcon
              name="desktopcomputer"
              fallback={Server}
              size={size}
              color={color as string}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="orchestration"
        options={{
          title: t("tabOrchestration"),
          tabBarIcon: ({ color, size }) => (
            <AppIcon
              name="arrow.triangle.branch"
              fallback={Workflow}
              size={size}
              color={color as string}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t("tabMe"),
          headerShown: false,
          tabBarIcon: ({ color, size }) => (
            <AppIcon
              name="person.crop.circle"
              fallback={UserRound}
              size={size}
              color={color as string}
            />
          ),
        }}
      />
    </Tabs>
  );
}
