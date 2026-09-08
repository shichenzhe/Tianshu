// @vitest-environment jsdom
/**
 * SettingsDialog 组件测试（jsdom + testing-library）：
 * - 打开面板：渲染标题与四个分组标题（常规/权限/存储/通知）
 * - 导航占位：个人主页/外观/快捷键 disabled，通用可交互
 * - 常规组-语言：下拉选择调用 i18n.changeLanguage；字体：滑条/刻度即时生效
 * - 权限组：初始值一次性载入、开关即时保存与失败回滚、代理三态切换与
 *   自定义表单显隐/校验/保存参数
 * - 存储组：storageInfo Loading→渲染、打开目录、工作空间路径更改（含取消）
 * - 通知组：桌面通知授权态分支（去授权跳系统设置/测试通知）、
 *   客户端通知开关保存、提示音切换持久化 + beep 试听
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import SettingsDialog from "../../src-react/domains/app-settings/components/SettingsDialog";
import type { StorageInfo } from "../../src-react/domains/app-settings/api/settings.api";

// localStorage stub：与 tests/ai/chat-view-edit-optimistic.test.tsx 同款内存
// stub（常规组字体档位读写 localStorage）
vi.hoisted(() => {
  const memory = new Map<string, string>();
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
});

// i18n mock：与 tests/ai/edit-bar.test.tsx 同套——t 直接返回 key（断言不依赖
// 具体文案）；语言切换经 changeLanguage spy 断言，language 固定 zh-CN
const changeLanguage = vi.hoisted(() => vi.fn());
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
      i18n: { language: "zh-CN", changeLanguage },
    }),
  };
});

// IPC mock：三组挂载即调 getAll 等通道，按通道分发表桩返回
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({
  invoke: async (channel: string, ...args: unknown[]) =>
    invokeMock(channel, ...args),
}));

// toast mock：断言失败兜底提示
const toastMock = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

// Notification stub：permission 可变（授权分支），构造调用被记录（测试通知）
const notificationState = vi.hoisted(() => ({
  permission: "denied" as NotificationPermission,
  calls: [] as Array<{ title: string; body?: string }>,
}));
class NotificationStub {
  static get permission() {
    return notificationState.permission;
  }
  constructor(title: string, options?: { body?: string }) {
    notificationState.calls.push({ title, body: options?.body });
  }
}

/** 各通道默认桩返回（未覆盖通道 → undefined） */
const DEFAULT_STORAGE_INFO: StorageInfo = {
  userDataPath: "/userData",
  cacheBytes: 0,
  diskTotal: 0,
  diskFree: 0,
};
const DEFAULT_CHANNEL_RESULTS: Record<string, () => unknown> = {
  "settings:getAll": () => [],
  "settings:getAutoLaunch": () => false,
  "settings:getKeepAwake": () => false,
  "settings:storageInfo": () => DEFAULT_STORAGE_INFO,
  "settings:pickDirectory": () => null,
};

/** 按通道桩 IPC（handler 抛错/返回 rejected Promise 即为失败场景） */
function stubInvoke(handlers: Record<string, () => unknown> = {}) {
  invokeMock.mockImplementation((channel: string) => {
    const handler = handlers[channel] ?? DEFAULT_CHANNEL_RESULTS[channel];
    return Promise.resolve(handler === undefined ? undefined : handler());
  });
}

/** 渲染打开态设置面板，并冲刷挂载期异步载入（避免 act 外更新） */
async function renderDialog() {
  render(<SettingsDialog open onOpenChange={vi.fn()} />);
  await act(async () => {});
}

/** 按可访问名称取开关（Switch 的 aria-label 为行标题 key） */
function getSwitch(name: string) {
  return screen.getByRole("switch", { name });
}

/** 桩 navigator.userAgent（通知设置跳转地址按平台分支；jsdom 原值两不沾） */
function stubUserAgent(value: string) {
  const original = window.navigator.userAgent;
  Object.defineProperty(window.navigator, "userAgent", {
    value,
    configurable: true,
  });
  return () =>
    Object.defineProperty(window.navigator, "userAgent", {
      value: original,
      configurable: true,
    });
}

// vitest 未开 globals，RTL 自动清理不生效，显式清理
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  notificationState.permission = "denied";
  notificationState.calls.length = 0;
});

beforeEach(() => {
  changeLanguage.mockClear();
  localStorage.clear();
  document.documentElement.style.fontSize = "";
  toastMock.error.mockClear();
  invokeMock.mockClear();
  stubInvoke();
});

