// @vitest-environment jsdom
/**
 * MemoryGroup 组件测试（jsdom + testing-library）：
 * - 四板块渲染：memoryProfile 按标题切分、近期动态行首 "- "、超长折叠展开
 * - 空状态：开关开等待首次编译 / 开关关展示「去开启」并持久化
 * - 开关关闭：底部 disabledNotice 提示条 + 记忆仍只读展示；开关即时持久化
 * - SettingsDialog 导航：记忆项出现并可切换渲染 MemoryGroup
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

// i18n mock：t 直接返回 key；i18n.language 供常规组语言下拉读当前值
// （渲染 SettingsDialog 挂载 GeneralGroup，与 settings-dialog.test.tsx 同款）
const changeLanguage = vi.hoisted(() => vi.fn());
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: "zh-CN", changeLanguage },
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));

// localStorage stub（常规组字体档位读写；与 settings-dialog.test.tsx 同款）
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

const setMock = vi.fn(async () => undefined);
let mockItems: Array<{ name: string; value: string }> = [];

// settings.api 模块桩：个性化页走 getAll/set；渲染 SettingsDialog 时常规页
// 各组挂载即调 getAutoLaunch/getKeepAwake/storageInfo，一并兜底
vi.mock("../../src-react/domains/app-settings/api/settings.api", () => ({
  SettingsApi: {
    getAll: vi.fn(async () => mockItems),
    set: (name: string, value: string) => setMock(name, value),
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

import MemoryGroup from "../../src-react/domains/app-settings/components/MemoryGroup";
import SettingsDialog from "../../src-react/domains/app-settings/components/SettingsDialog";

const PROFILE_MD = [
  "## 工作背景",
  "后端工程师，主攻分布式存储",
  "",
  "## 个人背景",
  "常驻上海",
  "",
  "## 当前关注",
  "记忆与进化模块",
  "",
  "## 近期动态",
  "[2026-09-01] 完成记忆解析",
].join("\n");

function renderGroup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryGroup />
    </QueryClientProvider>,
  );
}

async function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SettingsDialog open onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
}

describe("MemoryGroup 四板块渲染", () => {
  beforeEach(() => {
    mockItems = [];
    setMock.mockClear();
  });
  afterEach(() => cleanup());

  it('memoryProfile 按四标题切分渲染，近期动态行首加 "- " 前缀', async () => {
    mockItems = [{ name: "personalization.memoryProfile", value: PROFILE_MD }];
    renderGroup();
    await waitFor(() =>
      expect(screen.getByText("后端工程师，主攻分布式存储")).toBeTruthy(),
    );
    expect(screen.getByText("settings:memory.sections.work")).toBeTruthy();
    expect(screen.getByText("settings:memory.sections.personal")).toBeTruthy();
    expect(screen.getByText("settings:memory.sections.current")).toBeTruthy();
    expect(screen.getByText("settings:memory.sections.recent")).toBeTruthy();
    expect(screen.getByText("常驻上海")).toBeTruthy();
    expect(screen.getByText("- [2026-09-01] 完成记忆解析")).toBeTruthy();
  });

  it("单节超 500 字折叠，「展开」后完整显示", async () => {
    mockItems = [
      {
        name: "personalization.memoryProfile",
        value: `## 工作背景\n${"长".repeat(600)}`,
      },
    ];
    renderGroup();
    await waitFor(() =>
      expect(screen.getByText("settings:memory.sections.work")).toBeTruthy(),
    );
    expect(screen.queryByText("长".repeat(600))).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "settings:memory.expand" }),
    );
    await waitFor(() =>
      expect(screen.getByText("长".repeat(600))).toBeTruthy(),
    );
  });
});

describe("MemoryGroup 空状态", () => {
  beforeEach(() => {
    mockItems = [];
    setMock.mockClear();
  });
  afterEach(() => cleanup());

  it("开关开（默认）：等待首次编译文案，不显示「去开启」", async () => {
    renderGroup();
    await waitFor(() =>
      expect(screen.getByText("settings:memory.empty.title")).toBeTruthy(),
    );
    expect(screen.getByText("settings:memory.empty.pending")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "settings:memory.empty.enable" }),
    ).toBeNull();
  });

  it("开关关：显示「去开启」，点击持久化 memoryEnabled=true", async () => {
    mockItems = [{ name: "personalization.memoryEnabled", value: "false" }];
    renderGroup();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "settings:memory.empty.enable",
      }),
    );
    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith(
        "personalization.memoryEnabled",
        "true",
      ),
    );
  });
});

describe("MemoryGroup 开关关闭态", () => {
  beforeEach(() => {
    mockItems = [];
    setMock.mockClear();
  });
  afterEach(() => cleanup());

  it("底部 disabledNotice 提示条 + 记忆仍只读展示", async () => {
    mockItems = [
      { name: "personalization.memoryProfile", value: PROFILE_MD },
      { name: "personalization.memoryEnabled", value: "false" },
    ];
    renderGroup();
    await waitFor(() =>
      expect(screen.getByText("settings:memory.disabledNotice")).toBeTruthy(),
    );
    expect(screen.getByText("后端工程师，主攻分布式存储")).toBeTruthy();
  });

  it("开关切换即时持久化 memoryEnabled", async () => {
    mockItems = [{ name: "personalization.memoryProfile", value: PROFILE_MD }];
    renderGroup();
    fireEvent.click(
      await screen.findByRole("switch", {
        name: "settings:memory.toggle.label",
      }),
    );
    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith(
        "personalization.memoryEnabled",
        "false",
      ),
    );
  });
});

describe("SettingsDialog 记忆导航", () => {
  beforeEach(() => {
    mockItems = [{ name: "personalization.memoryProfile", value: PROFILE_MD }];
    setMock.mockClear();
    localStorage.clear();
  });
  afterEach(() => cleanup());

  it("导航项出现并可切换渲染 MemoryGroup", async () => {
    await renderDialog();
    fireEvent.click(
      screen.getByRole("button", { name: /settings:nav.memory/ }),
    );
    // 页头即时渲染，四板块需等 ["personalization"] 查询数据到位后再断言
    await waitFor(() =>
      expect(screen.getByText("settings:memory.title")).toBeTruthy(),
    );
    await waitFor(() =>
      expect(screen.getByText("settings:memory.sections.work")).toBeTruthy(),
    );
  });
});
