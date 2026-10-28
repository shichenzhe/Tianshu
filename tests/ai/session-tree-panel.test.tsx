// @vitest-environment jsdom
/**
 * SessionTreePanel 项目组交互测试（二期批 7 D8：组头点击进项目页）：
 * - 项目组渲染：组名=项目名；已删项目（projectId 不在列表）兜底文案
 * - 组名区点击 → navigate /module/project/:id
 * - 折叠钮点击仅折叠：组内任务行显隐、不进项目页——两者为兄弟按钮，
 *   事件天然隔离（可及名区分：组名钮带「进入项目」动作后缀）
 * - 主窗→文件窗跳转（spec §19 项 1）：session-map 反向索引命中行渲染
 *   入口，点击 invoke fileWindow:open 且不选中；未命中不渲染；失败 toast
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
  within,
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
const sessionApiMock = vi.hoisted(() => ({
  listAll: vi.fn(),
  archive: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/domains/ai/api/session.api", () => ({
  default: sessionApiMock,
}));
const projectApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/domains/project/api/project.api", () => ({
  default: projectApiMock,
}));

const invokeMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/ipc", () => ({ invoke: invokeMock }));

import SessionTreePanel from "../../src-react/domains/ai/layout/components/SessionTreePanel";
import type { SessionRecord } from "../../src-react/domains/ai/api/session.api";
import { useHostStore } from "../../src-react/domains/ai/data-source/host.store";
import { useNewTaskStore } from "../../src-react/domains/ai/new-task/store/new-task-store";

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
  sessionApiMock.archive.mockReset().mockResolvedValue(undefined);
  sessionApiMock.create
    .mockReset()
    .mockResolvedValue(session({ id: 77, title: "新会话" }));
  projectApiMock.list.mockReset().mockResolvedValue(PROJECTS);
  projectApiMock.update.mockReset().mockResolvedValue(undefined);
  projectApiMock.remove.mockReset().mockResolvedValue(undefined);
  useHostStore.setState({ activeHost: { kind: "local" } });
  useNewTaskStore.setState({ workspaceId: null });
});

/** 项目组 ⋯ 悬浮钮（data-testid 精确定位——任务行 ⋯ 同名 aria-label
 *  也在 DOM；渲染序取首个=projectOrder 在前的「北斗官网」。
 *  Radix DropdownMenuTrigger jsdom 下须 pointerDown 且带
 *  pointerType:"mouse"（缺省 pointerType 不触发 open），open 后留一拍
 *  等 Portal 内容挂稳） */
const openProjectMenu = async () => {
  const triggers = await screen.findAllByTestId("project-more-trigger");
  fireEvent.pointerDown(triggers[0], { button: 0, pointerType: "mouse" });
  await screen.findByRole("menu");
};

/** 点击菜单项：menu 容器命中后同步遍历 menuitem 按 textContent 定位
 *  （findByText 异步轮询的让渡窗口里 jsdom 下 Radix 菜单会被异步
 *  关闭——须在 menu 挂稳的同一同步块内完成定位与点击） */
const clickMenuItem = async (text: string) => {
  await screen.findByRole("menu");
  const item = [...document.querySelectorAll('[role="menuitem"]')].find(
    (el) => el.textContent === text,
  );
  expect(item).toBeTruthy();
  fireEvent.click(item as HTMLElement);
};

afterEach(cleanup);

describe("SessionTreePanel 空间树流畅度（memo + grid-rows 折叠动画）", () => {
  it("任务行操作回调经稳定签名透传：行点击仍选中会话", async () => {
    renderPanel();
    // 项目组内行点击 → URL ?session=<id>（onSelect(session.id) 稳定签名行为回归）
    fireEvent.click(await screen.findByText("调研竞品"));
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/module/ai?session=22",
      ),
    );
  });
});

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

  it("组名区点击 → 折叠/展开组内容（与空间组同构，不进项目页）；⋯ 菜单「进入项目」进项目页", async () => {
    renderPanel();
    // 组名区（可及名=组名）点击折叠：0fr + invisible，不导航
    const nameButton = await screen.findByRole("button", {
      name: "北斗官网",
    });
    fireEvent.click(nameButton);
    const groupBody = await waitFor(() => {
      const el = document.getElementById("project-group-11");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(groupBody.style.gridTemplateRows).toBe("0fr");
    expect(groupBody.className).toContain("invisible");
    expect(screen.getByTestId("location").textContent).toBe("/module/ai");

    // 再点展开恢复（1fr + 可见）
    fireEvent.click(screen.getByRole("button", { name: "北斗官网" }));
    await waitFor(() => {
      const el = document.getElementById("project-group-11") as HTMLElement;
      expect(el.style.gridTemplateRows).toBe("1fr");
      expect(el.className).not.toContain("invisible");
    });

    // 进项目页入口在 ⋯ 菜单（组名点击不再直达）
    await openProjectMenu();
    await clickMenuItem("project:sidebar.enterProject");
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/module/project/11",
      ),
    );
  });
});

