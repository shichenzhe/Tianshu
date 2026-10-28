// @vitest-environment jsdom
/**
 * 记忆重置/导入弹窗交互测试（jsdom + testing-library，mock 骨架同
 * memory-group.test.tsx）：
 * - ResetMemoryDialog：三行警告与按钮渲染、取消不触发、确认触发 onConfirm
 * - ImportMemoryDialog：两步标题与预置提示词渲染、复制成功短暂「已复制」
 *   （mock navigator.clipboard + 2s 复位）、导入按钮空值禁用、四标题/
 *   无标题/代码块围栏三类输入的合并结果与回退 toast、onImported 失败
 *   弹窗保持打开
 * - MemoryGroup 接线：重置确认清空落库、指令模式中重置退出指令模式、
 *   导入合并落库、AI 指令应用中「完成」禁用（Task 8 移交）
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

// i18n mock：t 直接返回 key；i18n.language 供导入弹窗选预置提示词 locale
const changeLanguage = vi.hoisted(() => vi.fn());
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: "zh-CN", changeLanguage },
  }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/i18n", async () => {
  const { zhCN } = await import("date-fns/locale");
  return {
    default: { t: (key: string) => key },
    getDateFnsLocale: () => zhCN,
  };
});

// memory.api 模块桩：MemoryGroup 编辑态 AI 指令走 applyInstruction（IPC）
const applyInstructionMock = vi.hoisted(() => vi.fn());
vi.mock("../../src-react/domains/app-settings/api/memory.api", () => ({
  MemoryApi: {
    applyInstruction: (...args: unknown[]) => applyInstructionMock(...args),
    compileNow: vi.fn(async () => ({ ok: true })),
  },
}));

// localStorage stub（与 settings-dialog.test.tsx 同款）
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

// set 落库同步到 getAll 数据源：invalidateQueries 后回读到写入值
// （如重置后空状态、导入后合并内容）
const setMock = vi.fn(async (name: string, value: string) => {
  mockItems = mockItems
    .filter((item) => item.name !== name)
    .concat([{ name, value }]);
});
let mockItems: Array<{ name: string; value: string }> = [];

// settings.api 模块桩：MemoryGroup 走 getAll/set
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

import ResetMemoryDialog from "../../src-react/domains/app-settings/components/memory/ResetMemoryDialog";
import ImportMemoryDialog from "../../src-react/domains/app-settings/components/memory/ImportMemoryDialog";
import MemoryGroup from "../../src-react/domains/app-settings/components/MemoryGroup";
import { getImportPrompt } from "../../src-react/domains/app-settings/model/import-prompt";

const CURRENT_MD = "## 工作背景\n现有工作内容";
const FOUR_TITLE_MD =
  "## 工作背景\n导入的工作内容\n\n## 个人背景\n导入的个人内容";
const NO_TITLE_MD = "没有任何标题的记忆内容";
const FENCED_MD = "```\n## 工作背景\n围栏内的工作内容\n```";

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

function renderResetDialog(
  props: Partial<Parameters<typeof ResetMemoryDialog>[0]> = {},
) {
  const onOpenChange = vi.fn();
  const onConfirm = vi.fn(async () => undefined);
  render(
    <ResetMemoryDialog
      open
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
      {...props}
    />,
  );
  return { onOpenChange, onConfirm };
}

function renderImportDialog({
  currentMemory = CURRENT_MD,
  onImported = vi.fn(async () => undefined),
}: {
  currentMemory?: string;
  onImported?: (merged: string) => Promise<void>;
} = {}) {
  const onOpenChange = vi.fn();
  render(
    <ImportMemoryDialog
      open
      onOpenChange={onOpenChange}
      currentMemory={currentMemory}
      onImported={onImported}
    />,
  );
  return { onOpenChange, onImported };
}

/** 导入弹窗步骤②粘贴输入框 */
function findPasteTextarea() {
  return screen.getByPlaceholderText(
    "settings:memory.importDialog.step2.placeholder",
  ) as HTMLTextAreaElement;
}

