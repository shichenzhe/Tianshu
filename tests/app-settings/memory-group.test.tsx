// @vitest-environment jsdom
/**
 * MemoryGroup 组件测试（jsdom + testing-library）：
 * - 四板块渲染：memoryProfile 按标题切分、近期动态行首 "- "、超长折叠展开
 * - 空状态：开关开等待首次编译 / 开关关展示「去开启」并持久化
 * - 开关关闭：底部 disabledNotice 提示条 + 记忆仍只读展示；开关即时持久化
 * - 编辑模式：四 textarea（aria-label）/ 取消丢弃 / 保存落库 / AI 指令草稿
 *   刷新（成功 loading 消失、失败 toast 且草稿保留、空指令不触发）/ 编辑态
 *   关开关退出编辑转只读 / 空 memoryProfile 也可编辑
 * - SettingsDialog 导航：记忆项出现并可切换渲染 MemoryGroup
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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";

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

// memory.api 模块桩：编辑态 AI 指令走 applyInstruction（IPC），jsdom 无桥接
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

  it("单条超 500 字折叠，「展开」后完整显示，相邻短行不受影响", async () => {
    mockItems = [
      {
        name: "personalization.memoryProfile",
        value: `## 工作背景\n${"长".repeat(600)}\n${"短".repeat(10)}`,
      },
    ];
    renderGroup();
    await waitFor(() =>
      expect(screen.getByText("settings:memory.sections.work")).toBeTruthy(),
    );
    expect(screen.queryByText("长".repeat(600))).toBeNull();
    expect(screen.getByText("短".repeat(10))).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "settings:memory.expand" }),
    );
    await waitFor(() =>
      expect(screen.getByText("长".repeat(600))).toBeTruthy(),
    );
  });

  it("单条均未超限的节累计超 500 字不折叠（spec §6.2 单条粒度）", async () => {
    // 三条各 200 字（互不相同便于唯一定位）：节累计 600+ 但单条未超限
    const entries = Array.from(
      { length: 3 },
      (_, i) => "条".repeat(199) + String(i),
    );
    mockItems = [
      {
        name: "personalization.memoryProfile",
        value: `## 近期动态\n${entries.join("\n")}`,
      },
    ];
    renderGroup();
    await waitFor(() =>
      expect(screen.getByText("settings:memory.sections.recent")).toBeTruthy(),
    );
    for (const entry of entries) {
      expect(screen.getByText(`- ${entry}`)).toBeTruthy();
    }
    expect(
      screen.queryByRole("button", { name: "settings:memory.expand" }),
    ).toBeNull();
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

/** 进入编辑态并返回工作背景 textarea（各用例公共前置） */
async function enterEditMode() {
  fireEvent.click(
    await screen.findByRole("button", { name: "settings:memory.actions.edit" }),
  );
  return (await screen.findByRole("textbox", {
    name: "settings:memory.sections.work",
  })) as HTMLTextAreaElement;
}

function findInstructionInput() {
  return screen.getByPlaceholderText(
    "settings:memory.edit.instructionPlaceholder",
  ) as HTMLInputElement;
}