describe("SessionTreePanel 已归档分组（归档可查看只读）", () => {
  it("归档会话进「已归档」分组（默认收起，展开可见行），正常组不含归档", async () => {
    sessionApiMock.listAll.mockResolvedValue([
      ...SESSIONS,
      session({
        id: 77,
        title: "旧任务归档",
        archivedAt: "2026-09-25T00:00:00.000Z",
      }),
    ]);
    renderPanel();
    // 分组头带计数（t 直返 key）
    expect(
      await screen.findByText(/chat:sidebar.archivedGroup \(1\)/),
    ).toBeTruthy();
    // 分组默认收起：内容常驻 DOM（grid-rows 动画）但 0fr + invisible
    const groupEl = document.getElementById("archived-group") as HTMLElement;
    expect(groupEl.style.gridTemplateRows).toBe("0fr");
    expect(groupEl.className).toContain("invisible");
    // 展开分组：归档行可见
    fireEvent.click(
      screen.getByRole("button", { name: /chat:sidebar.archivedGroup/ }),
    );
    await waitFor(() => {
      const el = document.getElementById("archived-group") as HTMLElement;
      expect(el.style.gridTemplateRows).toBe("1fr");
    });
    expect(screen.getByText("旧任务归档")).toBeTruthy();
  });

  it("归档行点击进入会话（?session=），hover 恢复钮调用取消归档", async () => {
    sessionApiMock.listAll.mockResolvedValue([
      ...SESSIONS,
      session({
        id: 77,
        title: "旧任务归档",
        archivedAt: "2026-09-25T00:00:00.000Z",
      }),
    ]);
    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: /chat:sidebar.archivedGroup/ }),
    );
    fireEvent.click(await screen.findByText("旧任务归档"));
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/module/ai?session=77",
      ),
    );
    // 恢复钮：unarchive 调用（SessionApi.archive(id, false)）
    const restore = await screen.findByRole("button", {
      name: "chat:task.restore",
    });
    sessionApiMock.archive.mockResolvedValue(undefined);
    fireEvent.click(restore);
    await waitFor(() =>
      expect(sessionApiMock.archive).toHaveBeenCalledWith(77, false),
    );
  });
});

describe("SessionTreePanel 主窗→文件窗跳转（spec §19 项 1）", () => {
  const MAP_KEY = "tianshu-file-window-session-map";

  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockReset().mockResolvedValue(undefined);
  });

  it("索引命中渲染入口：点击 invoke fileWindow:open 携 resource+sessionId，不触发选中", async () => {
    localStorage.setItem(MAP_KEY, JSON.stringify({ "w:2:docs/a.md": [31] }));
    renderPanel();
    // 4 个会话仅 31 命中 → 全列表恰一个入口（findByRole 多命中即抛）
    const jump = await screen.findByRole("button", {
      name: "chat:fileWindow.openSessionInFileWindow",
    });
    fireEvent.click(jump);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("fileWindow:open", {
        resources: [
          {
            kind: "workspace",
            workspaceId: 2,
            path: "docs/a.md",
            sessionId: 31,
          },
        ],
      }),
    );
    // 点击穿透阻止：URL 无 ?session=（未选中会话）
    expect(screen.getByTestId("location").textContent).toBe("/module/ai");
  });

  it("未命中不渲染入口（无映射时全列表无该钮）", async () => {
    renderPanel();
    await screen.findByText("调研竞品");
    expect(
      screen.queryAllByRole("button", {
        name: "chat:fileWindow.openSessionInFileWindow",
      }),
    ).toHaveLength(0);
  });

  it("invoke 失败：toast mapIpcError 原样透传非码表消息", async () => {
    localStorage.setItem(MAP_KEY, JSON.stringify({ "w:2:docs/a.md": [31] }));
    invokeMock.mockRejectedValue(new Error("窗口打开失败"));
    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "chat:fileWindow.openSessionInFileWindow",
      }),
    );
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("窗口打开失败"),
    );
  });
});

