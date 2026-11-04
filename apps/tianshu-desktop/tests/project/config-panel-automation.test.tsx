// @vitest-environment jsdom
/**
 * ConfigPanel 定时任务区块测试（子系统 E 终态，jsdom + testing-library，
 * mock 骨架同 tests/project/tasks-pane.test.tsx：t 返回 key（插值变量以
 * 空格拼接后缀，lastRun {{time}} 断言锚点）、sonner、@/i18n 桩、
 * AutomationApi/能力 api/user store mock + QueryClientProvider；
 * CreateTaskDialog 桩捕获 props 断言 project 预设；MemoryRouter +
 * LocationProbe 捕获任务名跳转；fixture：本项目任务 ×2（active 启用 +
 * active 暂停）+ 他项目任务 ×1 + 全局任务 ×1）：
 * - 过滤：仅本项目两行渲染（projectId 匹配 detail.project.id），他项目/
 *   全局任务不出现（开关数同为 2）
 * - 行字段：名称 + scheduleText + 状态（enabled ? running : paused 纯文本；
 *   error/expired 走 Badge）+ 上次运行相对文案（chat:lastRun + "N 天前"）
 * - 启停：点 Switch → toggle(id, next) + invalidate ["automation","tasks"]；
 *   失败 → mapIpcError 文案 toast
 * - 立即运行：点按钮 → runNow(id) + invalidate；TASK_ALREADY_RUNNING →
 *   project:panel.taskRunning 专用文案；其他错误 → mapIpcError 透传
 * - 新建：点按钮 → CreateTaskDialog 收到 project prop
 *   { id, workspaceId: detail.assetWorkspaceId, workspaceName: 通用文案 }
 * - 任务名点击 → navigate /module/ai/automation/task/:id
 * - 空态：无本项目任务 → automationEmpty 文案；新建与「前往自动化」恒在，
 *   前往自动化点击 → navigate /module/ai/automation
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
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

// Radix 弹层在 jsdom 的最小桩：popper 定位依赖 ResizeObserver，
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
  return {
    ...actual,
    // key 直返；带插值变量时以空格拼接后缀（lastRun {{time}} 断言锚点）
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) =>
        opts && Object.keys(opts).length > 0
          ? `${key} ${Object.values(opts).join(" ")}`
          : key,
    }),
  };
});

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

// 相对时间经 getDateFnsLocale 取 locale（zhCN 断言 "N 天前" 稳定文案）
vi.mock("@/i18n", async () => {
  const { zhCN: locale } = await import("date-fns/locale");
  return {
    default: { t: (key: string) => key },
    getDateFnsLocale: () => locale,
  };
});

// AutomationApi 静态类整体 mock（区块消费 list/toggle/runNow）
vi.mock("../../src-react/domains/ai/automation/api/automation.api", () => ({
  AutomationApi: { list: vi.fn(), toggle: vi.fn(), runNow: vi.fn() },
}));

// CreateTaskDialog 桩：捕获 props（断言 project 预设），渲染占位
const dialogProps = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));
vi.mock(
  "../../src-react/domains/ai/automation/components/CreateTaskDialog",
  async () => {
    const { createElement } = await import("react");
    return {
      CreateTaskDialog: (props: Record<string, unknown>) => {
        dialogProps.current = props;
        return createElement("div", null, "create-task-dialog-mock");
      },
    };
  },
);

// 配置面板能力列表三源（同 project-workspace.test 桩口径，空列表即可）
vi.mock("@/domains/ai/api/assistant.api", () => ({
  AssistantApi: { list: vi.fn() },
  default: { list: vi.fn() },
}));
vi.mock("@/domains/ai/skills/api/skill.api", () => ({
  default: { list: vi.fn() },
}));
vi.mock("@/domains/ai/api/mcp.api", () => ({
  McpServerApi: { list: vi.fn() },
  default: { list: vi.fn() },
}));

vi.mock("@/domains/user/store/user.store", () => ({
  useUserStore: (
    selector?: (state: { user: { id: number; nickname: string } }) => unknown,
  ) =>
    selector
      ? selector({ user: { id: 1, nickname: "小明" } })
      : { user: { id: 1, nickname: "小明" } },
}));

// MarkdownView 桩：指令区透传原文，隔离 markdown 渲染管道
vi.mock("../../src-react/domains/ai/chat/components/MarkdownView", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ text }: { text: string }) => createElement("div", null, text),
  };
});

import ConfigPanel from "../../src-react/domains/project/components/ConfigPanel";
import { AutomationApi } from "../../src-react/domains/ai/automation/api/automation.api";
import type { TaskRecord } from "../../src-react/domains/ai/automation/api/automation.api";
import { AssistantApi } from "@/domains/ai/api/assistant.api";
import SkillApi from "@/domains/ai/skills/api/skill.api";
import { McpServerApi } from "@/domains/ai/api/mcp.api";
import type { ProjectDetail } from "../../../electron/domains/project/project.entity";

/** 项目详情夹具：项目 id 1 / 资产空间 30（未挂载能力、无指令） */
const DETAIL: ProjectDetail = {
  project: {
    id: 1,
    name: "alpha",
    systemPrompt: null,
    templateKey: null,
    ownerId: 1,
    sessionId: 11,
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
  },
  assetWorkspaceId: 30,
  bindings: [],
  session: {
    id: 11,
    workspaceId: 30,
    title: "alpha",
    mode: "agent",
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
  },
};

