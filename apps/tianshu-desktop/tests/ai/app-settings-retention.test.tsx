// @vitest-environment jsdom
/**
 * 设置面板「执行历史保留」分节测试（Task 4）：
 * 渲染冒烟（StorageGroup 新分节，mock @/lib/ipc invoke 按 channel 分发
 * fixture，骨架照 tests/project/config-panel-automation.test.tsx——t 返回
 * key、sonner 桩、Radix jsdom 三桩）+ 后端通道（SettingsService 照
 * tests/ai/settings.service.test.ts 的 electron/undici/Log/prisma mock
 * 三件套与 ipcMain.handle 捕获直调）：
 * - 渲染：分节出现（标题/说明/开关/两个天数输入框，控件挂 aria-label）
 * - 回显：getRunRetention 返回 enabled:false → 开关为关（非缺省 true）
 * - 启停：点开关 → setRunRetention({enabled:true}) 单字段 patch + 乐观
 *   回显 + toast；写失败 → 回滚开关 + error toast（乐观更新不残留）
 * - 天数：改值即存单字段；清空（解析为 0）不发
 * - 后端：get/set 双通道注册（照 webhookPort 先例）；get 无行回默认；
 *   set 部分提交合并当前值、undefined 键不覆盖（controller ruling 1）
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

// —— 后端 mock 三件套（照 tests/ai/settings.service.test.ts）——
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    getPath: vi.fn(() => `/tmp/tianshu-retention-test-userdata-${process.pid}`),
    getLoginItemSettings: vi.fn(),
    setLoginItemSettings: vi.fn(),
    on: vi.fn(),
  },
  powerSaveBlocker: {
    start: vi.fn(),
    stop: vi.fn(),
    isStarted: vi.fn(() => false),
  },
  shell: { beep: vi.fn(), openPath: vi.fn(), openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  session: { defaultSession: { setProxy: vi.fn(async () => undefined) } },
  Notification: Object.assign(
    // 普通函数（非箭头）才能被 new 调用
    vi.fn(function () {
      return { show: vi.fn() };
    }),
    { isSupported: vi.fn(() => true) },
  ),
}));

vi.mock("undici", () => ({
  Agent: vi.fn(),
  EnvHttpProxyAgent: vi.fn(),
  ProxyAgent: vi.fn(),
  setGlobalDispatcher: vi.fn(),
  // proxy-dispatcher 静态引入 network-gate 需该基类（本测试不触达）
  Dispatcher: class {},
}));

vi.mock("../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** prisma.option 内存实现（optionRows 直读直写，断言落库 JSON） */
const optionRows = new Map<string, string>();
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    option: {
      findMany: async (args: { where: { name?: { in: string[] } } }) => {
        const names = args.where.name?.in;
        return [...optionRows]
          .filter(([name]) => !names || names.includes(name))
          .map(([name, value]) => ({ name, value }));
      },
      updateMany: async (args: {
        where: { name: string };
        data: { value: string };
      }) => {
        if (!optionRows.has(args.where.name)) {
          return { count: 0 };
        }
        optionRows.set(args.where.name, args.data.value);
        return { count: 1 };
      },
      create: async (args: { data: { name: string; value: string } }) => {
        optionRows.set(args.data.name, args.data.value);
        return {};
      },
    },
  },
}));

// —— 渲染冒烟 mock：@/lib/ipc 按通道分发 fixture；sonner；i18n ——
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({
  invoke: invokeMock,
  send: vi.fn(),
  on: vi.fn(() => () => {}),
  once: vi.fn(),
  removeAllListeners: vi.fn(),
}));

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    // key 直返（无插值消费点，无需变量拼接后缀）
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

import { ipcMain } from "electron";
import SettingsService from "../../electron/domains/app-settings/settings.service";
import { DEFAULT_RUN_RETENTION } from "../../electron/domains/ai/automation/automation-retention";
import StorageGroup from "../../src-react/domains/app-settings/components/StorageGroup";

/** retention 夹具：关 + 缺省天数档（断言后端值回显非前端缺省 true） */
const RETENTION = {
  enabled: false,
  traceDays: 3,
  successDays: 7,
  successKeep: 200,
  failureDays: 30,
  failureKeep: 500,
};

/** invoke 按通道分发（存储面板初始三拉 + retention 读写） */
function stubInvoke(overrides: Record<string, unknown> = {}) {
  const channels: Record<string, unknown> = {
    "settings:storageInfo": {
      userDataPath: "/data/root",
      cacheBytes: 1024,
      diskTotal: 4096,
      diskFree: 2048,
    },
    "settings:getAll": [],
    "settings:getDataRoot": {
      current: "/data/root",
      defaultRoot: "/data/root",
      isCustom: false,
    },
    "settings:getRunRetention": RETENTION,
    "settings:setRunRetention": undefined,
    ...overrides,
  };
  invokeMock.mockImplementation((channel: string) =>
    Promise.resolve(
      // 函数值惰性求值：拒绝场景在消费时才建 rejected promise——预建会留
      // unhandled 窗口（点击前若干 tick），vitest 捕获 unhandledRejection 即红
      typeof channels[channel] === "function"
        ? (channels[channel] as () => unknown)()
        : channels[channel],
    ),
  );
}