describe("SessionTreePanel 组收缩与吸顶（对齐 WorkBuddy）", () => {
  /** 单空间 7 条会话夹具（默认可见 5 条） */
  const MANY_SESSIONS: SessionRecord[] = Array.from({ length: 7 }, (_, i) =>
    session({ id: 50 + i, title: `任务${i + 1}` }),
  );
  const EXPAND_KEY = "tianshu-sidebar-expand";

  beforeEach(() => {
    localStorage.clear();
  });

  it("组内超默认 5 条截断：前 5 条可见、第 6 条隐藏，组尾渲染「展开更多」", async () => {
    sessionApiMock.listAll.mockResolvedValue(MANY_SESSIONS);
    renderPanel();

    expect(await screen.findByText("任务1")).toBeTruthy();
    expect(screen.getByText("任务5")).toBeTruthy();
    // 截断：第 6/7 条不在 DOM，组尾展开更多行存在
    expect(screen.queryByText("任务6")).toBeNull();
    expect(screen.queryByText("任务7")).toBeNull();
    expect(screen.getByText("chat:sidebar.showMore")).toBeTruthy();
    // 默认态无「收起」
    expect(screen.queryByText("chat:sidebar.showLess")).toBeNull();
  });

  it("点击「展开更多」+20 封顶总数：全显并落盘；「收起」回默认并删记录", async () => {
    sessionApiMock.listAll.mockResolvedValue(MANY_SESSIONS);
    renderPanel();
    fireEvent.click(await screen.findByText("chat:sidebar.showMore"));

    // 7 条全显（5+20 封顶 7），出现「收起」
    expect(await screen.findByText("任务7")).toBeTruthy();
    expect(screen.getByText("chat:sidebar.showLess")).toBeTruthy();
    expect(
      JSON.parse(localStorage.getItem(EXPAND_KEY) ?? "{}").groupVisibleCount,
    ).toEqual({ "w:2": 7 });

    // 收起：回默认 5 条，记录删除（≤ 默认不落盘）
    fireEvent.click(screen.getByText("chat:sidebar.showLess"));
    await waitFor(() => {
      expect(screen.queryByText("任务6")).toBeNull();
    });
    expect(
      JSON.parse(localStorage.getItem(EXPAND_KEY) ?? "{}").groupVisibleCount,
    ).toEqual({});
  });

  it("活跃保底：URL 选中第 6 条会话 → 截断自动扩档，选中行直接可见", async () => {
    sessionApiMock.listAll.mockResolvedValue(MANY_SESSIONS);
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter initialEntries={["/module/ai?session=55"]}>
          <LocationProbe />
          <SessionTreePanel />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // index 5 超默认界 → 活跃保底落盘扩档（5+20 封顶 7）全显
    expect(await screen.findByText("任务6")).toBeTruthy();
    expect(screen.getByText("任务7")).toBeTruthy();
  });

  it("收起在选中会话超界时仍生效（事件落盘，不被渲染派生推翻）", async () => {
    sessionApiMock.listAll.mockResolvedValue(MANY_SESSIONS);
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter initialEntries={["/module/ai?session=55"]}>
          <SessionTreePanel />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // 保底落盘后全显，「收起」可用
    expect(await screen.findByText("chat:sidebar.showLess")).toBeTruthy();

    fireEvent.click(screen.getByText("chat:sidebar.showLess"));

    // 收起生效：回默认 5 条，选中行接受被藏（回归：渲染期保底派生
    // 曾把收起立即推翻，按钮看似不起作用）
    await waitFor(() => {
      expect(screen.queryByText("任务6")).toBeNull();
    });
    expect(screen.getByText("chat:sidebar.showMore")).toBeTruthy();
  });

  it("「空间」标题行在滚动容器外固定：自身无滚动祖先，组头在滚动区内", async () => {
    sessionApiMock.listAll.mockResolvedValue(MANY_SESSIONS);
    renderPanel();
    await screen.findByText("任务1");

    // 顶层「空间」标题行：无 overflow-y-auto 祖先（布局上固定不随滚动）
    const spacesButton = screen.getByText("chat:sidebar.spaces");
    expect(spacesButton.closest(".overflow-y-auto")).toBeNull();
    // 空间组头：在滚动容器内（吸顶滚动）
    const groupButton = screen.getByRole("button", {
      name: "默认工作空间",
    });
    expect(groupButton.closest(".overflow-y-auto")).not.toBeNull();
  });

  it("组折叠态持久化：折叠空间组后落盘，重新挂载保持折叠", async () => {
    sessionApiMock.listAll.mockResolvedValue(MANY_SESSIONS);
    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: "默认工作空间" }),
    );

    await waitFor(() => {
      const groupEl = document.getElementById(
        "workspace-group-2",
      ) as HTMLElement;
      expect(groupEl.style.gridTemplateRows).toBe("0fr");
    });
    expect(
      JSON.parse(localStorage.getItem(EXPAND_KEY) ?? "{}").spaceCollapsed,
    ).toEqual({ "w:2": true });

    // 重新挂载（新组件实例）读回折叠态
    cleanup();
    renderPanel();
    await waitFor(() => {
      const groupEl = document.getElementById(
        "workspace-group-2",
      ) as HTMLElement;
      expect(groupEl.style.gridTemplateRows).toBe("0fr");
    });
  });

  it("吸顶：空间组头挂 sidebar-sticky-header（「空间」区头在滚动容器外不挂）", async () => {
    sessionApiMock.listAll.mockResolvedValue(MANY_SESSIONS);
    renderPanel();
    await screen.findByText("任务1");

    const stickyHeaders = document.querySelectorAll(".sidebar-sticky-header");
    // 空间组头吸顶（本项目夹具无项目组/归档组）；
    // 「空间」区头移出滚动容器固定，不挂 sticky
    expect(stickyHeaders.length).toBe(1);
    const spacesButton = screen.getByText("chat:sidebar.spaces");
    expect(spacesButton.closest(".sidebar-sticky-header")).toBeNull();
  });
});