describe("ResetMemoryDialog", () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });
  afterEach(() => cleanup());

  it("渲染三行警告与 取消/重置记忆 按钮", () => {
    renderResetDialog();
    expect(
      screen.getByText("settings:memory.resetDialog.warning1"),
    ).toBeTruthy();
    expect(
      screen.getByText("settings:memory.resetDialog.warning2"),
    ).toBeTruthy();
    expect(
      screen.getByText("settings:memory.resetDialog.warning3"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "common:cancel" })).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "settings:memory.resetDialog.confirm",
      }),
    ).toBeTruthy();
  });

  it("取消：onOpenChange(false) 且 onConfirm 未调用", () => {
    const { onOpenChange, onConfirm } = renderResetDialog();
    fireEvent.click(screen.getByRole("button", { name: "common:cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenChange).not.toHaveBeenCalledWith(true);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("确认：onConfirm 调用 + 成功 toast + 关闭", async () => {
    const { onOpenChange, onConfirm } = renderResetDialog();
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings:memory.resetDialog.confirm",
      }),
    );
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith("settings:memory.toast.reset");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("确认失败：错误 toast 且弹窗不关", async () => {
    const onConfirm = vi.fn(async () => {
      throw new Error("ipc down");
    });
    const { onOpenChange } = renderResetDialog({ onConfirm });
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings:memory.resetDialog.confirm",
      }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("settings:error.saveFailed"),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe("ImportMemoryDialog", () => {
  const writeTextMock = vi.fn(async () => undefined);

  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      configurable: true,
    });
    writeTextMock.mockClear();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.info).mockClear();
  });
  afterEach(() => cleanup());

  it("渲染步骤①②标题与预置提示词全文（zh-CN）", () => {
    renderImportDialog();
    expect(
      screen.getByText("settings:memory.importDialog.step1.title"),
    ).toBeTruthy();
    expect(
      screen.getByText("settings:memory.importDialog.step2.title"),
    ).toBeTruthy();
    const pre = document.querySelector("pre");
    expect(pre?.textContent).toBe(getImportPrompt("zh-CN"));
    expect(pre?.textContent).toContain("## 近期动态");
  });

  it("复制成功：writeText 收到提示词，按钮短暂变「已复制」2s 后复位", async () => {
    renderImportDialog();
    vi.useFakeTimers();
    try {
      fireEvent.click(
        screen.getByRole("button", {
          name: "settings:memory.importDialog.step1.copy",
        }),
      );
      await act(async () => {}); // flush clipboard promise
      expect(writeTextMock).toHaveBeenCalledWith(getImportPrompt("zh-CN"));
      expect(
        screen.getByRole("button", {
          name: "settings:memory.importDialog.step1.copied",
        }),
      ).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(
        screen.getByRole("button", {
          name: "settings:memory.importDialog.step1.copy",
        }),
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("复制失败：toast.error 提示手动复制", async () => {
    writeTextMock.mockRejectedValueOnce(new Error("denied"));
    renderImportDialog();
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings:memory.importDialog.step1.copy",
      }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "settings:memory.toast.copyFailed",
      ),
    );
  });

  it("导入按钮初始 disabled，输入内容后 enabled，纯空白仍 disabled", () => {
    renderImportDialog();
    const importButton = screen.getByRole("button", {
      name: "settings:memory.importDialog.confirm",
    });
    expect(importButton.hasAttribute("disabled")).toBe(true);
    fireEvent.change(findPasteTextarea(), {
      target: { value: NO_TITLE_MD },
    });
    expect(importButton.hasAttribute("disabled")).toBe(false);
    fireEvent.change(findPasteTextarea(), { target: { value: "   " } });
    expect(importButton.hasAttribute("disabled")).toBe(true);
  });

  it("导入四标题内容：onImported 收到 mergeMemoryMarkdown 合并追加结果", async () => {
    const onImported = vi.fn(async () => undefined);
    const { onOpenChange } = renderImportDialog({ onImported });
    fireEvent.change(findPasteTextarea(), { target: { value: FOUR_TITLE_MD } });
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings:memory.importDialog.confirm",
      }),
    );
    await waitFor(() =>
      expect(onImported).toHaveBeenCalledWith(
        "## 工作背景\n现有工作内容\n导入的工作内容\n\n## 个人背景\n导入的个人内容",
      ),
    );
    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith(
      "settings:memory.toast.imported",
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("导入无标题内容：回退 toast 且 onImported 收到全进 work 的结果", async () => {
    const onImported = vi.fn(async () => undefined);
    const { onOpenChange } = renderImportDialog({ onImported });
    fireEvent.change(findPasteTextarea(), { target: { value: NO_TITLE_MD } });
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings:memory.importDialog.confirm",
      }),
    );
    await waitFor(() =>
      expect(onImported).toHaveBeenCalledWith(
        "## 工作背景\n现有工作内容\n没有任何标题的记忆内容",
      ),
    );
    expect(toast.info).toHaveBeenCalledWith(
      "settings:memory.toast.importFallback",
    );
    expect(toast.success).toHaveBeenCalledWith(
      "settings:memory.toast.imported",
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("带代码块围栏的输入被剥离：onImported 收到不含 ``` 的合并结果", async () => {
    const onImported = vi.fn(async () => undefined);
    renderImportDialog({ onImported });
    fireEvent.change(findPasteTextarea(), { target: { value: FENCED_MD } });
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings:memory.importDialog.confirm",
      }),
    );
    await waitFor(() =>
      expect(onImported).toHaveBeenCalledWith(
        "## 工作背景\n现有工作内容\n围栏内的工作内容",
      ),
    );
    expect(onImported.mock.calls[0][0]).not.toContain("```");
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("onImported 失败：错误 toast 且弹窗不关、输入保留", async () => {
    const onImported = vi.fn(async () => {
      throw new Error("ipc down");
    });
    const { onOpenChange } = renderImportDialog({ onImported });
    fireEvent.change(findPasteTextarea(), { target: { value: FOUR_TITLE_MD } });
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings:memory.importDialog.confirm",
      }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("settings:error.saveFailed"),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(findPasteTextarea().value).toBe(FOUR_TITLE_MD);
  });

  it("复制复位计时器在弹窗关闭与卸载时被清理（T9a）", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      const onOpenChange = vi.fn();
      const onImported = vi.fn(async () => undefined);
      const view = render(
        <ImportMemoryDialog
          open
          onOpenChange={onOpenChange}
          currentMemory={CURRENT_MD}
          onImported={onImported}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: "settings:memory.importDialog.step1.copy",
        }),
      );
      await act(async () => {}); // flush clipboard promise → setCopied(true) + 挂复位计时器
      // 复位计时器（delay 恰为 COPIED_RESET_MS=2000）在延迟参数上可唯一定位
      const idx = setTimeoutSpy.mock.calls.findIndex(
        (call) => call[1] === 2000,
      );
      expect(idx).toBeGreaterThanOrEqual(0);
      const timerId = setTimeoutSpy.mock.results[idx].value;
      clearTimeoutSpy.mockClear();
      // 关闭（open=false）：复位计时器清理，防计时器越界触发
      view.rerender(
        <ImportMemoryDialog
          open={false}
          onOpenChange={onOpenChange}
          currentMemory={CURRENT_MD}
          onImported={onImported}
        />,
      );
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timerId);
      // 再次复制 → 卸载路径同样清理
      view.rerender(
        <ImportMemoryDialog
          open
          onOpenChange={onOpenChange}
          currentMemory={CURRENT_MD}
          onImported={onImported}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: "settings:memory.importDialog.step1.copy",
        }),
      );
      await act(async () => {});
      const idx2 = setTimeoutSpy.mock.calls.findIndex(
        (call, i) => call[1] === 2000 && i > idx,
      );
      const timerId2 = setTimeoutSpy.mock.results[idx2].value;
      clearTimeoutSpy.mockClear();
      view.unmount();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timerId2);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it("importing 中：取消按钮禁用，Esc 关闭请求被忽略，完成后正常关闭（T9b）", async () => {
    let resolveImport!: () => void;
    const onImported = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveImport = resolve;
        }),
    );
    const onOpenChange = vi.fn();
    render(
      <ImportMemoryDialog
        open
        onOpenChange={onOpenChange}
        currentMemory={CURRENT_MD}
        onImported={onImported}
      />,
    );
    fireEvent.change(findPasteTextarea(), { target: { value: FOUR_TITLE_MD } });
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings:memory.importDialog.confirm",
      }),
    );
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
    // 导入进行中：取消禁用 + 用户关闭请求（Esc → onOpenChange(false)）被忽略
    expect(
      screen
        .getByRole("button", { name: "common:cancel" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await act(async () => {});
    expect(onOpenChange).not.toHaveBeenCalled();
    // 完成后：成功路径正常关弹窗
    await act(async () => {
      resolveImport();
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(
      screen
        .getByRole("button", { name: "common:cancel" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });
});

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

/** 进入 AI 指令模式并返回指令输入框（接线用例公共前置） */
async function enterInstructionMode() {
  fireEvent.click(
    await screen.findByRole("button", { name: "settings:memory.actions.edit" }),
  );
  return (await screen.findByPlaceholderText(
    "settings:memory.edit.instructionPlaceholder",
  )) as HTMLInputElement;
}

describe("MemoryGroup 三按钮接线", () => {
  beforeEach(() => {
    mockItems = [{ name: "personalization.memoryProfile", value: PROFILE_MD }];
    setMock.mockClear();
    applyInstructionMock.mockReset();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.info).mockClear();
  });
  afterEach(() => cleanup());

  it("重置：弹窗确认后 memoryProfile 落库空串 + toast + 转空状态", async () => {
    renderGroup();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "settings:memory.actions.reset",
      }),
    );
    await screen.findByText("settings:memory.resetDialog.warning1");
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings:memory.resetDialog.confirm",
      }),
    );
    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith("personalization.memoryProfile", ""),
    );
    expect(toast.success).toHaveBeenCalledWith("settings:memory.toast.reset");
    await screen.findByText("settings:memory.empty.title");
  });

  it("指令模式中点重置：确认后退出指令模式并清空落库", async () => {
    renderGroup();
    const input = await enterInstructionMode();
    fireEvent.change(input, { target: { value: "删除全部记忆" } });
    fireEvent.click(
      screen.getByRole("button", { name: "settings:memory.actions.reset" }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings:memory.resetDialog.confirm",
      }),
    );
    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith("personalization.memoryProfile", ""),
    );
    await waitFor(() =>
      expect(
        screen.queryByPlaceholderText(
          "settings:memory.edit.instructionPlaceholder",
        ),
      ).toBeNull(),
    );
  });

  it("导入：粘贴内容合并追加落库 + 成功 toast", async () => {
    renderGroup();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "settings:memory.actions.import",
      }),
    );
    fireEvent.change(
      await screen.findByPlaceholderText(
        "settings:memory.importDialog.step2.placeholder",
      ),
      { target: { value: "## 个人背景\n导入的背景" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings:memory.importDialog.confirm",
      }),
    );
    await waitFor(() =>
      expect(setMock).toHaveBeenCalledWith(
        "personalization.memoryProfile",
        "## 工作背景\n后端工程师，主攻分布式存储\n\n## 个人背景\n常驻上海\n导入的背景\n\n## 当前关注\n记忆与进化模块\n\n## 近期动态\n[2026-09-01] 完成记忆解析",
      ),
    );
    expect(toast.success).toHaveBeenCalledWith(
      "settings:memory.toast.imported",
    );
  });

  it("AI 指令应用中：「完成」按钮禁用，完成后恢复（Task 8 移交）", async () => {
    renderGroup();
    await enterInstructionMode();
    let resolveApply!: (value: { ok: boolean; memory?: string }) => void;
    applyInstructionMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveApply = resolve;
        }),
    );
    fireEvent.change(
      screen.getByPlaceholderText(
        "settings:memory.edit.instructionPlaceholder",
      ),
      { target: { value: "记住我在厦门" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "settings:memory.edit.send" }),
    );
    expect(
      await screen.findByText("settings:memory.edit.applying"),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "settings:memory.edit.done" })
        .hasAttribute("disabled"),
    ).toBe(true);
    await act(async () => {
      resolveApply({ ok: true, memory: PROFILE_MD });
    });
    await waitFor(() =>
      expect(screen.queryByText("settings:memory.edit.applying")).toBeNull(),
    );
    expect(
      screen
        .getByRole("button", { name: "settings:memory.edit.done" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });
});