describe("MemoryGroup 编辑模式", () => {
  beforeEach(() => {
    mockItems = [{ name: "personalization.memoryProfile", value: PROFILE_MD }];
    setMock.mockClear();
    applyInstructionMock.mockReset();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });
  afterEach(() => cleanup());

  it("点击编辑：四板块变四个 textarea（aria-label 为四节标题）且预填切分内容", async () => {
    renderGroup();
    const work = await enterEditMode();
    expect(work.value).toBe("后端工程师，主攻分布式存储");
    const personal = screen.getByRole("textbox", {
      name: "settings:memory.sections.personal",
    }) as HTMLTextAreaElement;
    expect(personal.value).toBe("常驻上海");
    expect(
      (
        screen.getByRole("textbox", {
          name: "settings:memory.sections.current",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("记忆与进化模块");
    expect(
      (
        screen.getByRole("textbox", {
          name: "settings:memory.sections.recent",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("[2026-09-01] 完成记忆解析");
    // 编辑态头部：重置保留、取消/保存出现、编辑/导入隐藏（spec §6.2）
    expect(
      screen.getByRole("button", { name: "settings:memory.actions.reset" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "settings:memory.edit.cancel" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "settings:memory.edit.save" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "settings:memory.actions.edit" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "settings:memory.actions.import" }),
    ).toBeNull();
    // AI 指令输入框随编辑态出现
    expect(findInstructionInput()).toBeTruthy();
  });

  it("点击取消：textarea 修改被丢弃，恢复展示态原文", async () => {
    renderGroup();
    const work = await enterEditMode();
    fireEvent.change(work, { target: { value: "被丢弃的修改" } });
    fireEvent.click(
      screen.getByRole("button", { name: "settings:memory.edit.cancel" }),
    );
    await waitFor(() =>
      expect(screen.getByText("后端工程师，主攻分布式存储")).toBeTruthy(),
    );
    expect(
      screen.queryByRole("textbox", {
        name: "settings:memory.sections.work",
      }),
    ).toBeNull();
    expect(screen.queryByText("被丢弃的修改")).toBeNull();
    expect(setMock).not.toHaveBeenCalled();
  });

  it("点击保存：set 收到 buildMemoryMarkdown 拼接（含修改文本）+ 成功 toast + 退出编辑", async () => {
    renderGroup();
    const work = await enterEditMode();
    fireEvent.change(work, { target: { value: "新的工作内容" } });
    fireEvent.click(
      screen.getByRole("button", { name: "settings:memory.edit.save" }),
    );
    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith(
        "personalization.memoryProfile",
        "## 工作背景\n新的工作内容\n\n## 个人背景\n常驻上海\n\n## 当前关注\n记忆与进化模块\n\n## 近期动态\n[2026-09-01] 完成记忆解析",
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", {
          name: "settings:memory.sections.work",
        }),
      ).toBeNull(),
    );
    expect(toast.success).toHaveBeenCalledWith("settings:memory.toast.saved");
  });

  it("AI 指令成功：loading 出现后消失，草稿刷新为返回 markdown，输入框清空，不落库", async () => {
    renderGroup();
    await enterEditMode();
    let resolveApply!: (value: { ok: boolean; memory?: string }) => void;
    applyInstructionMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveApply = resolve;
        }),
    );
    const input = findInstructionInput();
    fireEvent.change(input, { target: { value: "记住我在厦门" } });
    fireEvent.click(
      screen.getByRole("button", { name: "settings:memory.edit.send" }),
    );
    expect(
      await screen.findByText("settings:memory.edit.applying"),
    ).toBeTruthy();
    await act(async () => {
      resolveApply({ ok: true, memory: "## 工作背景\n新工作背景" });
    });
    await waitFor(() =>
      expect(
        (
          screen.getByRole("textbox", {
            name: "settings:memory.sections.work",
          }) as HTMLTextAreaElement
        ).value,
      ).toBe("新工作背景"),
    );
    await waitFor(() =>
      expect(screen.queryByText("settings:memory.edit.applying")).toBeNull(),
    );
    expect(input.value).toBe("");
    expect(applyInstructionMock).toHaveBeenCalledWith("记住我在厦门");
    // 指令模式不落库（spec §5.4）：保存前不触发 SettingsApi.set
    expect(setMock).not.toHaveBeenCalled();
  });

  it("AI 指令失败（MEMORY_MODEL_MISSING）：toast.error 错误码文案，草稿与输入框保留", async () => {
    renderGroup();
    const work = await enterEditMode();
    fireEvent.change(work, { target: { value: "未保存的草稿修改" } });
    applyInstructionMock.mockResolvedValueOnce({
      ok: false,
      error: "MEMORY_MODEL_MISSING",
    });
    const input = findInstructionInput();
    fireEvent.change(input, { target: { value: "记住我在厦门" } });
    fireEvent.click(
      screen.getByRole("button", { name: "settings:memory.edit.send" }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "settings:memory.error.MEMORY_MODEL_MISSING",
      ),
    );
    expect(
      (
        screen.getByRole("textbox", {
          name: "settings:memory.sections.work",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("未保存的草稿修改");
    expect(input.value).toBe("记住我在厦门");
    expect(setMock).not.toHaveBeenCalled();
  });

  it("AI 指令网络层 rejection：catch 后 toast 通用失败文案，草稿保留", async () => {
    renderGroup();
    await enterEditMode();
    applyInstructionMock.mockRejectedValueOnce(new Error("IPC 断连"));
    fireEvent.change(findInstructionInput(), {
      target: { value: "记住我在厦门" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "settings:memory.edit.send" }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "settings:memory.toast.instructionFailed",
      ),
    );
    expect(
      screen.getByRole("textbox", { name: "settings:memory.sections.work" }),
    ).toBeTruthy();
  });

  it("空指令：发送按钮禁用，Enter 也不触发 applyInstruction", async () => {
    renderGroup();
    await enterEditMode();
    const input = findInstructionInput();
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

  it("编辑态把开关关掉：退出编辑转只读 + disabledNotice 出现（D3 无确认弹窗）", async () => {
    renderGroup();
    const work = await enterEditMode();
    fireEvent.change(work, { target: { value: "编辑中的修改" } });
    fireEvent.click(
      screen.getByRole("switch", { name: "settings:memory.toggle.label" }),
    );
    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith(
        "personalization.memoryEnabled",
        "false",
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", {
          name: "settings:memory.sections.work",
        }),
      ).toBeNull(),
    );
    expect(screen.getByText("settings:memory.disabledNotice")).toBeTruthy();
    // 转只读：原文恢复，编辑中的修改被丢弃
    expect(screen.getByText("后端工程师，主攻分布式存储")).toBeTruthy();
    expect(screen.queryByText("编辑中的修改")).toBeNull();
  });

  it("memoryProfile 为空也可进入编辑：空草稿四 textarea 可写并保存", async () => {
    mockItems = [];
    renderGroup();
    const work = await enterEditMode();
    expect(work.value).toBe("");
    fireEvent.change(work, { target: { value: "第一次写入" } });
    fireEvent.click(
      screen.getByRole("button", { name: "settings:memory.edit.save" }),
    );
    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith(
        "personalization.memoryProfile",
        "## 工作背景\n第一次写入",
      ),
    );
  });

  it("保存超限草稿：拼接后截断到 8000（保尾部最新）再落库（M5）", async () => {
    mockItems = [];
    renderGroup();
    const work = await enterEditMode();
    fireEvent.change(work, {
      // 9000 字：拼接 "## 工作背景\n" 后共 9007 字，超 8000 限
      target: { value: `头${"甲".repeat(8998)}尾` },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "settings:memory.edit.save" }),
    );
    await waitFor(() => expect(setMock).toHaveBeenCalled());
    const saved = setMock.mock.calls.find(
      ([name]) => name === "personalization.memoryProfile",
    )?.[1] as string;
    expect(saved).toHaveLength(8000);
    expect(saved.endsWith("尾")).toBe(true);
    expect(saved).not.toContain("头"); // 头部（含节标题）被截去，尾部最新保留
  });

  it("AI 指令输入框 maxLength=500（M1 前端限长）", async () => {
    mockItems = [{ name: "personalization.memoryProfile", value: PROFILE_MD }];
    renderGroup();
    await enterEditMode();
    expect(findInstructionInput().getAttribute("maxlength")).toBe("500");
  });
});
