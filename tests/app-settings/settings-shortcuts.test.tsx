// @vitest-environment jsdom
/**
 * 设置面板-快捷键页组件测试（jsdom + testing-library，mock 模式与
 * settings-dialog.test.tsx 同套）：
 * - 导航切换：右栏整页切换为快捷键页（三列表头 + 17 行），可切回通用页
 * - 默认绑定展示：linux（jsdom 默认平台）Ctrl 胶囊、toggleFullscreen 的
 *   F11 平台等价键特判、固定项不可编辑；darwin（UA 桩）⇧ 前置符号序
 * - 搜索：命令列大小写不敏感过滤 / 无结果占位 / × 与 Esc 清空（不关面板）
 * - 监听编辑：点击胶囊捕获 keydown（有效保存 / Esc 退出 / 纯修饰键等待 /
 *   无效组合 toast 保持监听 / darwin 系统级组合警告但保存）
 * - 冲突弹窗：取消不写入；替换（默认占用方写 unbound 哨兵、用户覆盖
 *   占用方清除覆盖回默认）；固定绑定占用仅 toast 不弹窗
 * - 删除：确认写 unbound 哨兵 → 行显示未绑定 +「设置」按钮
 * - 全部恢复默认：二次确认后清空存储并刷新列表（含解除 unbound）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

import SettingsDialog from "../../src-react/domains/app-settings/components/SettingsDialog";
import type { StorageInfo } from "../../src-react/domains/app-settings/api/settings.api";

// localStorage stub：与 tests/app-settings/settings-dialog.test.tsx 同款内存
// stub（快捷键覆盖读写 tianshu-keybindings 需要它）
vi.hoisted(() => {
  const memory = new Map<string, string>();
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
    clear: () => memory.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
});

// i18n mock：t 直接返回 key（插值参数被忽略），断言不依赖具体文案
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

// IPC mock：通用页分组挂载即调 getAll 等通道，按通道分发表桩返回
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({
  invoke: async (channel: string, ...args: unknown[]) =>
    invokeMock(channel, ...args),
}));

// toast mock：invalidBinding/conflictFixed 走 error，系统级组合走 warning
const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

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

/** 按通道桩 IPC */
function stubInvoke(handlers: Record<string, () => unknown> = {}) {
  invokeMock.mockImplementation((channel: string) => {
    const handler = handlers[channel] ?? DEFAULT_CHANNEL_RESULTS[channel];
    return Promise.resolve(handler === undefined ? undefined : handler());
  });
}

/** 渲染打开态设置面板，并冲刷挂载期异步载入（避免 act 外更新）；返回关闭回调桩 */
async function renderDialog() {
  const onOpenChange = vi.fn();
  render(<SettingsDialog open onOpenChange={onOpenChange} />);
  await act(async () => {});
  return onOpenChange;
}

/** 打开设置面板并切换左导航到快捷键页（返回关闭回调桩） */
async function renderShortcutsPage() {
  const onOpenChange = await renderDialog();
  fireEvent.click(
    screen.getByRole("button", { name: "settings:nav.shortcuts" }),
  );
  await act(async () => {});
  return onOpenChange;
}

/** 取指定命令的表格行（命令名单元格文本即 i18n key） */
function shortcutRow(commandId: string) {
  return screen
    .getByText(`settings:shortcut.commands.${commandId}`)
    .closest("tr") as HTMLElement;
}

/** 行内绑定胶囊编辑按钮（可自定义且已绑定的行才有） */
function bindingButton(commandId: string) {
  return within(shortcutRow(commandId)).getByRole("button", {
    name: "settings:shortcut.editHint",
  });
}

/** 读取快捷键覆盖存储 */
function storedOverrides(): Record<string, string> {
  return JSON.parse(localStorage.getItem("tianshu-keybindings") ?? "{}");
}

/** 桩 navigator.userAgent（detectPlatform 平台分支；jsdom 原值两不沾） */
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
});

beforeEach(() => {
  changeLanguage.mockClear();
  localStorage.clear();
  document.documentElement.style.fontSize = "";
  toastMock.error.mockClear();
  toastMock.info.mockClear();
  toastMock.warning.mockClear();
  invokeMock.mockClear();
  stubInvoke();
});

