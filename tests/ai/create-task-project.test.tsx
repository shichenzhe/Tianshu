// @vitest-environment jsdom
/**
 * CreateTaskDialog 项目预设测试（子系统 E，jsdom + testing-library，
 * mock 骨架同 tests/project/plan-item-dialog.test.tsx：t 返回 key、
 * sonner、@/i18n 桩、Radix 桩 + QueryClientProvider；TaskPromptInput
 * 以受控替身渲染 prompt 文本框与 set-model 按钮透传 onModelChange）：
 * - 传入 project：workspace Select 禁用、显示项目空间名（锁定值无候选
 *   项，经 SelectValue children 直显），且不发起 ["workspaces"] 查询
 * - 保存：AutomationApi.create 载荷 workspaceId=锁定值、projectId=project.id
 *   （初值经 buildInitialValues 注入，handleSubmit 不覆写）
 * - 未传 project：行为不变——workspaces 查询发起、Radix Select 真实选点、
 *   空间默认模型联动预填、payload projectId null（AI 模块零 diff 回归）
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// Radix Select 在 jsdom 的最小桩：popper 定位依赖 ResizeObserver，
// 触发器 pointerDown 分支依赖 hasPointerCapture/scrollIntoView
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

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

// @/lib/utils 经 cn 间接引入 @/i18n，最小桩避免拉起完整 i18n 栈
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));

// AutomationApi 静态类整体 mock（弹窗仅触达 create/stat）
vi.mock("../../src-react/domains/ai/automation/api/automation.api", () => ({
  AutomationApi: { create: vi.fn(), stat: vi.fn() },
}));

// WorkspaceApi 静态类整体 mock（workspaces 查询源）
vi.mock("@/domains/ai/api/workspace.api", () => ({
  WorkspaceApi: { list: vi.fn() },
}));

// TaskPromptInput 重交互替身：prompt 受控回写 + set-model 透传
// onModelChange（项目预设下 workspaces 为空，默认模型联动不触发，
// 模型须经此按钮选定）
vi.mock(
  "../../src-react/domains/ai/automation/components/TaskPromptInput",
  () => ({
    default: ({
      value,
      onChange,
      onModelChange,
    }: {
      value: string;
      onChange: (v: string) => void;
      onModelChange: (id: number) => void;
    }) => (
      <div>
        <textarea
          aria-label="prompt-stub"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button type="button" onClick={() => onModelChange(5)}>
          set-model
        </button>
      </div>
    ),
  }),
);

import { CreateTaskDialog } from "../../src-react/domains/ai/automation/components/CreateTaskDialog";
import { AutomationApi } from "../../src-react/domains/ai/automation/api/automation.api";
import { WorkspaceApi } from "@/domains/ai/api/workspace.api";
import type { WorkspaceRecord } from "@/domains/ai/api/workspace.api";

/** 项目预设夹具：id 11 / 资产空间 30「研发空间」 */
const PROJECT = { id: 11, workspaceId: 30, workspaceName: "研发空间" };

/** 未传 project 时的空间候选（defaultModelId 供联动预填断言） */
const WORKSPACES: WorkspaceRecord[] = [
  {
    id: 1,
    name: "默认空间",
    defaultModelId: 5,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
];

/** 渲染打开态创建弹窗（useNavigate 需路由上下文） */
function renderDialog(project?: typeof PROJECT) {
  const onSaved = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false } },
        })
      }
    >
      <MemoryRouter>
        <CreateTaskDialog
          open
          onOpenChange={onOpenChange}
          project={project}
          onSaved={onSaved}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onSaved, onOpenChange };
}

/** 填名称 + 提示词（模型另经 set-model / 空间默认模型联动） */
function fillBasics() {
  fireEvent.change(
    screen.getByPlaceholderText("chat:automation.create.namePlaceholder"),
    { target: { value: "项目任务" } },
  );
  fireEvent.change(screen.getByLabelText("prompt-stub"), {
    target: { value: "汇总今日进展" },
  });
}

/** Radix Select 选项切换：mouse pointerDown 展开 + click 选中 */
async function selectOption(trigger: HTMLElement, optionName: string) {
  fireEvent.pointerDown(trigger, {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  fireEvent.click(await screen.findByRole("option", { name: optionName }));
}

const getWorkspaceTrigger = () =>
  screen.getByRole("combobox", {
    name: "chat:automation.create.workspace",
  }) as HTMLButtonElement;

/** 等保存按钮可用后点击提交并返回 create 首参 */
async function submitAndCaptureParams() {
  const confirm = screen.getByRole("button", {
    name: "common:confirm",
  }) as HTMLButtonElement;
  await waitFor(() => expect(confirm.disabled).toBe(false));
  fireEvent.click(confirm);
  await waitFor(() => expect(AutomationApi.create).toHaveBeenCalledTimes(1));
  return vi.mocked(AutomationApi.create).mock.calls[0][0];
}

afterEach(() => {
  cleanup();
  // 跨用例共享模块 mock：清调用记录（保留各用例自行设置的实现）
  vi.clearAllMocks();
});

describe("CreateTaskDialog 项目预设", () => {
  it("传入 project：workspace Select 禁用且显示项目空间名；不发起 workspaces 查询", async () => {
    renderDialog(PROJECT);
    const trigger = await waitFor(() => getWorkspaceTrigger());
    expect(trigger.disabled).toBe(true);
    // 锁定值无候选项，项目空间名经 SelectValue 直显
    expect(screen.getByText(PROJECT.workspaceName)).toBeTruthy();
    expect(WorkspaceApi.list).not.toHaveBeenCalled();
  });

  it("保存：create 载荷 workspaceId=锁定值 30 且 projectId=11（初值注入，无覆写）", async () => {
    vi.mocked(AutomationApi.create).mockResolvedValue({} as never);
    vi.mocked(AutomationApi.stat).mockResolvedValue(undefined as never);
    renderDialog(PROJECT);
    await screen.findByRole("dialog");
    fillBasics();
    fireEvent.click(screen.getByRole("button", { name: "set-model" }));
    const params = await submitAndCaptureParams();
    expect(params.workspaceId).toBe(30);
    expect(params.projectId).toBe(11);
  });

  it("未传 project：行为不变——查询发起、可另选空间、payload projectId null", async () => {
    vi.mocked(WorkspaceApi.list).mockResolvedValue(WORKSPACES);
    vi.mocked(AutomationApi.create).mockResolvedValue({} as never);
    vi.mocked(AutomationApi.stat).mockResolvedValue(undefined as never);
    renderDialog();
    await screen.findByRole("dialog");
    await waitFor(() => expect(WorkspaceApi.list).toHaveBeenCalledTimes(1));

    const trigger = getWorkspaceTrigger();
    expect(trigger.disabled).toBe(false);
    await selectOption(trigger, "默认空间");
    fillBasics();
    const params = await submitAndCaptureParams();
    expect(params.workspaceId).toBe(1);
    expect(params.projectId).toBeNull();
  });
});
