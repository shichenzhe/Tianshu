// @vitest-environment jsdom
/**
 * MemoryGroup 组件测试（修订 B：只读 markdown 渲染 + AI 指令模式）：
 * - 四板块渲染：memoryProfile 按标题切分、行内 markdown 语法生效、近期动态
 *   条目列表化
 * - 整理状态行：上次整理相对时间 / 空（非法）值待首次整理 / 失败原因直显
 * - 空状态：开关开等待首次编译 / 开关关展示「去开启」并持久化
 * - 开关关闭：disabledNotice 提示条 + 记忆仍只读展示 + 编辑按钮禁用；
 *   开关即时持久化
 * - AI 指令模式：编辑按钮切换指令框显隐（「完成」退出、导入常驻）、指令
 *   成功失效缓存刷新展示且无保存按钮（指令直接落库）、成功后状态行更新、
 *   失败 toast 且输入保留、空指令禁发送、maxLength 限长
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
import { formatDistanceToNow } from "date-fns";
import { zhCN } from "date-fns/locale";
import { toast } from "sonner";

// i18n mock：t 直接返回 key（带插值时 key:JSON）；i18n.language 供常规组
// 语言下拉读当前值；getDateFnsLocale 供状态行相对时间取 locale
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
vi.mock("@/i18n", async () => {
  const { zhCN: locale } = await import("date-fns/locale");
  return {
    default: { t: (key: string) => key },
    getDateFnsLocale: () => locale,
  };
});

// memory.api 模块桩：AI 指令走 applyInstruction（IPC，主进程已直接落库），
// jsdom 无桥接
const applyInstructionMock = vi.hoisted(() => vi.fn());
vi.mock("../../src-react/domains/app-settings/api/memory.api", () => ({
  MemoryApi: {
    applyInstruction: (...args: unknown[]) => applyInstructionMock(...args),
    compileNow: vi.fn(async () => ({ ok: true })),
  },
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
import { SettingsApi } from "../../src-react/domains/app-settings/api/settings.api";

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

/** 固定久远时间：相对距离为年级，测试运行期间不会跨档抖动 */
const COMPILED_AT = "2020-01-01T08:00:00.000Z";

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

describe("MemoryGroup 四板块渲染（markdown）", () => {
  beforeEach(() => {
    mockItems = [];
    setMock.mockClear();
  });
  afterEach(() => cleanup());

  it("memoryProfile 按四标题切分渲染，近期动态条目列表化（li）", async () => {
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
    const recent = screen.getByText("[2026-09-01] 完成记忆解析");
    expect(recent.closest("li")).toBeTruthy();
  });

  it("行内 markdown 语法渲染：加粗 strong / 删除线 del", async () => {
    mockItems = [
      {
        name: "personalization.memoryProfile",
        value: "## 工作背景\n**重点**项目\n\n## 近期动态\n~~过时~~条目",
      },
    ];
    renderGroup();
    expect((await screen.findByText("重点")).closest("strong")).toBeTruthy();
    expect(screen.getByText("过时").closest("del")).toBeTruthy();
  });
});