describe("快捷键页骨架与展示", () => {
  it("切换导航：右栏整页为快捷键内容（表头 + 17 行），可切回通用页", async () => {
    await renderDialog();
    fireEvent.click(
      screen.getByRole("button", { name: "settings:nav.shortcuts" }),
    );
    await act(async () => {});
    expect(screen.getByText("settings:shortcut.columnCommand")).toBeTruthy();
    expect(screen.getByText("settings:shortcut.columnBinding")).toBeTruthy();
    expect(screen.getByText("settings:shortcut.columnAction")).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(18); // 表头 + 17 条
    expect(screen.queryByText("settings:groups.general")).toBeNull();
    expect(
      screen.getByPlaceholderText("settings:shortcut.searchPlaceholder"),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "settings:nav.general" }),
    );
    await act(async () => {});
    expect(screen.getByText("settings:groups.general")).toBeTruthy();
    expect(screen.queryByText("settings:shortcut.columnCommand")).toBeNull();
  });

  it("默认绑定展示：Ctrl 胶囊 / F11 平台等价键特判 / 固定项不可编辑", async () => {
    await renderShortcutsPage();
    // jsdom 默认平台 linux：openSettings 默认 ⌘, 显示 Ctrl + ,
    const openRow = shortcutRow("openSettings");
    expect(within(openRow).getByText("Ctrl")).toBeTruthy();
    expect(within(openRow).getByText(",")).toBeTruthy();
    // toggleFullscreen 默认 ⌘⌃F 在 win/linux 无法命中 → 显示等价键 F11
    const fullscreenRow = shortcutRow("toggleFullscreen");
    expect(within(fullscreenRow).getByText("F11")).toBeTruthy();
    expect(within(fullscreenRow).queryByText("Ctrl")).toBeNull();
    // 固定项（zoomIn）：胶囊纯展示，行内无任何按钮，操作列为 —
    const zoomRow = shortcutRow("zoomIn");
    expect(within(zoomRow).queryByRole("button")).toBeNull();
    expect(within(zoomRow).getByText("—")).toBeTruthy();
    // 可自定义已绑定行：胶囊按钮 + 垃圾桶两个交互
    expect(within(openRow).getAllByRole("button")).toHaveLength(2);
  });

  it("搜索过滤命令列（大小写不敏感）与 × 清空", async () => {
    await renderShortcutsPage();
    const input = screen.getByPlaceholderText(
      "settings:shortcut.searchPlaceholder",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "OPENSETTINGS" } });
    expect(screen.getAllByRole("row")).toHaveLength(2); // 表头 + 命中 1 条
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.getByText("settings:shortcut.noResults")).toBeTruthy();
    expect(screen.queryAllByRole("row")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "common:close" }));
    expect(input.value).toBe("");
    expect(screen.getAllByRole("row")).toHaveLength(18);
  });

  it("搜索词非空时 Esc 清空且不关闭面板", async () => {
    const onOpenChange = await renderShortcutsPage();
    const input = screen.getByPlaceholderText(
      "settings:shortcut.searchPlaceholder",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "task" } });
    expect(screen.getAllByRole("row")).toHaveLength(3); // previous/nextTask
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
    expect(screen.getByRole("dialog")).toBeTruthy(); // 面板未被 Esc 关闭
    // open 受控恒为 true 时 getByRole 恒真，以未触发关闭回调为准
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getAllByRole("row")).toHaveLength(18);
  });
});