describe("SettingsDialog 骨架", () => {
  it("打开面板：渲染标题与四分组标题", async () => {
    await renderDialog();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("settings:title")).toBeTruthy();
    expect(screen.getByText("settings:groups.general")).toBeTruthy();
    expect(screen.getByText("settings:groups.permission")).toBeTruthy();
    expect(screen.getByText("settings:groups.storage")).toBeTruthy();
    expect(screen.getByText("settings:groups.notification")).toBeTruthy();
  });

  it("导航占位：个人主页/外观/快捷键禁用，通用可交互", async () => {
    await renderDialog();
    const general = screen.getByRole("button", {
      name: "settings:nav.general",
    }) as HTMLButtonElement;
    expect(general.disabled).toBe(false);
    for (const id of ["profile", "appearance", "shortcuts"]) {
      const item = screen.getByRole("button", {
        name: new RegExp(`settings:nav.${id}`),
      }) as HTMLButtonElement;
      expect(item.disabled).toBe(true);
      expect(item.title).toBe("settings:nav.comingSoon");
    }
  });

  it("常规组-语言：下拉选择调用 i18n.changeLanguage", async () => {
    await renderDialog();
    // 当前语言 zh-CN，触发器即以其标签命名；pointerDown 展开菜单
    const trigger = screen.getByRole("button", {
      name: "settings:general.zhCN",
    });
    fireEvent.pointerDown(trigger);
    fireEvent.click(screen.getByText("settings:general.enUS"));
    expect(changeLanguage).toHaveBeenCalledTimes(1);
    expect(changeLanguage).toHaveBeenCalledWith("en-US");
  });

  it("常规组-字体：滑条三档即时生效并持久化", async () => {
    await renderDialog();
    const slider = screen.getByRole("slider", {
      name: "settings:general.fontSize",
    }) as HTMLInputElement;
    expect(slider.value).toBe("1"); // 缺省 default（下标 1）

    fireEvent.change(slider, { target: { value: "2" } });
    expect(document.documentElement.style.fontSize).toBe("18px");
    expect(localStorage.getItem("tianshu-font-scale")).toBe("large");

    fireEvent.change(slider, { target: { value: "0" } });
    expect(document.documentElement.style.fontSize).toBe("14px");
    expect(localStorage.getItem("tianshu-font-scale")).toBe("small");
  });

  it("常规组-字体：刻度点击直达对应档位", async () => {
    await renderDialog();
    fireEvent.click(
      screen.getByRole("button", { name: "settings:general.fontLarge" }),
    );
    expect(document.documentElement.style.fontSize).toBe("18px");
    expect(localStorage.getItem("tianshu-font-scale")).toBe("large");
  });
});

