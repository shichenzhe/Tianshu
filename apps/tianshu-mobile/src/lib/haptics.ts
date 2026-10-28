/**
 * 触觉反馈统一口（输入层现代化批）：AI 原生 APP 基线体验——发送受理
 * /审批决议等关键节点触觉确认。web 平台无触觉静默；fire-and-forget
 * 不 await 不阻塞交互。
 */
import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

/** 轻触：长按菜单唤起、次要按钮 */
export function tapLight(): void {
  if (Platform.OS === "web") return;
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

/** 成功：发送受理、审批通过 */
export function tapSuccess(): void {
  if (Platform.OS === "web") return;
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
    () => {},
  );
}