const DAY_MS = 24 * 3600 * 1000;

/** N 天前的 ISO 时间（formatDistanceToNow zhCN 断言 "N 天前" 稳定） */
const isoDaysAgo = (days: number) =>
  new Date(Date.now() - days * DAY_MS).toISOString();

const makeTask = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  id: 3,
  name: "每日汇报",
  prompt: "汇总今日进展",
  workspaceId: 30,
  workspaceName: "研发空间",
  source: "project",
  modelId: 5,
  scheduleJson: "{}",
  scheduleText: "每天 09:00",
  missedPolicy: "skip",
  accessMode: "default",
  enabled: true,
  status: "active",
  projectId: 1,
  lastRunAt: isoDaysAgo(3),
  createdAt: isoDaysAgo(9),
  updatedAt: isoDaysAgo(1),
  ...overrides,
});

/** 默认夹具：本项目 ×2（启用 + 暂停）+ 他项目 ×1 + 全局 ×1 */
const TASKS: TaskRecord[] = [
  makeTask({ id: 3, name: "每日汇报", enabled: true }),
  makeTask({ id: 4, name: "周报整理", enabled: false }),
  makeTask({ id: 5, name: "他项目任务", projectId: 2 }),
  makeTask({ id: 6, name: "全局任务", projectId: null }),
];

/** 渲染面板（MemoryRouter + 位置探针 + 自动化路由占位），返回 client 供 invalidate 断言 */
function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/module/project/1"]}>
        <LocationProbe />
        <Routes>
          <Route
            path="/module/project/1"
            element={<ConfigPanel detail={DETAIL} />}
          />
          <Route
            path="/module/ai/automation"
            element={<div>automation-stub</div>}
          />
          <Route
            path="/module/ai/automation/task/:taskId"
            element={<div>task-detail-stub</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

/** 位置探针：path 断言（任务名/前往自动化跳转） */
function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">{`${location.pathname}${location.search}`}</div>
  );
}

/** 按任务名取所在行（li）作用域，行内定位开关/按钮等 */
const rowOf = (name: string) => {
  const row = screen.getByText(name).closest("li");
  if (!row) {
    throw new Error(`row not found for ${name}`);
  }
  return row;
};

