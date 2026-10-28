import "@/i18n";
import "../global.css";

import { useEffect } from "react";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useColorScheme } from "nativewind";
import { useTranslation } from "react-i18next";
import { LogBox } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { enableFreeze } from "react-native-screens";

import { ToastHost } from "@/components/toast";
import { useConnectionsStore } from "@/store/connections.store";
import { useOrchestrationStore } from "@/store/orchestration.store";
import { useBackupStore } from "@/store/backup.store";
import { useSessionsStore } from "@/store/sessions.store";

// 后台屏冻结（切页丝滑批）：非聚焦屏整树暂停 reconcile——推送新页/切 Tab
// 过程中，被盖住的会话列表不再因流式 session.updated/事件订阅反复重渲
// 挤占 JS 线程，过渡动画让出主线程；返回时屏幕解冻、store 状态即最新
// （事件照写 store，仅暂停渲染）。react-native-screens 全局开关，幂等。
enableFreeze(true);

// fetch→blob 本地读取链（真机修复 2026-10-24）触发的性能提示：本地文件
// 几 MB 内双拷贝开销可接受，压掉 dev 模式 LogBox 黄屏干扰（生产不弹）
LogBox.ignoreLogs(["Response.blob() is using React Native's Blob"]);

/**
 * App 启动装配（T13；M2c 增编排事件订阅）：
 * - sessions/orchestration 事件订阅（bindEvents 各自幂等，App 级单份：
 *   server.connected 全量重拉、session.updated 原地刷新、graph.run.updated
 *   run 投影归档、automation.changed 重拉）；
 * - 自动连接持久化的活动目标（T9 裁定）：load 完成后 activeConnId 存在则
 *   activate（连接建立后的 server.connected 事件自然触发会话列表首拉）。
 */
function useBootstrap() {
  useEffect(() => {
    useSessionsStore.getState().bindEvents();
    useOrchestrationStore.getState().bindEvents();
    // 备份面批：backup.progress 事件流（触发进度/终态复位——幂等单份）
    useBackupStore.getState().bindEvents();
    let cancelled = false;
    void useConnectionsStore
      .getState()
      .load()
      .then(() => {
        if (cancelled) return;
        const { activeConnId, activate } = useConnectionsStore.getState();
        if (activeConnId) activate(activeConnId);
      });
    return () => {
      cancelled = true;
    };
  }, []);
}

export default function RootLayout() {
  const { colorScheme } = useColorScheme();
  const { t } = useTranslation("common");
  useBootstrap();

  return (
    // RNGH 手势宿主（会话行左滑 Swipeable 依赖；flex:1 防根视图高度塌陷）
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
        {/* StatusBar 显式反转：expo auto 跟 RN Appearance，不随手动明暗档 */}
        <StatusBar style={colorScheme === "dark" ? "light" : "dark"} />
        <Stack
          screenOptions={{ headerShown: true, animation: "slide_from_right" }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen
            name="session/[id]"
            options={{ title: t("session.title") }}
          />
          <Stack.Screen name="monitor" options={{ headerShown: false }} />
          <Stack.Screen name="providers" options={{ headerShown: false }} />
          <Stack.Screen name="library" options={{ headerShown: false }} />
          <Stack.Screen name="experts" options={{ headerShown: false }} />
          <Stack.Screen name="workspaces" options={{ headerShown: false }} />
          <Stack.Screen name="projects" options={{ headerShown: false }} />
          <Stack.Screen name="projects/[id]" options={{ headerShown: false }} />
          <Stack.Screen name="skills/[slug]" options={{ headerShown: false }} />
          <Stack.Screen name="skills/market" options={{ headerShown: false }} />
          <Stack.Screen
            name="automation/new"
            options={{ headerShown: false }}
          />
        </Stack>
        {/* 轻提示宿主（App 级单份——提示类经 toast.* 发射，确认类走 Alert） */}
        <ToastHost />
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
