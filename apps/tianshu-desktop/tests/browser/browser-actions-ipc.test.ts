/**
 * 浏览器工具栏动作 IPC（WorkBuddy `...` 菜单对齐）：设备模拟 / 截图（主
 * 进程回 dataURL，剪贴板写入在渲染层）/ 外部浏览器打开。校验纯函数直测；
 * 三个 handler 经 ipc-user mock 捕获直驱（token 剥壳属 ipc-user 自身职责，
 * 不在此重复覆盖）；guest 反查安全口径（browser partition 校验）与
 * destroyed 双查照 guest-registry 先例。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const partitionSession = vi.hoisted(() => ({}));
/** browser partition 合法 guest（id 7）；异己 guest（id 8，session 不同实例） */
const fakeWc = vi.hoisted(() => {
  const wc = {
    id: 7,
    session: null as unknown,
    isDestroyed: vi.fn(() => false),
    enableDeviceEmulation: vi.fn(),
    disableDeviceEmulation: vi.fn(),
    capturePage: vi.fn(async () => ({
      toDataURL: () => "data:image/png;base64,QUJD",
    })),
  };
  wc.session = partitionSession;
  return wc;
});
const shellOpenExternal = vi.hoisted(() => vi.fn(async () => {}));
/** webContents.fromId 换桩口：注册表式，供异己 guest 用例动态挂桩 */
const guestById = vi.hoisted(() => new Map<number, unknown>());
const handlers = vi.hoisted(
  () => new Map<string, (...args: unknown[]) => unknown>(),
);

vi.mock("electron", () => ({
  // Log 等 import 链加载期可能取路径/应用名（不驱动，Proxy 兜底任意方法）
  app: new Proxy(
    {
      getPath: vi.fn(() => `/tmp/tianshu-test-${process.pid}`),
      getName: vi.fn(() => "tianshu"),
    },
    { get: (target, prop) => target[prop as keyof typeof target] ?? vi.fn() },
  ),
  session: { fromPartition: vi.fn(() => partitionSession) },
  ipcMain: { handle: vi.fn() },
  webContents: { fromId: vi.fn((id: number) => guestById.get(id) ?? null) },
  shell: { openExternal: shellOpenExternal },
}));
// handleUser 直通捕获（绕开 JWT 剥壳——注册形态与真身一致，token 语义另测）
vi.mock("../../electron/commons/ipc-user", () => ({
  handleUser: (channel: string, fn: (...args: unknown[]) => unknown) => {
    handlers.set(channel, fn);
  },
}));

import {
  readDevicePresetParams,
  readExternalUrl,
  registerBrowserActionsIpc,
  resolveBrowserGuest,
  toEmulationParams,
} from "../../electron/domains/ai/browser/browser-actions-ipc";

// handler 在 beforeEach 注册（describe 体在收集期取不到），测试内经此取用
let emulate: (...args: unknown[]) => Promise<void>;
let capture: (...args: unknown[]) => Promise<void>;
let open: (...args: unknown[]) => Promise<void>;

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  guestById.clear();
  guestById.set(7, fakeWc);
  registerBrowserActionsIpc();
  emulate = handlers.get("browser:emulateDevice") as typeof emulate;
  capture = handlers.get("browser:captureScreenshot") as typeof capture;
  open = handlers.get("browser:openExternal") as typeof open;
});

describe("readExternalUrl（仅 http(s) 白名单）", () => {
  it("http/https 通过原样返回", () => {
    expect(readExternalUrl("https://example.com/a")).toBe(
      "https://example.com/a",
    );
    expect(readExternalUrl("http://example.com")).toBe("http://example.com");
  });
  it("非字符串/非法 url/危险协议拒绝", () => {
    expect(() => readExternalUrl(123)).toThrow();
    expect(() => readExternalUrl("not a url")).toThrow();
    expect(() => readExternalUrl("file:///etc/passwd")).toThrow();
    expect(() => readExternalUrl("javascript:alert(1)")).toThrow();
  });
});