beforeEach(() => {
  vi.mocked(AutomationApi.list).mockReset().mockResolvedValue(TASKS);
  vi.mocked(AutomationApi.toggle)
    .mockReset()
    .mockResolvedValue({} as never);
  vi.mocked(AutomationApi.runNow)
    .mockReset()
    .mockResolvedValue(undefined as never);
  vi.mocked(AssistantApi.list).mockReset().mockResolvedValue([]);
  vi.mocked(SkillApi.list).mockReset().mockResolvedValue([]);
  vi.mocked(McpServerApi.list).mockReset().mockResolvedValue([]);
  dialogProps.current = null;
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

afterEach(cleanup);

describe("ConfigPanel 定时任务区块", () => {
  it("过滤：仅本项目两行渲染，他项目/全局任务不出现", async () => {
    renderPanel();

    expect(await screen.findByText("每日汇报")).toBeTruthy();
    expect(screen.getByText("周报整理")).toBeTruthy();
    expect(screen.queryByText("他项目任务")).toBeNull();
    expect(screen.queryByText("全局任务")).toBeNull();
    // 两行 = 两个启停开关；前往自动化入口非空态恒在
    expect(screen.getAllByRole("switch")).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "project:panel.goAutomation" }),
    ).toBeTruthy();
  });

  it("行字段：名称 + scheduleText + 状态（running/paused 文本、error/expired 徽标）+ 上次运行", async () => {
    vi.mocked(AutomationApi.list).mockResolvedValue([
      makeTask({ id: 7, name: "启用任务", enabled: true, status: "active" }),
      makeTask({ id: 8, name: "暂停任务", enabled: false, status: "active" }),
      makeTask({ id: 9, name: "异常任务", status: "error" }),
      makeTask({ id: 10, name: "过期任务", status: "expired" }),
    ]);
    renderPanel();
    await screen.findByText("异常任务");

    const running = within(rowOf("启用任务"));
    expect(running.getByText("每天 09:00")).toBeTruthy();
    expect(running.getByText("chat:automation.status.running")).toBeTruthy();
    expect(
      running.getByText("chat:automation.list.lastRun 3 天前"),
    ).toBeTruthy();

    expect(
      within(rowOf("暂停任务")).getByText("chat:automation.status.paused"),
    ).toBeTruthy();
    expect(
      within(rowOf("异常任务")).getByText("chat:automation.status.error"),
    ).toBeTruthy();
    expect(
      within(rowOf("过期任务")).getByText("chat:automation.status.expired"),
    ).toBeTruthy();
  });

  it("启停：点 Switch → toggle(id, next) + invalidate；失败 → toast 错误文案", async () => {
    const client = renderPanel();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    await screen.findByText("每日汇报");

    // 启用行点开关 → 关闭（toggle(3, false)）+ 失效任务列表缓存
    fireEvent.click(within(rowOf("每日汇报")).getByRole("switch"));
    await waitFor(() =>
      expect(AutomationApi.toggle).toHaveBeenCalledWith(3, false),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["automation", "tasks"] }),
      ),
    );

    // 暂停行点开关失败（toggle(4, true) 被拒）→ mapIpcError 透传文案
    vi.mocked(AutomationApi.toggle).mockRejectedValueOnce(
      new Error("TOGGLE_FAILED"),
    );
    fireEvent.click(within(rowOf("周报整理")).getByRole("switch"));
    await waitFor(() =>
      expect(AutomationApi.toggle).toHaveBeenCalledWith(4, true),
    );
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("TOGGLE_FAILED"),
    );
  });

  it("立即运行：runNow(id) + invalidate；TASK_ALREADY_RUNNING → 专用文案，其他错误 → mapIpcError", async () => {
    const client = renderPanel();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    await screen.findByText("每日汇报");
    const play = within(rowOf("每日汇报")).getByRole("button", {
      name: "chat:automation.detail.play",
    });

    // 触发成功 → 成功提示 + 失效任务列表（lastRunAt/状态回显刷新）
    fireEvent.click(play);
    await waitFor(() => expect(AutomationApi.runNow).toHaveBeenCalledWith(3));
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["automation", "tasks"] }),
      ),
    );
    expect(toastMock.success).toHaveBeenCalledWith(
      "chat:automation.detail.playing",
    );

    // 运行中互斥拒发 → 专用冲突文案
    vi.mocked(AutomationApi.runNow).mockRejectedValueOnce(
      new Error("TASK_ALREADY_RUNNING"),
    );
    fireEvent.click(play);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("project:panel.taskRunning"),
    );

    // 其他错误 → mapIpcError 原样透传
    vi.mocked(AutomationApi.runNow).mockRejectedValueOnce(
      new Error("SCHEDULER_DOWN"),
    );
    fireEvent.click(play);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("SCHEDULER_DOWN"),
    );
  });

  it("新建：点按钮 → CreateTaskDialog 打开并收到 project 预设（空间锁定 + 通用名）", async () => {
    renderPanel();
    await screen.findByText("每日汇报");

    fireEvent.click(
      screen.getByRole("button", { name: "project:panel.automationNew" }),
    );

    expect(dialogProps.current).toMatchObject({
      open: true,
      project: {
        id: 1,
        workspaceId: 30,
        workspaceName: "project:panel.projectWorkspace",
      },
    });
  });

  it("任务名点击 → navigate /module/ai/automation/task/:id", async () => {
    renderPanel();
    await screen.findByText("每日汇报");

    fireEvent.click(screen.getByText("每日汇报"));

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/module/ai/automation/task/3",
      ),
    );
    expect(screen.getByText("task-detail-stub")).toBeTruthy();
  });

  it("空态：无本项目任务 → automationEmpty 文案 + 新建/前往自动化入口", async () => {
    // 仅他项目 + 全局任务：本项目过滤为空
    vi.mocked(AutomationApi.list).mockResolvedValue(TASKS.slice(2));
    renderPanel();

    expect(
      await screen.findByText("project:panel.automationEmpty"),
    ).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(
      screen.getByRole("button", { name: "project:panel.automationNew" }),
    ).toBeTruthy();

    // 前往自动化入口恒在且可跳转
    fireEvent.click(
      screen.getByRole("button", { name: "project:panel.goAutomation" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/module/ai/automation",
      ),
    );
    expect(screen.getByText("automation-stub")).toBeTruthy();
  });
});
