/**
 * 浏览器工具栏动作 IPC（WorkBuddy `...` 菜单对齐）：设备模拟 / 截图
 * （返回 dataURL，剪贴板写入在渲染层 W3C clipboard）/ 外部浏览器打开。
 * guest 反查安全口径同 guest-registry——按 id 取 webContents 后必须校验
 * browser partition 与存活（防任意 wc 借道操控）；入参校验纯函数独立
 * 导出（electron mock 可测，照 browser-session 先例）。
 */
import { shell, webContents, type WebContents } from "electron";
import { handleUser } from "../../../commons/ipc-user";
import { isBrowserGuestSession } from "./browser-session";

/** 设备预设入参（渲染层菜单形状；avail* 为 webview 元素实际可视区，
 *  渲染层上报——Electron 44 WebContents 无 getBounds 可查） */
export interface DevicePresetParams {
  width: number;
  height: number;
  deviceScaleFactor: number;
  screenPosition: "mobile" | "desktop";
  availWidth?: number;
  availHeight?: number;
}

/** 预设尺寸/DPR 合法区间（常见手机～4K 桌面；DPR 覆盖 1–4 含 2.625 档） */
const PRESET_SIZE_RANGE = { min: 200, max: 3840 } as const;
const PRESET_DPR_RANGE = { min: 1, max: 4 } as const;

function readBoundedNumber(
  value: unknown,
  range: { min: number; max: number },
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `device preset field must be a finite number, got: ${String(value)}`,
    );
  }
  if (value < range.min || value > range.max) {
    throw new Error(
      `device preset field out of range [${range.min}, ${range.max}], got: ${value}`,
    );
  }
  return value;
}

/** 设备预设校验（fail-fast：非法形状抛错而非静默猜默认）；null 直通 = 关闭模拟 */
export function readDevicePresetParams(
  value: unknown,
): DevicePresetParams | null {
  if (value === null) return null;
  if (typeof value !== "object" || value === null) {
    throw new Error("device preset must be an object or null");
  }
  const raw = value as Record<string, unknown>;
  const screenPosition = raw.screenPosition ?? "mobile";
  if (screenPosition !== "mobile" && screenPosition !== "desktop") {
    throw new Error(
      `device preset screenPosition invalid: ${String(screenPosition)}`,
    );
  }
  return {
    width: readBoundedNumber(raw.width, PRESET_SIZE_RANGE),
    height: readBoundedNumber(raw.height, PRESET_SIZE_RANGE),
    deviceScaleFactor: readBoundedNumber(
      raw.deviceScaleFactor,
      PRESET_DPR_RANGE,
    ),
    screenPosition,
    // avail 可选（渲染层 rect 未就绪时不缩放）；给了则须为正数
    ...(typeof raw.availWidth === "number" && Number.isFinite(raw.availWidth)
      ? { availWidth: raw.availWidth }
      : {}),
    ...(typeof raw.availHeight === "number" && Number.isFinite(raw.availHeight)
      ? { availHeight: raw.availHeight }
      : {}),
  };
}

/** enableDeviceEmulation 参数（从 WebContents 签名推导，随 Electron 版本演进） */
type EmulationParams = NonNullable<
  Parameters<WebContents["enableDeviceEmulation"]>[0]
>;

/**
 * 预设 → 模拟参数。viewSize=screenSize；scale 自算 fit：模拟视口超出
 * webview 元素可视区（渲染层上报 avail*）时整体缩小——Electron 44 无
 * scaleToFit，见 Parameters 定义；avail 缺席按 1（不缩放）
 */
export function toEmulationParams(preset: DevicePresetParams): EmulationParams {
  const fit =
    preset.availWidth && preset.availHeight
      ? Math.min(
          1,
          preset.availWidth / preset.width,
          preset.availHeight / preset.height,
        )
      : 1;
  return {
    screenPosition: preset.screenPosition,
    screenSize: { width: preset.width, height: preset.height },
    viewPosition: { x: 0, y: 0 },
    deviceScaleFactor: preset.deviceScaleFactor,
    viewSize: { width: preset.width, height: preset.height },
    scale: Math.round(fit * 100) / 100,
  };
}

/** 外开 url 白名单：仅 http(s)——shell.openExternal 放行 file:// 等本地
 *  处理器，菜单入口不背任意协议执行的锅 */
export function readExternalUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`external url must be a string, got: ${String(value)}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`invalid external url: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`external url protocol not allowed: ${parsed.protocol}`);
  }
  return value;
}

/** 按 id 反查合法 browser guest（整型 id + 存活 + browser partition 三查） */
export function resolveBrowserGuest(wcId: unknown): WebContents | null {
  if (typeof wcId !== "number" || !Number.isInteger(wcId)) return null;
  const wc = webContents.fromId(wcId);
  if (!wc || wc.isDestroyed()) return null;
  if (!isBrowserGuestSession(wc.session)) return null;
  return wc;
}

/** 工具栏动作装配（Application 启动调一次，与 registerBrowserIpc 并列） */
export function registerBrowserActionsIpc(): void {
  handleUser(
    "browser:emulateDevice",
    async (_event, _userId, wcId: unknown, preset: unknown) => {
      const wc = resolveBrowserGuest(wcId);
      if (!wc) throw new Error("BROWSER_GUEST_NOT_FOUND");
      const params = readDevicePresetParams(preset);
      if (params) wc.enableDeviceEmulation(toEmulationParams(params));
      else wc.disableDeviceEmulation();
    },
  );
  // 截图回 dataURL：剪贴板写入在渲染层（Electron 44 主进程 clipboard 无
  // writeImage，ClipboardItem 也不从主进程导出；W3C clipboard 走 secure
  // context 渲染层——file:// 与 localhost 均算）
  handleUser(
    "browser:captureScreenshot",
    async (_event, _userId, wcId: unknown) => {
      const wc = resolveBrowserGuest(wcId);
      if (!wc) throw new Error("BROWSER_GUEST_NOT_FOUND");
      return (await wc.capturePage()).toDataURL();
    },
  );
  handleUser("browser:openExternal", async (_event, _userId, url: unknown) => {
    await shell.openExternal(readExternalUrl(url));
  });
}
