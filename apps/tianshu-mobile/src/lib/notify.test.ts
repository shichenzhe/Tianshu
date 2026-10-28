import { beforeEach, describe, expect, it, vi } from "vitest";

// —— react-native 替身：AppState.currentState / Platform.OS 运行时可换 ——
const appStateMock = vi.hoisted(() => ({ currentState: "active" as string }));
const platformMock = vi.hoisted(() => ({ OS: "ios" as string }));

vi.mock("react-native", () => ({
  AppState: appStateMock,
  Platform: platformMock,
}));

// —— expo-notifications 替身（node vitest 无原生模块） ——
const notifMock = vi.hoisted(() => ({
  scheduleNotificationAsync: vi.fn(() => Promise.resolve("id")),
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  setNotificationChannelAsync: vi.fn(() => Promise.resolve(null)),
  AndroidImportance: { DEFAULT: 3, HIGH: 4 },
}));

vi.mock("expo-notifications", () => notifMock);

import { notifyLocal, requestNotificationPermission } from "./notify";

describe("notifyLocal（后台才发 + 平台守卫 + 静默失败）", () => {
  beforeEach(() => {
    notifMock.scheduleNotificationAsync.mockClear();
    platformMock.OS = "ios";
    appStateMock.currentState = "active";
  });

  it("前台 active 不发；iOS inactive（遮盖态非后台）不发；后台立即调度（trigger null）", async () => {
    notifyLocal({ title: "t", body: "b" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notifMock.scheduleNotificationAsync).not.toHaveBeenCalled();

    appStateMock.currentState = "inactive";
    notifyLocal({ title: "t", body: "b" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notifMock.scheduleNotificationAsync).not.toHaveBeenCalled();

    appStateMock.currentState = "background";
    notifyLocal({ title: "审批请求", body: "run_command" });
    // 动态 import + ensureChannel 异步链：宏任务一轮清空全部微任务
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notifMock.scheduleNotificationAsync).toHaveBeenCalledWith({
      content: { title: "审批请求", body: "run_command" },
      trigger: null,
    });
  });

  it("web 平台直接短路（AppState 态无关）", () => {
    platformMock.OS = "web";
    appStateMock.currentState = "background";
    notifyLocal({ title: "t", body: "b" });
    expect(notifMock.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it("调度抛错（同步/异步）静默不外抛", () => {
    appStateMock.currentState = "background";
    notifMock.scheduleNotificationAsync.mockImplementationOnce(() => {
      throw new Error("sync boom");
    });
    expect(() => notifyLocal({ title: "t", body: "b" })).not.toThrow();

    notifMock.scheduleNotificationAsync.mockImplementationOnce(() =>
      Promise.reject(new Error("async boom")),
    );
    expect(() => notifyLocal({ title: "t", body: "b" })).not.toThrow();
  });
});

describe("requestNotificationPermission", () => {
  beforeEach(() => {
    notifMock.getPermissionsAsync.mockReset();
    notifMock.requestPermissionsAsync.mockReset();
    platformMock.OS = "ios";
  });

  it("web 恒 false；已授权免弹窗直接 true；未授权走请求", async () => {
    platformMock.OS = "web";
    expect(await requestNotificationPermission()).toBe(false);
    platformMock.OS = "ios"; // 回 native 再走权限分支

    notifMock.getPermissionsAsync.mockResolvedValue({ granted: true });
    expect(await requestNotificationPermission()).toBe(true);
    expect(notifMock.requestPermissionsAsync).not.toHaveBeenCalled();

    notifMock.getPermissionsAsync.mockResolvedValue({ granted: false });
    notifMock.requestPermissionsAsync.mockResolvedValue({ granted: true });
    expect(await requestNotificationPermission()).toBe(true);

    notifMock.requestPermissionsAsync.mockResolvedValue({ granted: false });
    expect(await requestNotificationPermission()).toBe(false);
  });
});

describe("Android 通知渠道注册（首发通知时延迟注册——真机修复：import 期零原生调用）", () => {
  it("OS=android 首次 notifyLocal（后台态）注册 default 渠道一次；模块加载不注册；ios 不注册", async () => {
    notifMock.setNotificationChannelAsync.mockClear();
    platformMock.OS = "android";
    vi.resetModules();
    const notify = await import("./notify");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // 模块加载零原生调用（Expo Go 原生面不全时 import 链不炸）
    expect(notifMock.setNotificationChannelAsync).not.toHaveBeenCalled();

    // AppState 后台态下首发触发注册（幂等：两次只注册一次）
    appStateMock.currentState = "background";
    notify.notifyLocal({ title: "t", body: "b" });
    notify.notifyLocal({ title: "t2", body: "b2" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(notifMock.setNotificationChannelAsync).toHaveBeenCalledTimes(1);
    expect(notifMock.setNotificationChannelAsync).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({ name: "default", importance: 4 }),
    );

    notifMock.setNotificationChannelAsync.mockClear();
    platformMock.OS = "ios";
    vi.resetModules();
    await import("./notify");
    await new Promise((resolve) => setImmediate(resolve));
    expect(notifMock.setNotificationChannelAsync).not.toHaveBeenCalled();
  });
});