describe("SessionTreePanel 新建入口（区头 + / 组头 +，参照 WorkBuddy 区头 add-btn）", () => {
  it("「空间」标题行右侧 + ：点击打开新建工作空间对话框", async () => {
    renderPanel();
    const addBtn = await screen.findByRole("button", {
      name: "chat:newWorkspace",
    });
    fireEvent.click(addBtn);
    // 对话框打开（DialogTitle 同 key，出现 role=dialog）
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(sessionApiMock.create).not.toHaveBeenCalled();
  });

  it("空间组头 + ：预选空间并跳「新建任务」详情页，不直接建会话", async () => {
    renderPanel();
    // 空间组 + DOM 序在项目组 + 之前（同名 aria-label 取首个）
    const addTaskBtn = (
      await screen.findAllByRole("button", {
        name: "chat:sidebar.newTaskInWorkspace",
      })
    )[0];
    fireEvent.click(addTaskBtn);
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("/module/ai/new");
    });
    // 目标空间预选进 new-task store；不创建会话（发送时才建）
    expect(useNewTaskStore.getState().workspaceId).toBe(2);
    expect(sessionApiMock.create).not.toHaveBeenCalled();
  });
});

describe("SessionTreePanel 项目组操作（+ 新建 / ⋯ 菜单）", () => {
  it("项目组头悬浮 ⋯：重命名 → 对话框提交调 ProjectApi.update", async () => {
    renderPanel();
    await screen.findByText("北斗官网");
    await openProjectMenu();

    await clickMenuItem("project:hub.menuRename");
    const dialog = await screen.findByRole("dialog");
    const input = dialog.querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "新项目名" } });
    fireEvent.click(within(dialog).getByText("common:confirm"));

    await waitFor(() =>
      expect(projectApiMock.update).toHaveBeenCalledWith({
        id: 11,
        name: "新项目名",
      }),
    );
  });

  it("项目组头悬浮 ⋯：删除 → 确认框调 ProjectApi.remove（级联警示）", async () => {
    renderPanel();
    await screen.findByText("北斗官网");
    await openProjectMenu();

    await clickMenuItem("project:hub.menuDelete");
    expect(await screen.findByText("project:hub.deleteTitle")).toBeTruthy();
    fireEvent.click(screen.getByText("common:confirm"));

    await waitFor(() => expect(projectApiMock.remove).toHaveBeenCalledWith(11));
  });

  it("项目组头 + ：跳项目详情任务页签（?tab=tasks），不直接建会话", async () => {
    renderPanel();
    await screen.findByText("北斗官网");
    fireEvent.click((await screen.findAllByTestId("project-new-session"))[0]);
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/module/project/11?tab=tasks",
      ),
    );
    expect(sessionApiMock.create).not.toHaveBeenCalled();
  });
});

