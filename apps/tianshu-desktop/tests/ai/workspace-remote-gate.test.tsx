// @vitest-environment jsdom
// 远程主机态 workspace 本地通道入口门控（2026-11-09 批）：
// - WorkspacePickerMenu：空间选择路由化可用保留；「新建空间/打开本地
//   空间」走本地 invoke（远程态点击打到控制端本地库，id 撞库可静默
//   错绑）——远程态隐藏两个入口，本地态照常渲染
// - WorkspacePathChip：重绑/解绑同为本地通道——远程态整个 chip 不渲染
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

vi.mock("@/lib/ipc", () => ({
  invoke: vi.fn(),
  on: () => () => {},
}));

const workspaceApi = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../src-react/domains/ai/api/workspace.api", () => ({
  default: workspaceApi,
}));

import WorkspacePickerMenu from "../../src-react/domains/ai/new-task/components/WorkspacePickerMenu";
import WorkspacePathChip from "../../src-react/domains/ai/chat/components/WorkspacePathChip";
import { useHostStore } from "../../src-react/domains/ai/data-source/host.store";

const BOUND_WORKSPACE = {
  id: 3,
  name: "远端空间",
  directoryPath: "/Users/b/proj",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as never;

function renderWithProviders(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

beforeEach(() => {
  useHostStore.setState({
    activeHost: { kind: "local" },
    caps: useHostStore.getState().caps,
  });
  workspaceApi.list.mockResolvedValue([BOUND_WORKSPACE]);
});

describe("WorkspacePickerMenu 远程态门控", () => {
  /** Radix Popover 关闭态不渲染面板——先点开触发钮再断言菜单项 */
  async function openMenu() {
    fireEvent.click(
      screen.getByRole("button", { name: "newTask:context.workspace" }),
    );
    await screen.findByPlaceholderText("newTask:context.searchWorkspace");
  }

  it("本地主机态渲染「新建空间/打开本地空间」入口", async () => {
    renderWithProviders(<WorkspacePickerMenu />);
    await openMenu();
    expect(screen.getByText("newTask:context.newWorkspace")).toBeTruthy();
    expect(screen.getByText("newTask:context.openLocal")).toBeTruthy();
  });

  it("远程主机态：新建空间已路由化可用；打开本地隐藏（本地 invoke 通道防误触）", async () => {
    useHostStore.setState({
      activeHost: { kind: "remote", connId: "c1" },
    });
    renderWithProviders(<WorkspacePickerMenu />);
    await openMenu();
    expect(screen.getByText("newTask:context.newWorkspace")).toBeTruthy();
    expect(screen.queryByText("newTask:context.openLocal")).toBeNull();
    // 空间列表本体不受门控影响（远端空间照常可选——异步查询 waitFor）
    await waitFor(() => {
      expect(screen.getByText("远端空间")).toBeTruthy();
    });
  });
});

describe("WorkspacePathChip 远程态门控", () => {
  it("本地主机态渲染绑定路径 chip", () => {
    renderWithProviders(<WorkspacePathChip workspace={BOUND_WORKSPACE} />);
    expect(screen.getByRole("button")).toBeTruthy();
  });

  it("远程主机态整个 chip 不渲染（重绑/解绑是本地通道）", () => {
    useHostStore.setState({
      activeHost: { kind: "remote", connId: "c1" },
    });
    const { container } = renderWithProviders(
      <WorkspacePathChip workspace={BOUND_WORKSPACE} />,
    );
    expect(container.innerHTML).toBe("");
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