describe("MemoryGroup 整理状态行", () => {
  beforeEach(() => {
    mockItems = [];
    setMock.mockClear();
  });
  afterEach(() => cleanup());

  it("memoryLastCompiledAt 有值：显示上次整理 + 相对时间", async () => {
    mockItems = [
      { name: "personalization.memoryProfile", value: PROFILE_MD },
      { name: "personalization.memoryLastCompiledAt", value: COMPILED_AT },
    ];
    renderGroup();
    const expected = formatDistanceToNow(new Date(COMPILED_AT), {
      addSuffix: true,
      locale: zhCN,
    });
    await waitFor(() =>
      expect(
        screen.getByText(
          `settings:memory.status.lastCompiledAt:${JSON.stringify({ time: expected })}`,
        ),
      ).toBeTruthy(),
    );
    expect(
      screen.queryByText("settings:memory.status.neverCompiled"),
    ).toBeNull();
  });

  it("memoryLastCompiledAt 为空：显示待首次整理", async () => {
    mockItems = [{ name: "personalization.memoryProfile", value: PROFILE_MD }];
    renderGroup();
    expect(
      await screen.findByText("settings:memory.status.neverCompiled"),
    ).toBeTruthy();
  });

  it("memoryLastError 非空：显示失败原因行（前缀 + 原文直显，红色）", async () => {
    mockItems = [
      { name: "personalization.memoryProfile", value: PROFILE_MD },
      { name: "personalization.memoryLastError", value: "模型超时" },
    ];
    renderGroup();
    const errorLine = await screen.findByText(
      "settings:memory.status.errorPrefix模型超时",
    );
    expect(errorLine.className).toContain("destructive");
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

  it("开关关：编辑按钮禁用（指令会被后端拒绝），导入/重置仍可用", async () => {
    mockItems = [
      { name: "personalization.memoryProfile", value: PROFILE_MD },
      { name: "personalization.memoryEnabled", value: "false" },
    ];
    renderGroup();
    await waitFor(() =>
      expect(screen.getByText("后端工程师，主攻分布式存储")).toBeTruthy(),
    );
    expect(
      screen
        .getByRole("button", { name: "settings:memory.actions.edit" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "settings:memory.actions.import" })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(
      screen
        .getByRole("button", { name: "settings:memory.actions.reset" })
        .hasAttribute("disabled"),
    ).toBe(false);
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

describe("MemoryGroup 数据新鲜度（M2）", () => {
  beforeEach(() => {
    mockItems = [];
    setMock.mockClear();
    vi.mocked(SettingsApi.getAll).mockClear();
  });
  afterEach(() => cleanup());

  it("mount 即失效刷新：缓存持有旧值时，重开页面拉到落库新值", async () => {
    // 首次挂载：拉到旧记忆（进入 React Query 缓存，staleTime Infinity）
    mockItems = [{ name: "personalization.memoryProfile", value: PROFILE_MD }];
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const first = render(
      <QueryClientProvider client={client}>
        <MemoryGroup />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText("后端工程师，主攻分布式存储")).toBeTruthy(),
    );
    first.unmount();
    // 夜间整理落库：数据源更新为新内容
    mockItems = [
      {
        name: "personalization.memoryProfile",
        value: "## 工作背景\n夜间新整理",
      },
    ];
    // 二次挂载（同一缓存）：无 mount 失效刷新则永远读旧缓存
    render(
      <QueryClientProvider client={client}>
        <MemoryGroup />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText("夜间新整理")).toBeTruthy());
    expect(screen.queryByText("后端工程师，主攻分布式存储")).toBeNull();
    expect(
      vi.mocked(SettingsApi.getAll).mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
  });
});

/** 进入 AI 指令模式并返回指令输入框（各用例公共前置） */
async function enterInstructionMode() {
  fireEvent.click(
    await screen.findByRole("button", { name: "settings:memory.actions.edit" }),
  );
  return (await screen.findByPlaceholderText(
    "settings:memory.edit.instructionPlaceholder",
  )) as HTMLInputElement;
}

describe("MemoryGroup AI 指令模式", () => {
  beforeEach(() => {
    mockItems = [{ name: "personalization.memoryProfile", value: PROFILE_MD }];
    setMock.mockClear();
    applyInstructionMock.mockReset();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });
  afterEach(() => cleanup());

  it("点击编辑：指令框出现、按钮变「完成」、导入按钮仍可见（常驻）、四板块只读；再点「完成」退出", async () => {
    renderGroup();
    // 展示态：无指令框
    await waitFor(() =>
      expect(screen.getByText("后端工程师，主攻分布式存储")).toBeTruthy(),
    );
    expect(
      screen.queryByPlaceholderText(
        "settings:memory.edit.instructionPlaceholder",
      ),
    ).toBeNull();
    const input = await enterInstructionMode();
    expect(input).toBeTruthy();
    // 按钮变「完成」，编辑按钮隐藏
    expect(
      screen.getByRole("button", { name: "settings:memory.edit.done" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "settings:memory.actions.edit" }),
    ).toBeNull();
    // 导入常驻（修「缺少导入」）、重置保留
    expect(
      screen.getByRole("button", { name: "settings:memory.actions.import" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "settings:memory.actions.reset" }),
    ).toBeTruthy();
    // 无保存/取消按钮（指令直接落库，无草稿概念）
    expect(
      screen.queryByRole("button", { name: "settings:memory.edit.save" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "settings:memory.edit.cancel" }),
    ).toBeNull();
    // 四板块仍只读展示（无 textarea）
    expect(screen.getByText("后端工程师，主攻分布式存储")).toBeTruthy();
    expect(
      screen.queryByRole("textbox", {
        name: "settings:memory.sections.work",
      }),
    ).toBeNull();
    // 「完成」退出指令模式
    fireEvent.click(
      screen.getByRole("button", { name: "settings:memory.edit.done" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByPlaceholderText(
          "settings:memory.edit.instructionPlaceholder",
        ),
      ).toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: "settings:memory.actions.edit" }),
    ).toBeTruthy();
  });

  it("指令成功：失效缓存刷新展示新记忆 + 输入清空，无保存按钮，前端不落库（主进程已落库）", async () => {
    renderGroup();
    const input = await enterInstructionMode();
    applyInstructionMock.mockImplementationOnce(async () => {
      // 主进程落库后数据源已更新（getAll 失效重取读到新值）
      mockItems = [
        {
          name: "personalization.memoryProfile",
          value: "## 工作背景\n新工作背景",
        },
      ];
      return { ok: true, memory: "## 工作背景\n新工作背景" };
    });
    fireEvent.change(input, { target: { value: "记住我在厦门" } });
    fireEvent.click(
      screen.getByRole("button", { name: "settings:memory.edit.send" }),
    );
    await waitFor(() => expect(screen.getByText("新工作背景")).toBeTruthy());
    expect(screen.queryByText("后端工程师，主攻分布式存储")).toBeNull();
    await waitFor(() =>
      expect(screen.queryByText("settings:memory.edit.applying")).toBeNull(),
    );
    expect(input.value).toBe("");
    expect(applyInstructionMock).toHaveBeenCalledWith("记住我在厦门");
    expect(setMock).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "settings:memory.edit.save" }),
    ).toBeNull();
  });

  it("指令成功后：状态行随缓存刷新显示上次整理时间", async () => {
    renderGroup();
    await waitFor(() =>
      expect(
        screen.getByText("settings:memory.status.neverCompiled"),
      ).toBeTruthy(),
    );
    applyInstructionMock.mockImplementationOnce(async () => {
      mockItems = [
        {
          name: "personalization.memoryProfile",
          value: "## 工作背景\n新工作背景",
        },
        { name: "personalization.memoryLastCompiledAt", value: COMPILED_AT },
      ];
      return { ok: true, memory: "## 工作背景\n新工作背景" };
    });
    const input = await enterInstructionMode();
    fireEvent.change(input, { target: { value: "记住我在厦门" } });
    fireEvent.click(
      screen.getByRole("button", { name: "settings:memory.edit.send" }),
    );
    const expected = formatDistanceToNow(new Date(COMPILED_AT), {
      addSuffix: true,
      locale: zhCN,
    });
    await waitFor(() =>
      expect(
        screen.getByText(
          `settings:memory.status.lastCompiledAt:${JSON.stringify({ time: expected })}`,
        ),
      ).toBeTruthy(),
    );
  });

  it("AI 指令失败（MEMORY_MODEL_MISSING）：toast.error 错误码文案，输入保留、展示不刷新", async () => {
    renderGroup();
    const input = await enterInstructionMode();
    applyInstructionMock.mockResolvedValueOnce({
      ok: false,
      error: "MEMORY_MODEL_MISSING",
    });
    fireEvent.change(input, { target: { value: "记住我在厦门" } });
    fireEvent.click(
      screen.getByRole("button", { name: "settings:memory.edit.send" }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "settings:memory.error.MEMORY_MODEL_MISSING",
      ),
    );
    expect(input.value).toBe("记住我在厦门");
    expect(screen.getByText("后端工程师，主攻分布式存储")).toBeTruthy();
    expect(setMock).not.toHaveBeenCalled();
  });

  it("AI 指令网络层 rejection：catch 后 toast 通用失败文案，输入保留", async () => {
    renderGroup();
    const input = await enterInstructionMode();
    applyInstructionMock.mockRejectedValueOnce(new Error("IPC 断连"));
    fireEvent.change(input, { target: { value: "记住我在厦门" } });
    fireEvent.click(
      screen.getByRole("button", { name: "settings:memory.edit.send" }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "settings:memory.toast.instructionFailed",
      ),
    );
    expect(input.value).toBe("记住我在厦门");
  });

  it("空指令：发送按钮禁用，Enter 也不触发 applyInstruction", async () => {
    renderGroup();
    const input = await enterInstructionMode();
    const send = screen.getByRole("button", {
      name: "settings:memory.edit.send",
    });
    expect(send.hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "   " } });
    expect(send.hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(applyInstructionMock).not.toHaveBeenCalled();
  });

  it("AI 指令输入框 maxLength=500（M1 前端限长）", async () => {
    renderGroup();
    const input = await enterInstructionMode();
    expect(input.getAttribute("maxlength")).toBe("500");
  });
});