describe("readDevicePresetParams / toEmulationParams", () => {
  it("null 直通（= 关闭模拟）", () => {
    expect(readDevicePresetParams(null)).toBeNull();
  });
  it("合法预设归一", () => {
    expect(
      readDevicePresetParams({
        width: 375,
        height: 667,
        deviceScaleFactor: 2,
        screenPosition: "mobile",
      }),
    ).toEqual({
      width: 375,
      height: 667,
      deviceScaleFactor: 2,
      screenPosition: "mobile",
    });
  });
  it("越界/类型不对 fail-fast", () => {
    expect(() =>
      readDevicePresetParams({ width: 10, height: 667, deviceScaleFactor: 2 }),
    ).toThrow();
    expect(() =>
      readDevicePresetParams({ width: "375", height: 667 }),
    ).toThrow();
    expect(() =>
      readDevicePresetParams({
        width: 375,
        height: 667,
        screenPosition: "tv",
      }),
    ).toThrow();
  });
  it("toEmulationParams：viewSize=screenSize，scale 按渲染层上报 avail 自算 fit", () => {
    expect(
      toEmulationParams({
        width: 768,
        height: 1024,
        deviceScaleFactor: 2,
        screenPosition: "mobile",
        availWidth: 800,
        availHeight: 600,
      }),
    ).toEqual({
      screenPosition: "mobile",
      screenSize: { width: 768, height: 1024 },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 2,
      viewSize: { width: 768, height: 1024 },
      // min(1, 800/768, 600/1024) = 0.586 → 两位 0.59
      scale: 0.59,
    });
    // avail 缺席（渲染层 rect 未就绪）→ 不缩放
    expect(
      toEmulationParams({
        width: 375,
        height: 667,
        deviceScaleFactor: 2,
        screenPosition: "mobile",
      }).scale,
    ).toBe(1);
  });
});

describe("resolveBrowserGuest（guest 反查安全口径）", () => {
  it("非法 id / 未注册 id → null", () => {
    expect(resolveBrowserGuest("7")).toBeNull();
    expect(resolveBrowserGuest(999)).toBeNull();
  });
  it("非 browser partition（session 不同实例）→ null", () => {
    guestById.set(8, { ...fakeWc, id: 8, session: {} });
    expect(resolveBrowserGuest(8)).toBeNull();
  });
  it("已销毁 → null", () => {
    fakeWc.isDestroyed.mockReturnValueOnce(true);
    expect(resolveBrowserGuest(7)).toBeNull();
  });
  it("合法 browser partition guest → WebContents", () => {
    expect(resolveBrowserGuest(7)).toBe(fakeWc);
  });
});

describe("browser:emulateDevice", () => {
  it("预设 → enableDeviceEmulation（scale 按上报 avail 自算）", async () => {
    await emulate(undefined, 1, 7, {
      width: 375,
      height: 667,
      deviceScaleFactor: 2,
      screenPosition: "mobile",
      availWidth: 800,
      availHeight: 600,
    });
    expect(fakeWc.enableDeviceEmulation).toHaveBeenCalledWith({
      screenPosition: "mobile",
      screenSize: { width: 375, height: 667 },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 2,
      viewSize: { width: 375, height: 667 },
      // min(1, 800/375, 600/667) = 0.9
      scale: 0.9,
    });
  });
  it("null → disableDeviceEmulation", async () => {
    await emulate(undefined, 1, 7, null);
    expect(fakeWc.disableDeviceEmulation).toHaveBeenCalled();
  });
  it("非法预设 → 拒绝且不触碰 wc", async () => {
    await expect(
      emulate(undefined, 1, 7, { width: 1, height: 2 }),
    ).rejects.toThrow();
    expect(fakeWc.enableDeviceEmulation).not.toHaveBeenCalled();
  });
  it("未知 guest 拒绝", async () => {
    await expect(emulate(undefined, 1, 999, null)).rejects.toThrow();
    expect(fakeWc.disableDeviceEmulation).not.toHaveBeenCalled();
  });
});

describe("browser:captureScreenshot", () => {
  it("capturePage → 返回 PNG dataURL（剪贴板写入在渲染层）", async () => {
    const out = await capture(undefined, 1, 7);
    expect(out).toBe("data:image/png;base64,QUJD");
  });
  it("未知 guest 拒绝", async () => {
    await expect(capture(undefined, 1, 999)).rejects.toThrow();
  });
});

describe("browser:openExternal", () => {
  it("http(s) url 交 shell.openExternal", async () => {
    await open(undefined, 1, "https://example.com/page");
    expect(shellOpenExternal).toHaveBeenCalledWith("https://example.com/page");
  });
  it("file:// 拒绝且不外开", async () => {
    await expect(open(undefined, 1, "file:///etc/passwd")).rejects.toThrow();
    expect(shellOpenExternal).not.toHaveBeenCalledWith("file:///etc/passwd");
  });
});
