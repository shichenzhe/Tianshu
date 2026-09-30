// @vitest-environment jsdom
/**
 * SessionTreePanel 项目组交互测试（二期批 7 D8：组头点击进项目页）：
 * - 项目组渲染：组名=项目名；已删项目（projectId 不在列表）兜底文案
 * - 组名区点击 → navigate /module/project/:id
 * - 折叠钮点击仅折叠：组内任务行显隐、不进项目页——两者为兄弟按钮，
 *   事件天然隔离（可及名区分：组名钮带「进入项目」动作后缀）
 * t 返回 key；Workspace/Session/Project api 静态类 mock；LocationProbe
 * 断言导航；chat.store/ai-ui.store 真实实现（timeFilter 缺省 all）
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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";

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

// localStorage stub：store 模块加载链在 Node 环境消除 ExperimentalWarning
vi.hoisted(() => {
  const memory = new Map<string, string>();
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
    clear: () => memory.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
});

// 相对时间经 getDateFnsLocale 取 locale（顶层命名导出，stub 为 zhCN）
vi.mock("@/i18n", async () => {
  const { zhCN } = await import("date-fns/locale");
  return {
    default: { t: (key: string) => key },
    getDateFnsLocale: () => zhCN,
  };
});
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

const workspaceApiMock = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/domains/ai/api/workspace.api", () => ({
  default: workspaceApiMock,
}));
const sessionApiMock = vi.hoisted(() => ({ listAll: vi.fn() }));
vi.mock("@/domains/ai/api/session.api", () => ({
  default: sessionApiMock,
}));
const projectApiMock = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/domains/project/api/project.api", () => ({
  default: projectApiMock,
}));

import SessionTreePanel from "../../src-react/domains/ai/layout/components/SessionTreePanel";
import type { SessionRecord } from "../../src-react/domains/ai/api/session.api";

/** 会话夹具（普通/项目主/项目任务/已删项目归属） */
const session = (overrides: Partial<SessionRecord>): SessionRecord => ({
  id: 31,
  workspaceId: 2,
  title: "任务A",
  mode: "agent",
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
  projectId: null,
  planItemId: null,
  ...overrides,
});

const SESSIONS: SessionRecord[] = [
  session({ id: 31, title: "普通会话" }),
  session({ id: 21, workspaceId: 30, projectId: 11, title: "北斗官网主会话" }),
  session({
    id: 22,
    workspaceId: 30,
    projectId: 11,
    planItemId: 55,
    title: "调研竞品",
  }),
  session({ id: 23, workspaceId: 40, projectId: 99, title: "孤儿项目会话" }),
];

const PROJECTS = [
  {
    id: 11,
    name: "北斗官网",
    systemPrompt: null,
    templateKey: null,
    ownerId: 1,
    sessionId: 21,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
];

/** 位置探针：组头导航断言 */
function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">{`${location.pathname}${location.search}`}</div>
  );
}

function renderPanel() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={["/module/ai"]}>
        <LocationProbe />
        <SessionTreePanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  workspaceApiMock.list.mockReset().mockResolvedValue([
    {
      id: 2,
      name: "默认工作空间",
      directoryPath: null,
      defaultModelId: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
  ]);
  sessionApiMock.listAll.mockReset().mockResolvedValue(SESSIONS);
  projectApiMock.list.mockReset().mockResolvedValue(PROJECTS);
});

afterEach(cleanup);

describe("SessionTreePanel 项目组（批 7 D8 组头进项目页）", () => {
  it("项目组渲染：组名=项目名；已删项目兜底文案；任务会话排在主会话前", async () => {
    renderPanel();

    // 项目组名（北斗官网）与已删项目兜底文案（projectId 99 不在列表）
    expect(await screen.findByText("北斗官网")).toBeTruthy();
    expect(
      await screen.findByText("project:sidebar.deletedProject"),
    ).toBeTruthy();
    // 组内任务行可见
    expect(await screen.findByText("调研竞品")).toBeTruthy();
  });

  it("组名区点击 → 进项目页 /module/project/:id", async () => {
    renderPanel();
    const nameButton = await screen.findByRole("button", {
      name: "北斗官网 · project:sidebar.enterProject",
    });

    fireEvent.click(nameButton);

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/module/project/11",
      ),
    );
  });

  it("折叠钮点击仅折叠：组内任务行隐藏/恢复，不进项目页", async () => {
    renderPanel();
    await screen.findByText("调研竞品");

    // 折叠钮可及名=组名（与组名区按钮的动作后缀区分）
    fireEvent.click(screen.getByRole("button", { name: "北斗官网" }));
    await waitFor(() => expect(screen.queryByText("调研竞品")).toBeNull());
    expect(screen.getByTestId("location").textContent).toBe("/module/ai");

    // 再点展开恢复
    fireEvent.click(screen.getByRole("button", { name: "北斗官网" }));
    await waitFor(() => expect(screen.getByText("调研竞品")).toBeTruthy());
  });
});