describe("SessionTreePanel 远程主机（HD-A2：远端空间分组树）", () => {
  /** 远端空间夹具（WorkspaceApi.list 远程态经路由化返回远端概要） */
  const REMOTE_WORKSPACES = [
    {
      id: 30,
      name: "远端空间A",
      directoryPath: null,
      defaultModelId: null,
      createdAt: "",
      updatedAt: "",
    },
    {
      id: 31,
      name: "远端空间B",
      directoryPath: null,
      defaultModelId: null,
      createdAt: "",
      updatedAt: "",
    },
  ];
  const REMOTE_GROUPED: SessionRecord[] = [
    session({
      id: 101,
      workspaceId: 30,
      title: "空间A任务",
      projectId: undefined,
    }),
    session({
      id: 102,
      workspaceId: 31,
      title: "空间B任务",
      projectId: undefined,
    }),
    session({
      id: 103,
      workspaceId: 0,
      title: "未归属任务",
      projectId: undefined,
    }),
  ];

  it("远程态：按远端空间分组渲染，未归属会话兜底组不丢", async () => {
    useHostStore.setState({ activeHost: { kind: "remote", connId: "c1" } });
    workspaceApiMock.list.mockResolvedValue(REMOTE_WORKSPACES);
    sessionApiMock.listAll.mockResolvedValue(REMOTE_GROUPED);
    renderPanel();

    // 远端空间组名与会话按 workspaceId 归组
    expect(await screen.findByText("远端空间A")).toBeTruthy();
    expect(await screen.findByText("空间A任务")).toBeTruthy();
    expect(screen.getByText("远端空间B")).toBeTruthy();
    expect(screen.getByText("空间B任务")).toBeTruthy();
    // 未匹配任何远端空间的会话（workspaceId=0）兜底组照常显示（不丢数据）
    expect(screen.getByText("chat:sidebar.unassignedGroup")).toBeTruthy();
    expect(screen.getByText("未归属任务")).toBeTruthy();

    // 本地空间名不出现（数据源已换远端）
    expect(screen.queryByText("默认工作空间")).toBeNull();
    expect(screen.queryByText("在此空间新建任务")).toBeNull();
  });

  it("远程态新建会话：不挂 workspace 直建（远端缺省挂最近空间）", async () => {
    useHostStore.setState({ activeHost: { kind: "remote", connId: "c1" } });
    workspaceApiMock.list.mockResolvedValue(REMOTE_WORKSPACES);
    sessionApiMock.listAll.mockResolvedValue(REMOTE_GROUPED);
    sessionApiMock.create.mockResolvedValue(
      session({ id: 105, title: "新会话" }),
    );
    renderPanel();

    const newBtn = await screen.findByTestId("remote-new-session");
    fireEvent.click(newBtn);

    await waitFor(() => expect(sessionApiMock.create).toHaveBeenCalledWith({}));
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/module/ai?session=105",
      ),
    );
  });

  it("本地态零变化：空间分组如常（远程区不渲染）", async () => {
    renderPanel();
    expect(await screen.findByText("默认工作空间")).toBeTruthy();
    expect(screen.queryByText("chat:sidebar.remoteSessions")).toBeNull();
  });
});

describe("SessionTreePanel 未读角标（P1 尾）", () => {
  it("普通行/项目组内行 title 行尾显未读计数点；≥100 显 99+；零/缺省不显", async () => {
    sessionApiMock.listAll.mockResolvedValue([
      session({ id: 31, title: "三条未读", unreadCount: 3 }),
      session({
        id: 21,
        workspaceId: 30,
        projectId: 11,
        title: "破百未读",
        unreadCount: 150,
      }),
      session({
        id: 22,
        workspaceId: 30,
        projectId: 11,
        title: "零未读",
        unreadCount: 0,
      }),
      session({
        id: 23,
        workspaceId: 40,
        projectId: 99,
        title: "旧数据源无字段",
      }),
    ]);
    renderPanel();

    // 计数点随对应会话行渲染（title 行尾，独立节点断言文本）
    const badges = await screen.findAllByTestId("unread-badge");
    expect(badges.map((b) => b.textContent)).toEqual(["3", "99+"]);
    // 角标挂在标题行内（与 title 同 row，两行结构未破）
    const titleRow = (badges[0] as HTMLElement).parentElement!;
    expect(titleRow.textContent).toContain("三条未读");
    expect(titleRow.textContent).not.toContain("updatedAt");
  });

  it("归档行不显角标（归档分组行独立渲染，unreadCount 非空也不显）", async () => {
    sessionApiMock.listAll.mockResolvedValue([
      session({
        id: 31,
        title: "归档未读",
        archivedAt: "2026-10-20T00:00:00.000Z",
        unreadCount: 7,
      }),
    ]);
    renderPanel();
    // 行本身在「已归档」分组渲染
    expect(await screen.findByText("归档未读")).toBeTruthy();
    expect(screen.queryByTestId("unread-badge")).toBeNull();
  });
});