describe("监听编辑", () => {
  it("点击胶囊进入监听：捕获有效组合即保存并退出", async () => {
    await renderShortcutsPage();
    fireEvent.click(bindingButton("openSettings"));
    expect(screen.getByText("settings:shortcut.listening")).toBeTruthy();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(storedOverrides()).toEqual({ openSettings: "cmd+k" });
    expect(screen.queryByText("settings:shortcut.listening")).toBeNull();
    // 行内胶囊刷新为新绑定（linux：Ctrl + k）
    const row = shortcutRow("openSettings");
    expect(within(row).getByText("k")).toBeTruthy();
  });

  it("Esc 退出监听不保存，面板保持打开", async () => {
    const onOpenChange = await renderShortcutsPage();
    fireEvent.click(bindingButton("openSettings"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("settings:shortcut.listening")).toBeNull();
    expect(localStorage.getItem("tianshu-keybindings")).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
    // open 受控恒为 true 时 getByRole 恒真，以未触发关闭回调为准
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("纯修饰键忽略继续监听；无效组合 toast 且保持监听", async () => {
    await renderShortcutsPage();
    fireEvent.click(bindingButton("openSettings"));
    fireEvent.keyDown(window, { key: "Shift" });
    expect(screen.getByText("settings:shortcut.listening")).toBeTruthy();
    fireEvent.keyDown(window, { key: "a" }); // 裸单字符
    expect(toastMock.error).toHaveBeenCalledWith(
      "settings:shortcut.invalidBinding",
    );
    fireEvent.keyDown(window, { key: "b", shiftKey: true }); // 仅 shift
    expect(toastMock.error).toHaveBeenCalledTimes(2);
    expect(screen.getByText("settings:shortcut.listening")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(localStorage.getItem("tianshu-keybindings")).toBeNull();
  });

  it("darwin 系统级组合：警告但允许保存", async () => {
    const restoreUserAgent = stubUserAgent("Macintosh");
    try {
      await renderShortcutsPage();
      fireEvent.click(bindingButton("previousTask"));
      fireEvent.keyDown(window, { key: "q", metaKey: true }); // ⌘Q 系统级
      expect(toastMock.warning).toHaveBeenCalledWith(
        "settings:shortcut.systemWarning",
      );
      expect(storedOverrides()).toEqual({ previousTask: "cmd+q" });
    } finally {
      restoreUserAgent();
    }
  });
});

describe("冲突弹窗", () => {
  it("取消：不写入并退出监听", async () => {
    await renderShortcutsPage();
    fireEvent.click(bindingButton("openSettings"));
    fireEvent.keyDown(window, { key: "f", ctrlKey: true }); // 撞 sessionSearch 默认
    const dialog = screen.getByRole("alertdialog");
    expect(
      within(dialog).getByText("settings:shortcut.conflictMessage"),
    ).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "common:cancel" }),
    );
    await act(async () => {});
    expect(localStorage.getItem("tianshu-keybindings")).toBeNull();
    expect(screen.queryByText("settings:shortcut.listening")).toBeNull();
  });

  it("替换-默认占用方：占用命令写 unbound 哨兵，新绑定生效", async () => {
    await renderShortcutsPage();
    fireEvent.click(bindingButton("openSettings"));
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "settings:shortcut.replace",
      }),
    );
    await act(async () => {});
    expect(storedOverrides()).toEqual({
      openSettings: "cmd+f",
      sessionSearch: "unbound",
    });
    const row = shortcutRow("sessionSearch");
    expect(within(row).getByText("settings:shortcut.unbound")).toBeTruthy();
    expect(
      within(row).getByRole("button", { name: "settings:shortcut.setBinding" }),
    ).toBeTruthy();
  });

  it("替换-用户覆盖占用方：清除覆盖回默认（键即释放）", async () => {
    localStorage.setItem(
      "tianshu-keybindings",
      JSON.stringify({ previousTask: "cmd+k" }),
    );
    await renderShortcutsPage();
    fireEvent.click(bindingButton("openSettings"));
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "settings:shortcut.replace",
      }),
    );
    await act(async () => {});
    expect(storedOverrides()).toEqual({ openSettings: "cmd+k" });
    // previousTask 回默认 ⌘[（覆盖被清除而非 unbound）
    expect(within(shortcutRow("previousTask")).getByText("[")).toBeTruthy();
  });

  it("固定绑定占用：toast 提示，不弹窗不写入", async () => {
    await renderShortcutsPage();
    fireEvent.click(bindingButton("openSettings"));
    fireEvent.keyDown(window, { key: "=", ctrlKey: true }); // 撞 zoomIn 固定
    expect(toastMock.error).toHaveBeenCalledWith(
      "settings:shortcut.conflictFixed",
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(localStorage.getItem("tianshu-keybindings")).toBeNull();
    expect(screen.queryByText("settings:shortcut.listening")).toBeNull();
  });
});

describe("删除与恢复默认", () => {
  it("删除绑定：确认后写 unbound 哨兵，行显示未绑定 + 设置按钮", async () => {
    await renderShortcutsPage();
    fireEvent.click(
      within(shortcutRow("openSettings")).getByRole("button", {
        name: "common:delete",
      }),
    );
    const dialog = screen.getByRole("alertdialog");
    expect(
      within(dialog).getByText("settings:shortcut.deleteMessage"),
    ).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "common:delete" }),
    );
    await act(async () => {});
    expect(storedOverrides()).toEqual({ openSettings: "unbound" });
    const row = shortcutRow("openSettings");
    expect(within(row).getByText("settings:shortcut.unbound")).toBeTruthy();
    expect(
      within(row).getByRole("button", { name: "settings:shortcut.setBinding" }),
    ).toBeTruthy();
  });

  it("全部恢复默认：确认后清空存储并刷新列表（含解除 unbound）", async () => {
    localStorage.setItem(
      "tianshu-keybindings",
      JSON.stringify({ openSettings: "cmd+k", sessionSearch: "unbound" }),
    );
    await renderShortcutsPage();
    expect(within(shortcutRow("openSettings")).getByText("k")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "settings:shortcut.resetAll" }),
    );
    const dialog = screen.getByRole("alertdialog");
    expect(
      within(dialog).getByText("settings:shortcut.resetMessage"),
    ).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "common:confirm" }),
    );
    await act(async () => {});
    expect(localStorage.getItem("tianshu-keybindings")).toBeNull();
    expect(within(shortcutRow("openSettings")).getByText(",")).toBeTruthy();
    expect(within(shortcutRow("sessionSearch")).getByText("f")).toBeTruthy();
  });
});

describe("darwin 显示序", () => {
  it("修饰键符号 ⇧ 前置（⇧⌘B/⇧⌥W），F11 不特判（⌘^F）", async () => {
    const restoreUserAgent = stubUserAgent("Macintosh");
    try {
      await renderShortcutsPage();
      expect(shortcutRow("toggleArtifacts").textContent).toContain("⇧⌘B");
      expect(shortcutRow("showHideWindow").textContent).toContain("⇧⌥W");
      const fullscreen = shortcutRow("toggleFullscreen").textContent ?? "";
      expect(fullscreen).toContain("⌘^F");
      expect(fullscreen).not.toContain("F11");
      expect(shortcutRow("openSettings").textContent).toContain("⌘,");
    } finally {
      restoreUserAgent();
    }
  });
});
