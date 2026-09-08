/**
 * 桌面通知辅助：授权态读取、系统授权设置跳转、测试通知发送
 */

import { SettingsApi } from "../api/settings.api";

/** 平台对应的系统通知授权设置页地址（不支持的系统返回 null 不跳转） */
export function notificationSettingsUrl(): string | null {
  const userAgent = navigator.userAgent;
  if (userAgent.includes("Mac")) {
    return "x-apple.systempreferences:com.apple.preference.notifications";
  }
  if (userAgent.includes("Windows")) {
    return "ms-settings:notifications";
  }
  return null;
}

/**
 * 跳转系统通知授权设置页：经主进程 openExternal 白名单桥
 * （Chromium 对自定义 scheme 的 window.open 报 ERR_UNKNOWN_URL_SCHEME
 * 且无 OS 移交，渲染层直开不可用）；不支持的平台静默返回。
 */
export function openNotificationSettings(): Promise<void> {
  const url = notificationSettingsUrl();
  return url ? SettingsApi.openExternal(url) : Promise.resolve();
}

/** 当前桌面通知授权态（无 Notification 的环境按未授权处理） */
export function desktopPermission(): NotificationPermission {
  return typeof Notification === "undefined"
    ? "denied"
    : Notification.permission;
}

/** 发送一条测试桌面通知（Electron 渲染层 Notification 可用；标题由调用方传
 * t("common:appName")，避免硬编码应用名） */
export function sendTestNotification(title: string, body: string): void {
  new Notification(title, { body });
}
