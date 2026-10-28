// @vitest-environment jsdom
/**
 * ProjectHubView 项目列表页测试（jsdom + testing-library，mock 骨架同
 * tests/project/create-project-dialog.test.tsx，t 直接返回 key；
 * ProjectApi/useUserStore 以模块级 mock 替代，MemoryRouter 内渲染并以
 * 占位路由承接 /module/project/:projectId 供导航断言）：
 * - 搜索：输入 al → 仅剩 alpha 卡片（客户端 name 过滤，大小写不敏感）
 * - 导航：点击项目卡片 → 进入 /module/project/:projectId
 * - 空状态：list 为空 → 渲染 project:hub.empty
 * - 重命名：卡片「...」菜单 → Dialog 预填原名 → update + invalidate + toast
 * - 删除：卡片「...」菜单 → AlertDialog 二次确认 → remove + invalidate + toast
 * - 模版：点击模版卡 → CreateProjectDialog 以 presetTemplateKey 打开
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
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";

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
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

// @/i18n 最小桩（同 tests/ai/chat-view-edit-optimistic.test.tsx）：
// ProjectCard 相对时间经 getDateFnsLocale 取 locale
vi.mock("@/i18n", async () => {
  const { zhCN: locale } = await import("date-fns/locale");
  return {
    default: { t: (key: string) => key },
    getDateFnsLocale: () => locale,
  };
});

vi.mock("@/domains/project/api/project.api", () => ({
  default: { list: vi.fn(), update: vi.fn(), remove: vi.fn() },
}));
vi.mock("@/domains/user/store/user.store", () => ({
  useUserStore: (selector?: (state: { user: { id: number } }) => unknown) =>
    selector ? selector({ user: { id: 1 } }) : { user: { id: 1 } },
}));

// CreateProjectDialog 已有专属测试（create-project-dialog.test.tsx），
// hub 测试聚焦列表页自身：mock 为 null 并捕获 props 断言打开/预选模版
const createDialogMock = vi.hoisted(() => vi.fn(() => null));
vi.mock(
  "../../src-react/domains/project/components/CreateProjectDialog",
  () => ({ default: createDialogMock }),
);

import ProjectHubView from "../../src-react/domains/project/views/ProjectHubView";
import ProjectApi from "@/domains/project/api/project.api";
import { getTemplate } from "../../src-react/domains/project/model/project-templates";
import type { ProjectRecord } from "../../../electron/domains/project/project.entity";

function recordOf(
  id: number,
  name: string,
  templateKey: string | null,
): ProjectRecord {
  return {
    id,
    name,
    systemPrompt: null,
    templateKey,
    ownerId: 1,
    sessionId: id + 100,
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
  };
}

const ALPHA = recordOf(1, "alpha", null);
const BETA = recordOf(2, "beta", "prd-workflow");
const PRD = getTemplate("prd-workflow")!;

/** 工作台占位路由：渲染 projectId 供导航断言 */
function WorkspaceStub() {
  const { projectId } = useParams();
  return <div>{`workspace-stub:${projectId}`}</div>;
}

/** 渲染 hub（MemoryRouter + 占位工作台路由），返回 client 供 invalidate 断言 */
function renderHub(list: ProjectRecord[]) {
  vi.mocked(ProjectApi.list).mockResolvedValue(list);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/module/project"]}>
        <Routes>
          <Route path="/module/project" element={<ProjectHubView />} />
          <Route
            path="/module/project/:projectId"
            element={<WorkspaceStub />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

/** 展开第 index 张卡片的「...」菜单（Radix：pointerDown 展开，click 选中） */
function openCardMenu(index: number) {
  fireEvent.pointerDown(
    screen.getAllByRole("button", { name: "common:operation" })[index],
  );
}

beforeEach(() => {
  vi.mocked(ProjectApi.list).mockReset().mockResolvedValue([ALPHA, BETA]);
  vi.mocked(ProjectApi.update).mockReset().mockResolvedValue(undefined);
  vi.mocked(ProjectApi.remove).mockReset().mockResolvedValue(undefined);
  createDialogMock.mockClear();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

afterEach(cleanup);

describe("我的项目", () => {
  it("搜索框输入 al → 只剩 alpha 卡片", async () => {
    renderHub([ALPHA, BETA]);
    await waitFor(() => expect(screen.getByText("beta")).toBeTruthy());

    fireEvent.change(
      screen.getByPlaceholderText("project:hub.searchPlaceholder"),
      { target: { value: "al" } },
    );

    await waitFor(() => expect(screen.queryByText("beta")).toBeNull());
    expect(screen.getByText("alpha")).toBeTruthy();
  });

  it("点击项目卡片 → navigate 到 /module/project/1", async () => {
    renderHub([ALPHA, BETA]);
    fireEvent.click(await screen.findByText("alpha"));
    expect(await screen.findByText("workspace-stub:1")).toBeTruthy();
  });

  it("无项目 → 渲染空状态文案", async () => {
    renderHub([]);
    expect(await screen.findByText("project:hub.empty")).toBeTruthy();
  });

  it("重命名 → Dialog 预填原名，确定后 update + invalidate + toast", async () => {
    const client = renderHub([ALPHA, BETA]);
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    await screen.findByText("alpha");

    openCardMenu(0);
    fireEvent.click(screen.getByText("project:hub.menuRename"));

    const dialog = await screen.findByRole("dialog", {
      name: "project:hub.menuRename",
    });
    fireEvent.change(within(dialog).getByDisplayValue("alpha"), {
      target: { value: "alpha-2" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "common:confirm" }),
    );

    await waitFor(() =>
      expect(ProjectApi.update).toHaveBeenCalledWith({
        id: 1,
        name: "alpha-2",
      }),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["projects"] }),
    );
    expect(toastMock.success).toHaveBeenCalledWith("project:toast.renamed");
  });

  it("删除 → AlertDialog 二次确认后 remove + invalidate + toast", async () => {
    const client = renderHub([ALPHA, BETA]);
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    await screen.findByText("alpha");

    openCardMenu(0);
    fireEvent.click(screen.getByText("project:hub.menuDelete"));

    const confirmDialog = await screen.findByRole("alertdialog", {
      name: "project:hub.deleteTitle",
    });
    expect(
      within(confirmDialog).getByText(/project:hub.deleteDesc/),
    ).toBeTruthy();
    fireEvent.click(
      within(confirmDialog).getByRole("button", { name: "common:confirm" }),
    );

    await waitFor(() => expect(ProjectApi.remove).toHaveBeenCalledWith(1));
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["projects"] }),
    );
    expect(toastMock.success).toHaveBeenCalledWith("project:toast.deleted");
  });
});

describe("从模版创建", () => {
  it("点击模版卡 → CreateProjectDialog 以对应 presetTemplateKey 打开", async () => {
    renderHub([]);
    await screen.findByText("project:hub.empty");

    fireEvent.click(screen.getByText(PRD.name));

    // React 19 以两个实参调用函数组件（props + 内部参数），不能按
    // toHaveBeenLastCalledWith 断言元数，取末次调用首参做子集匹配
    expect(createDialogMock.mock.calls.at(-1)?.[0]).toMatchObject({
      open: true,
      presetTemplateKey: PRD.key,
    });
  });
});
