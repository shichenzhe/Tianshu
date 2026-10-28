// @vitest-environment jsdom
// HostSwitcher 顶栏主机切换器（HD-T4）：无连接隐藏零打扰；有连接渲染
// 触发钮，菜单列本机+连接（connected 可选/其余禁用）；点击 connected
// 连接切 activeHost 并清 react-query 缓存。
import {
  beforeAll,
  beforeEach,
  afterEach,
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

// Radix DropdownMenu 在 jsdom 的最小桩（popper 定位/pointer capture）
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

const serverApi = vi.hoisted(() => ({ listConnections: vi.fn() }));
/** onRemoteEvent 捕获池：用例触发 server.connected 断言失效重取 */
const remoteEventListeners = new Map<string, Array<(event: unknown) => void>>();
vi.mock("../../../src-react/domains/ai/server/api/server.api", () => ({
  default: serverApi,
  requestRemote: vi.fn(),
  LOCAL_CONNECTION_ID: "local",
  newConnectionId: vi.fn(() => "conn-x"),
  on: () => () => {},
  onRemoteChunk: () => () => {},
  onRemoteEvent: (connId: string, listener: (event: unknown) => void) => {
    const arr = remoteEventListeners.get(connId) ?? [];
    arr.push(listener);
    remoteEventListeners.set(connId, arr);
    return () => {
      const cur = remoteEventListeners.get(connId) ?? [];
      const i = cur.indexOf(listener);
      if (i >= 0) cur.splice(i, 1);
    };
  },
}));

import HostSwitcher from "../../../src-react/domains/ai/layout/components/HostSwitcher";
import {
  useHostStore,
  LOCAL_HOST_CAPS,
} from "../../../src-react/domains/ai/data-source/host.store";

/** 位置探针：主机配置入口导航断言 */
function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">{`${location.pathname}${location.search}`}</div>
  );
}

function renderSwitcher() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { container } = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/module/ai"]}>
        <LocationProbe />
        <HostSwitcher />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { client, container };
}

/** radix 触发钮展开（pointerDown 需 pointerType mouse + ctrlKey false） */
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

const conn = (id: string, state: string, name = id) => ({
  id,
  name,
  mode: "direct" as const,
  state,
  capabilities: state === "connected" ? ["chat", "provider"] : [],
});

beforeEach(() => {
  vi.clearAllMocks();
  remoteEventListeners.clear();
  useHostStore.setState({
    activeHost: { kind: "local" },
    caps: LOCAL_HOST_CAPS,
  });
});
afterEach(cleanup);

describe("HostSwitcher", () => {
  it("无连接也常驻（HD-P3c）：菜单含本机与「主机配置」入口（新用户可达配置页）", async () => {
    serverApi.listConnections.mockResolvedValue({
      activeConnId: null,
      connections: [],
    });
    renderSwitcher();

    const trigger = await screen.findByTestId("host-switcher");
    expect(trigger.textContent).toContain("layout:hostSwitcher.local");

    openMenu(trigger);
    expect(
      await screen.findByRole("menuitem", {
        name: "layout:hostSwitcher.local",
      }),
    ).toBeTruthy();
    // 主机配置入口常驻（无连接时是唯一动作入口）
    const manage = await screen.findByRole("menuitem", {
      name: "layout:hostSwitcher.manage",
    });
    fireEvent.click(manage);
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/module/ai/server",
      ),
    );
  });

  it("有连接：触发钮常驻；菜单列本机+连接，非 connected 项禁用", async () => {
    serverApi.listConnections.mockResolvedValue({
      activeConnId: null,
      connections: [
        conn("c1", "connected", "公司无头端"),
        conn("c2", "idle", "家中桌面"),
      ],
    });
    renderSwitcher();

    const trigger = await screen.findByTestId("host-switcher");
    // 本机激活态：触发钮显示本机名
    expect(trigger.textContent).toContain("layout:hostSwitcher.local");

    openMenu(trigger);
    // 菜单项经 role 查询（触发钮与本机项同文本「本机」，text 查询会多命中）
    const localItem = await screen.findByRole("menuitem", {
      name: "layout:hostSwitcher.local",
    });
    expect(
      await screen.findByRole("menuitem", { name: "公司无头端" }),
    ).toBeDefined();

    // idle 连接禁用（未连通不可切——数据面拉不动）
    const idleItem = await screen.findByRole("menuitem", { name: "家中桌面" });
    expect(idleItem.getAttribute("aria-disabled")).toBe("true");
    expect(localItem).toBeDefined();
  });

  it("点击 connected 连接：activeHost 切远程 + react-query 缓存清空", async () => {
    serverApi.listConnections.mockResolvedValue({
      activeConnId: null,
      connections: [conn("c1", "connected", "公司无头端")],
    });
    const client = renderSwitcher().client;
    // 预置一条任意 query 缓存：切换后应被清
    client.setQueryData(["host", "probe"], "stale");

    const trigger = await screen.findByTestId("host-switcher");
    openMenu(trigger);
    const item = await screen.findByRole("menuitem", { name: "公司无头端" });
    fireEvent.click(item);

    await waitFor(() =>
      expect(useHostStore.getState().activeHost).toEqual({
        kind: "remote",
        connId: "c1",
      }),
    );
    // 缓存清空：probe 缓存不复存在
    await waitFor(() =>
      expect(client.getQueryData(["host", "probe"])).toBeUndefined(),
    );
  });

  it("caps 自注册表上报回填（chat 开/files 关）", async () => {
    serverApi.listConnections.mockResolvedValue({
      activeConnId: null,
      connections: [conn("c1", "connected", "公司无头端")],
    });
    renderSwitcher();

    const trigger = await screen.findByTestId("host-switcher");
    openMenu(trigger);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "公司无头端" }),
    );

    await waitFor(() => expect(useHostStore.getState().caps.chat).toBe(true));
    expect(useHostStore.getState().caps.files).toBe(false);
  });

  it("远程主机重连（server.connected）：会话/消息缓存失效重取（壳退役承接）", async () => {
    serverApi.listConnections.mockResolvedValue({
      activeConnId: null,
      connections: [conn("c1", "connected", "公司无头端")],
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/module/ai"]}>
          <HostSwitcher />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const trigger = await screen.findByTestId("host-switcher");
    openMenu(trigger);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "公司无头端" }),
    );

    // 切远程后订阅该连接的合并事件通道
    await waitFor(() =>
      expect(remoteEventListeners.get("c1")?.length).toBeGreaterThan(0),
    );
    remoteEventListeners.get("c1")?.forEach((listener) =>
      listener({
        type: "server.connected",
        payload: { instanceId: "i-1", capabilities: ["chat"] },
      }),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["sessions"],
      }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["messages"] });
    // 本地主机不订阅
    expect(remoteEventListeners.size).toBe(1);
  });
});