describe("SettingsDialog 权限组", () => {
  it("初始值一次性载入：系统态开关 + option 键（含代理持久化值）", async () => {
    stubInvoke({
      "settings:getAll": () => [
        { name: "autoInstallTrustedSkills", value: "true" },
        { name: "proxyMode", value: "proxy" },
        { name: "proxyHost", value: "127.0.0.1" },
        { name: "proxyPort", value: "7890" },
      ],
      "settings:getAutoLaunch": () => true,
      "settings:getKeepAwake": () => false,
    });
    await renderDialog();
    await waitFor(() =>
      expect(
        getSwitch("settings:permission.autoInstallTrustedSkills").getAttribute(
          "aria-checked",
        ),
      ).toBe("true"),
    );
    expect(
      getSwitch("settings:permission.autoLaunch").getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      getSwitch("settings:permission.keepAwake").getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      getSwitch("settings:permission.autoUpdateSkills").getAttribute(
        "aria-checked",
      ),
    ).toBe("false");
    // 代理模式为自定义：表单展开并带出持久化 host/port
    expect(
      (
        screen.getByRole("textbox", {
          name: "settings:permission.proxyHost",
        }) as HTMLInputElement
      ).value,
    ).toBe("127.0.0.1");
    expect(
      (
        screen.getByRole("textbox", {
          name: "settings:permission.proxyPort",
        }) as HTMLInputElement
      ).value,
    ).toBe("7890");
  });

  it("开关即时保存并调用对应通道", async () => {
    stubInvoke({ "settings:getAutoLaunch": () => true });
    await renderDialog();
    // 等系统态载入完成再交互，避免与初始载入竞态
    await waitFor(() =>
      expect(
        getSwitch("settings:permission.autoLaunch").getAttribute(
          "aria-checked",
        ),
      ).toBe("true"),
    );

    fireEvent.click(getSwitch("settings:permission.keepAwake"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("settings:setKeepAwake", true),
    );
    expect(
      getSwitch("settings:permission.keepAwake").getAttribute("aria-checked"),
    ).toBe("true");

    fireEvent.click(getSwitch("settings:permission.autoUpdateSkills"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "settings:set",
        "autoUpdateSkills",
        "true",
      ),
    );
  });

  it("保存失败回滚开关并 toast 提示", async () => {
    stubInvoke({ "settings:getAutoLaunch": () => true });
    await renderDialog();
    await waitFor(() =>
      expect(
        getSwitch("settings:permission.autoLaunch").getAttribute(
          "aria-checked",
        ),
      ).toBe("true"),
    );
    stubInvoke({
      "settings:getAutoLaunch": () => true,
      "settings:setAutoLaunch": () =>
        Promise.reject(new Error("setLoginItemSettings failed")),
    });

    fireEvent.click(getSwitch("settings:permission.autoLaunch"));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("settings:error.saveFailed"),
    );
    expect(
      getSwitch("settings:permission.autoLaunch").getAttribute("aria-checked"),
    ).toBe("true"); // 回滚为保存前状态
  });

  it("代理切换直连：立即调 setProxy 且触发器跟随", async () => {
    stubInvoke({ "settings:getAutoLaunch": () => true });
    await renderDialog();
    await waitFor(() =>
      expect(
        getSwitch("settings:permission.autoLaunch").getAttribute(
          "aria-checked",
        ),
      ).toBe("true"),
    );

    const trigger = screen.getByRole("button", {
      name: "settings:permission.proxySystem",
    });
    fireEvent.pointerDown(trigger);
    fireEvent.click(screen.getByText("settings:permission.proxyDirect"));
    // SettingsApi.setProxy 定参透传 host/port（此模式为 undefined）
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "settings:setProxy",
        "direct",
        undefined,
        undefined,
      ),
    );
    expect(
      screen.getByRole("button", { name: "settings:permission.proxyDirect" }),
    ).toBeTruthy();
    // 非自定义模式不渲染 host/port 表单
    expect(
      screen.queryByRole("textbox", {
        name: "settings:permission.proxyHost",
      }),
    ).toBeNull();
  });

  it("自定义代理：表单展开带出持久化值，校验失败禁用保存", async () => {
    stubInvoke({
      "settings:getAll": () => [
        { name: "proxyMode", value: "direct" },
        { name: "proxyHost", value: "10.0.0.1" },
        { name: "proxyPort", value: "8080" },
      ],
    });
    await renderDialog();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "settings:permission.proxyDirect" }),
      ).toBeTruthy(),
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "settings:permission.proxyDirect" }),
    );
    fireEvent.click(screen.getByText("settings:permission.proxyCustom"));
    const host = screen.getByRole("textbox", {
      name: "settings:permission.proxyHost",
    }) as HTMLInputElement;
    const port = screen.getByRole("textbox", {
      name: "settings:permission.proxyPort",
    }) as HTMLInputElement;
    const save = screen.getByRole("button", {
      name: "common:save",
    }) as HTMLButtonElement;
    expect(host.value).toBe("10.0.0.1");
    expect(port.value).toBe("8080");

    fireEvent.change(host, { target: { value: "" } }); // host 空 → 禁用
    expect(save.disabled).toBe(true);
    fireEvent.change(host, { target: { value: "127.0.0.1" } });
    fireEvent.change(port, { target: { value: "abc" } }); // 端口非数字 → 禁用
    expect(save.disabled).toBe(true);
    fireEvent.change(port, { target: { value: "7890" } });
    expect(save.disabled).toBe(false);

    fireEvent.click(save);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "settings:setProxy",
        "proxy",
        "127.0.0.1",
        7890,
      ),
    );
  });
});

describe("SettingsDialog 存储组", () => {
  it("存储信息：Loading 态 → 路径/三段图例渲染", async () => {
    let resolveStorage!: (value: StorageInfo) => void;
    stubInvoke({
      "settings:storageInfo": () =>
        new Promise<StorageInfo>((resolve) => {
          resolveStorage = resolve;
        }),
      "settings:getAll": () => [{ name: "workspacePath", value: "/old/ws" }],
    });
    render(<SettingsDialog open onOpenChange={vi.fn()} />);
    expect(screen.getByText("common:loading")).toBeTruthy();
    expect(screen.queryByText("/old/ws")).toBeNull();

    const GB = 1024 ** 3;
    await act(async () => {
      resolveStorage({
        userDataPath: "/Users/dev/Library/Application Support/tianshu",
        cacheBytes: GB,
        diskTotal: 100 * GB,
        diskFree: 20 * GB,
      });
    });
    expect(
      screen.getByText("/Users/dev/Library/Application Support/tianshu"),
    ).toBeTruthy();
    expect(screen.getByText("/old/ws")).toBeTruthy();
    // 图例数值：缓存 1.0 GB / 其他占用 79 GB（已用 80 - 缓存 1）/ 可用 20 GB
    expect(screen.getByText(/cacheLegend · 1\.0 GB/)).toBeTruthy();
    expect(screen.getByText(/otherLegend · 79 GB/)).toBeTruthy();
    expect(screen.getByText(/freeLegend · 20 GB/)).toBeTruthy();
    expect(screen.getByText("settings:storage.diskCaption")).toBeTruthy();
  });

  it("打开目录与更改工作空间路径（确认选择后持久化并更新展示）", async () => {
    stubInvoke({
      "settings:getAll": () => [{ name: "workspacePath", value: "/old/ws" }],
      "settings:pickDirectory": () => "/new/ws",
    });
    await renderDialog();
    await waitFor(() => expect(screen.getByText("/old/ws")).toBeTruthy());

    fireEvent.click(
      screen.getByRole("button", { name: "settings:storage.openDirectory" }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "settings:openDirectory",
        "/userData",
      ),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "settings:storage.change" }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "settings:set",
        "workspacePath",
        "/new/ws",
      ),
    );
    expect(screen.getByText("/new/ws")).toBeTruthy();
    expect(screen.queryByText("/old/ws")).toBeNull();
  });

  it("更改工作空间取消选择（返回 null）不写入", async () => {
    stubInvoke({
      "settings:getAll": () => [{ name: "workspacePath", value: "/old/ws" }],
      "settings:pickDirectory": () => null,
    });
    await renderDialog();
    await waitFor(() => expect(screen.getByText("/old/ws")).toBeTruthy());

    fireEvent.click(
      screen.getByRole("button", { name: "settings:storage.change" }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("settings:pickDirectory"),
    );
    expect(
      invokeMock.mock.calls.filter(([channel]) => channel === "settings:set"),
    ).toHaveLength(0);
    expect(screen.getByText("/old/ws")).toBeTruthy();
  });
});

