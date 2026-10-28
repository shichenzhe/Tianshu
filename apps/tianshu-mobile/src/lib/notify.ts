import { AppState, Platform } from "react-native";

/**
 * 本地通知封装（M3）：审批请求与图运行终态的移动端提醒。
 * 背景裁定：Expo Go 无远程推送（需 EAS development build），本期仅本地
 * 通知——app 前台/后台存活期内可达，被杀则收不到（已知限制）。
 * 触发策略：仅 AppState === "background"（真后台）时发——前台用户已在
 * 界面上可见 Banner/徽标，不重复打扰；iOS inactive（通知中心/控制中心/
 * 系统弹窗遮盖）不算后台，同样不打扰（M4：旧口径非 active 即发，遮盖态
 * 通知黑洞）。通知失败一律静默（不影响主流程）。
 *
 * 真机修复（Expo Go 57/Android）：**不静态 import expo-notifications**——
 * 库顶层初始化即 requireNativeModule（ExpoTopicSubscriptionModule 缺失
 * 抛错），静态 import 会在依赖它的全部路由（orchestration/settings/
 * session）加载链上炸出「missing default export」。改为调用期动态
 * import() + 失败降级 null（通知整体 no-op）——库进依赖图但其顶层仅在
 * 首次调用时执行；通知调用本就 fire-and-forget，异步化零影响。
 */

type NotificationsLib = typeof import("expo-notifications");

/** 惰性库句柄缓存：null=不可用（web/原生面缺失/加载异常） */
let libPromise: Promise<NotificationsLib | null> | null = null;

function notificationsLib(): Promise<NotificationsLib | null> {
  if (libPromise === null) {
    libPromise =
      Platform.OS === "web"
        ? Promise.resolve(null)
        : // 同步接坑（真机 2026-10-25）：metro/Babel 会把动态 import() 内联
          // 为同步 require——模块顶层 requireNativeModule 抛错发生在
          // .then(ok, err) 挂接之前，同步异常冒泡到调用方即 Uncaught
          // （ExpoTopicSubscriptionModule 缺失崩溃）。包进 Promise 构造内
          // try，同步/异步两条失败路径都收敛为 null 降级
          new Promise<NotificationsLib | null>((resolve) => {
            try {
              resolve(import("expo-notifications"));
            } catch {
              resolve(null);
            }
          }).then(
            (lib) => lib,
            () => null, // 异步 rejection（原降级路径保留）
          );
  }
  return libPromise;
}

// Android 通知渠道注册（expo-notifications 官方要求：Android 8+ 必须有
// 渠道才能展示）。importance HIGH（M4）：审批时效性横幅（锁屏/横幅直达），
// DEFAULT 无横幅。首发通知时幂等注册一次，失败静默（后续调度走系统
// 默认渠道兜底）。
let channelEnsured = false;
async function ensureChannel(lib: NotificationsLib): Promise<void> {
  if (channelEnsured || Platform.OS !== "android") {
    return;
  }
  channelEnsured = true;
  try {
    await lib.setNotificationChannelAsync("default", {
      name: "default",
      importance: lib.AndroidImportance.HIGH,
    });
  } catch {
    /* 静默：渠道注册失败不阻断通知调度链 */
  }
}

/** 请求通知权限（设置页首次打开总开关时调用）；web/不可用恒 false */
export async function requestNotificationPermission(): Promise<boolean> {
  const lib = await notificationsLib();
  if (lib === null) return false;
  try {
    const current = await lib.getPermissionsAsync();
    if (current.granted) return true;
    const requested = await lib.requestPermissionsAsync();
    return requested.granted;
  } catch {
    return false; // 原生模块异常按未授权处理
  }
}

export interface NotifyLocalOptions {
  title: string;
  body: string;
}

/** 立即发一条本地通知（仅真后台态；失败静默不影响主流程） */
export function notifyLocal(opts: NotifyLocalOptions): void {
  // 仅 background 发：active（前台不打扰）与 iOS inactive（遮盖态非后台，
  // 通知中心下拉时发通知=黑洞）均跳过
  if (AppState.currentState !== "background") return;
  void notificationsLib().then(async (lib) => {
    if (lib === null) return;
    await ensureChannel(lib); // 首发时注册（幂等）
    try {
      await lib.scheduleNotificationAsync({
        content: { title: opts.title, body: opts.body },
        trigger: null, // null = 立即投递
      });
    } catch {
      /* 静默：调度失败不阻断事件归并 */
    }
  });
}