/** setRunRetention 通道的调用序列（滤掉初始拉取等其他通道） */
const retentionSaveCalls = () =>
  invokeMock.mock.calls.filter(
    (args) => args[0] === "settings:setRunRetention",
  );

// Radix jsdom 桩（照 config-panel-automation.test.tsx）
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.hasPointerCapture = () => false;
  window.HTMLElement.prototype.releasePointerCapture = () => {};
});

/** ipcMain.handle 捕获的通道 → handler（后端直调断言用） */
const handlers = new Map<string, (...args: unknown[]) => unknown>();

beforeEach(() => {
  vi.clearAllMocks();
  optionRows.clear();
  handlers.clear();
  vi.mocked(ipcMain.handle).mockImplementation(((
    channel: string,
    handler: (...args: unknown[]) => unknown,
  ) => {
    handlers.set(channel, handler);
  }) as never);
});

afterEach(cleanup);

describe("StorageGroup 执行历史保留分节（渲染冒烟）", () => {
  beforeEach(() => {
    stubInvoke();
  });

  it("分节渲染：标题/说明/开关/两个天数输入框，且经 getRunRetention 拉取", async () => {
    render(<StorageGroup />);

    expect(
      await screen.findByText("settings:executionHistory.title"),
    ).toBeTruthy();
    expect(screen.getByText("settings:executionHistory.desc")).toBeTruthy();
    expect(
      screen.getByRole("switch", {
        name: "settings:executionHistory.enabledLabel",
      }),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("settings:executionHistory.successDaysLabel"),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("settings:executionHistory.failureDaysLabel"),
    ).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith("settings:getRunRetention");
  });

  it("回显：后端 enabled:false → 开关为关（非缺省 true）；天数回显配置值", async () => {
    render(<StorageGroup />);
    const toggle = await screen.findByRole("switch", {
      name: "settings:executionHistory.enabledLabel",
    });

    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(
      (
        screen.getByLabelText(
          "settings:executionHistory.successDaysLabel",
        ) as HTMLInputElement
      ).value,
    ).toBe("7");
    expect(
      (
        screen.getByLabelText(
          "settings:executionHistory.failureDaysLabel",
        ) as HTMLInputElement
      ).value,
    ).toBe("30");
  });

  it("启停：点开关 → setRunRetention({enabled:true}) 单字段 patch + 乐观回显 + toast", async () => {
    render(<StorageGroup />);
    const toggle = await screen.findByRole("switch", {
      name: "settings:executionHistory.enabledLabel",
    });

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(retentionSaveCalls()).toEqual([
        ["settings:setRunRetention", { enabled: true }],
      ]),
    );
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toastMock.success).toHaveBeenCalledWith(
      "settings:executionHistory.saved",
    );
  });

  it("保存失败：回滚开关状态并提示（乐观更新不残留）", async () => {
    stubInvoke({
      "settings:setRunRetention": () =>
        Promise.reject(new Error("SAVE_FAILED")),
    });
    render(<StorageGroup />);
    const toggle = await screen.findByRole("switch", {
      name: "settings:executionHistory.enabledLabel",
    });

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("settings:error.saveFailed"),
    );
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("天数输入：改值即存单字段；清空（解析为 0）不发", async () => {
    render(<StorageGroup />);
    const days = (await screen.findByLabelText(
      "settings:executionHistory.successDaysLabel",
    )) as HTMLInputElement;

    fireEvent.change(days, { target: { value: "14" } });
    await waitFor(() =>
      expect(retentionSaveCalls()).toEqual([
        ["settings:setRunRetention", { successDays: 14 }],
      ]),
    );

    fireEvent.change(days, { target: { value: "" } });
    expect(retentionSaveCalls()).toHaveLength(1);
  });
});

describe("后端通道（SettingsService 注册与合并语义）", () => {
  it("getRunRetention/setRunRetention 已注册（照 webhookPort 通道先例）", () => {
    new SettingsService();
    expect(handlers.has("settings:getRunRetention")).toBe(true);
    expect(handlers.has("settings:setRunRetention")).toBe(true);
  });

  it("get 无 option 行 → 回 Task 1 默认配置", async () => {
    new SettingsService();
    await expect(handlers.get("settings:getRunRetention")!()).resolves.toEqual(
      DEFAULT_RUN_RETENTION,
    );
  });

  it("set 部分提交仅 successDays → 其余字段保留默认（undefined 键不覆盖）", async () => {
    new SettingsService();
    await handlers.get("settings:setRunRetention")!({}, { successDays: 14 });

    expect(JSON.parse(optionRows.get("automation.runRetention")!)).toEqual({
      ...DEFAULT_RUN_RETENTION,
      successDays: 14,
    });
  });

  it("set 合并当前值而非默认值（已有行 patch 只动提交字段）", async () => {
    optionRows.set(
      "automation.runRetention",
      JSON.stringify({
        ...DEFAULT_RUN_RETENTION,
        enabled: false,
        failureDays: 90,
      }),
    );
    new SettingsService();
    await handlers.get("settings:setRunRetention")!({}, { successDays: 3 });

    expect(JSON.parse(optionRows.get("automation.runRetention")!)).toEqual({
      ...DEFAULT_RUN_RETENTION,
      enabled: false,
      failureDays: 90,
      successDays: 3,
    });
  });
});