describe("SettingsDialog 通知组", () => {
  it("桌面通知未授权：展示去授权按钮，点击经 openExternal 桥跳系统设置", async () => {
    vi.stubGlobal("Notification", NotificationStub);
    notificationState.permission = "denied";
    const restoreUserAgent = stubUserAgent("Macintosh");
    await renderDialog();

    expect(
      screen.queryByRole("button", {
        name: "settings:notification.testNotification",
      }),
    ).toBeNull();
    expect(screen.getByText("settings:notification.notGranted")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "settings:notification.authorize" }),
    );
    // window.open 对自定义 scheme 报 ERR_UNKNOWN_URL_SCHEME，须经主进程白名单桥
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "settings:openExternal",
        "x-apple.systempreferences:com.apple.preference.notifications",
      ),
    );
    restoreUserAgent();
  });

  it("去授权跳转失败：toast 提示", async () => {
    vi.stubGlobal("Notification", NotificationStub);
    notificationState.permission = "denied";
    const restoreUserAgent = stubUserAgent("Macintosh");
    stubInvoke({
      "settings:openExternal": () =>
        Promise.reject(new Error("OPEN_EXTERNAL_FORBIDDEN")),
    });
    await renderDialog();

    fireEvent.click(
      screen.getByRole("button", { name: "settings:notification.authorize" }),
    );
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "settings:error.openExternalFailed",
      ),
    );
    restoreUserAgent();
  });

  it("桌面通知已授权：测试通知发送标题与正文", async () => {
    vi.stubGlobal("Notification", NotificationStub);
    notificationState.permission = "granted";
    await renderDialog();
    expect(screen.getByText("settings:notification.granted")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "settings:notification.testNotification",
      }),
    );
    expect(notificationState.calls).toEqual([
      { title: "common:appName", body: "settings:notification.testBody" },
    ]);
  });

  it("Windows 去授权：经白名单桥跳 ms-settings 通知页（URI 无尾冒号）", async () => {
    vi.stubGlobal("Notification", NotificationStub);
    notificationState.permission = "denied";
    const restoreUserAgent = stubUserAgent("Windows");
    try {
      await renderDialog();

      fireEvent.click(
        screen.getByRole("button", {
          name: "settings:notification.authorize",
        }),
      );
      await waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith(
          "settings:openExternal",
          "ms-settings:notifications",
        ),
      );
    } finally {
      restoreUserAgent();
    }
  });

  it("客户端通知开关保存 + 提示音切换持久化并 beep 试听", async () => {
    stubInvoke({
      "settings:getAll": () => [
        { name: "clientNotification", value: "true" },
        { name: "sound", value: "none" },
      ],
    });
    await renderDialog();
    await waitFor(() =>
      expect(
        getSwitch("settings:notification.client").getAttribute("aria-checked"),
      ).toBe("true"),
    );

    fireEvent.click(getSwitch("settings:notification.client"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "settings:set",
        "clientNotification",
        "false",
      ),
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "settings:notification.soundNone" }),
    );
    fireEvent.click(screen.getByText("settings:notification.soundDefault"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "settings:set",
        "sound",
        "default",
      ),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("settings:beep"),
    );
    expect(
      screen.getByRole("button", {
        name: "settings:notification.soundDefault",
      }),
    ).toBeTruthy();
  });
});
