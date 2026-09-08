/**
 * 桌面通知辅助：授权态读取、系统授权设置跳转、测试通知发送
 */

/** 测试通知标题（ASCII 应用名，与 package.json name 一致） */
const APP_ASCII_NAME = "Tianshu";

/** 平台对应的系统通知授权设置页地址（不支持的系统返回 null 不跳转） */
export function notificationSettingsUrl(): string | null {
  const userAgent = navigator.userAgent;
  if (userAgent.includes("Mac")) {
    return "x-apple.systempreferences:com.apple.preference.notifications";
  }
  if (userAgent.includes("Windows")) {
    return "ms-settings:notifications:";
  }
  return null;
}

/** 跳转系统通知授权设置页 */
export function openNotificationSettings(): void {
  const url = notificationSettingsUrl();
  if (url) {
    window.open(url);
  }
}

/** 当前桌面通知授权态（无 Notification 的环境按未授权处理） */
export function desktopPermission(): NotificationPermission {
  return typeof Notification === "undefined"
    ? "denied"
    : Notification.permission;
}

/** 发送一条测试桌面通知（Electron 渲染层 Notification 可用） */
export function sendTestNotification(body: string): void {
  new Notification(APP_ASCII_NAME, { body });
}
