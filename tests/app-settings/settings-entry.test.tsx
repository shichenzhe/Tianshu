// @vitest-environment jsdom
/**
 * 「记忆与进化」入口直达测试（UserMenu → settings-ui store → SettingsDialog）：
 * - 用户菜单点「记忆与进化」：面板打开并定位记忆页（memory.title，mock 骨架
 *   与 memory-group.test.tsx 同款）
 * - 用户菜单点「设置」：面板打开默认通用页（groups.general，无记忆页标题）
 * - store 语义：openSettings(tab) 同时置 open+tab；无参 tab 为 null（默认
 *   通用页）；关闭（setSettingsOpen(false)）tab 复位 null
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// i18n mock：t 直接返回 key（带插值时 key:JSON）；i18n.language 供常规组
// 语言下拉读当前值（与 memory-group.test.tsx 同款）
const changeLanguage = vi.hoisted(() => vi.fn());
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: "zh-CN", changeLanguage },
  }),
}));

// UserMenu 专属桩：路由导航 / 用户态 / 与入口直达无关的三个子对话框
// （useLocation 桩供 UserMenu 内 useClearWallpaper 路由判断，无需 Router 上下文）
const navigateMock = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useLocation: () => ({ pathname: "/" }),
  };
});
vi.mock("@/domains/user/store/user.store", () => ({
  useUserStore: () => ({ user: { username: "测试用户" }, reset: vi.fn() }),
}));
vi.mock("@/domains/user/components/UserInfoDialog", () => ({
  default: () => null,
}));
vi.mock("@/domains/user/components/PasswordDialog", () => ({
  default: () => null,
}));
vi.mock("@/components/common/UpdateLogDialog", () => ({
  default: () => null,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/i18n", async () => {
  const { zhCN: locale } = await import("date-fns/locale");
  return {
    default: { t: (key: string) => key },
    getDateFnsLocale: () => locale,
  };
});

// settings/memory api 模块桩（jsdom 无 IPC 桥接）：设置面板各页数据源，
// 渲染 SettingsDialog 时常规页各组挂载即调 getAutoLaunch/storageInfo 等
vi.mock("@/domains/app-settings/api/settings.api", () => ({
  SettingsApi: {
    getAll: vi.fn(async () => []),
    set: vi.fn(async () => undefined),
    getAutoLaunch: vi.fn(async () => false),
    getKeepAwake: vi.fn(async () => false),
    storageInfo: vi.fn(async () => ({
      userDataPath: "/userData",
      cacheBytes: 0,
      diskTotal: 0,
      diskFree: 0,
    })),
    pickDirectory: vi.fn(async () => null),
  },
}));
vi.mock("@/domains/app-settings/api/memory.api", () => ({
  MemoryApi: {
    applyInstruction: vi.fn(async () => ({ ok: true })),
    compileNow: vi.fn(async () => ({ ok: true })),
  },
}));

// localStorage stub（常规组字体档位读写；与 memory-group.test.tsx 同款）
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

import UserMenu from "../../src-react/components/layout/UserMenu";
import { useSettingsUiStore } from "../../src-react/domains/app-settings/store/settings-ui.store";

/** 复位 store（各用例独立，避免跨用例泄漏 open/tab） */
function resetSettingsStore() {
  useSettingsUiStore.setState({ settingsOpen: false, settingsTab: null });
}

function renderUserMenu() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <UserMenu />
    </QueryClientProvider>,
  );
}

/** 点击展开用户下拉菜单（原顶栏 hover 展开改侧边栏点击模式：
 *  pointerDown 展开，同 tests/project/tasks-pane.test.tsx 先例），返回目标菜单项 */
async function openMenuAndGetItem(itemText: string) {
  // 触发器 div 无 role（Radix asChild），用用户名文本定位、pointerDown 冒泡展开
  fireEvent.pointerDown(screen.getByText("测试用户"), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  return waitFor(() => screen.getByText(itemText));
}

describe("settings-ui store：openSettings 与 tab 复位", () => {
  afterEach(() => {
    resetSettingsStore();
    cleanup();
  });

  it("openSettings(tab) 置 open+tab；关闭复位 tab；无参打开 tab 为 null", () => {
    useSettingsUiStore.getState().openSettings("memory");
    expect(useSettingsUiStore.getState().settingsOpen).toBe(true);
    expect(useSettingsUiStore.getState().settingsTab).toBe("memory");

    useSettingsUiStore.getState().setSettingsOpen(false);
    expect(useSettingsUiStore.getState().settingsOpen).toBe(false);
    expect(useSettingsUiStore.getState().settingsTab).toBeNull();

    useSettingsUiStore.getState().openSettings();
    expect(useSettingsUiStore.getState().settingsOpen).toBe(true);
    expect(useSettingsUiStore.getState().settingsTab).toBeNull();
  });
});

describe("UserMenu 设置入口直达", () => {
  beforeEach(() => {
    resetSettingsStore();
    localStorage.clear();
  });
  afterEach(() => {
    resetSettingsStore();
    cleanup();
  });

  it("点「记忆与进化」：面板打开并定位记忆页（memory.title）", async () => {
    renderUserMenu();
    const item = await openMenuAndGetItem("layout:userMenu.memoryEvolution");
    fireEvent.click(item);

    await waitFor(() =>
      expect(screen.getByText("settings:memory.title")).toBeTruthy(),
    );
    expect(useSettingsUiStore.getState().settingsOpen).toBe(true);
    // 默认通用页分组不在记忆页渲染
    expect(screen.queryByText("settings:groups.general")).toBeNull();
  });

  it("点「设置」：面板打开默认通用页（groups.general）", async () => {
    renderUserMenu();
    const item = await openMenuAndGetItem("layout:userMenu.settings");
    fireEvent.click(item);

    await waitFor(() =>
      expect(screen.getByText("settings:groups.general")).toBeTruthy(),
    );
    expect(screen.queryByText("settings:memory.title")).toBeNull();
  });
});
