// @vitest-environment jsdom
// HostSwitcher 顶栏主机切换器（HD-T4）：无连接隐藏零打扰；有连接渲染
// 触发钮，菜单列本机+连接；点击 connected 连接切 activeHost 并清
// react-query 缓存。切换即连（2026-11-10）：非 connected 项可点——
// activate 建链 → 轮询等 connected 再切；invalid-token 失败 toast 不切。
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

const serverApi = vi.hoisted(() => ({
  listConnections: vi.fn(),
  activateConnection: vi.fn(),
}));
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
import { hostScopedQueryHash } from "../../../src-react/domains/ai/data-source/host-query";

/** 位置探针：主机配置入口导航断言 */
function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">{`${location.pathname}${location.search}`}</div>
  );
}

function renderSwitcher(compact?: boolean) {
  // 与 main.tsx 同款装配：queryKeyHashFn 按主机隔离（批3B）
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, queryKeyHashFn: hostScopedQueryHash },
    },
  });
  const { container } = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/module/ai"]}>
        <LocationProbe />
        <HostSwitcher compact={compact} />
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

  it("有连接：触发钮常驻；菜单列本机+连接，idle 项可点（切换即连）", async () => {
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

    // idle 连接可点（切换即连批：不再禁用——点击触发 activate）
    const idleItem = await screen.findByRole("menuitem", { name: "家中桌面" });
    expect(idleItem.getAttribute("aria-disabled")).not.toBe("true");
    expect(localItem).toBeDefined();
  });

  it("切换即连：点击 idle 连接 → activate 建链 → 轮询 connected 后自动切远程", async () => {
    // 首次拉取 idle；点击后轮询拉取 connected（refetchInterval 加速）
    serverApi.listConnections
      .mockResolvedValueOnce({
        activeConnId: null,
        connections: [conn("c2", "idle", "家中桌面")],
      })
      .mockResolvedValue({
        activeConnId: "c2",
        connections: [conn("c2", "connected", "家中桌面")],
      });
    serverApi.activateConnection.mockResolvedValue(undefined);
    renderSwitcher();

    const trigger = await screen.findByTestId("host-switcher");
    openMenu(trigger);
    fireEvent.click(await screen.findByRole("menuitem", { name: "家中桌面" }));

    // 点击即触发激活（不要求已连接）
    await waitFor(() =>
      expect(serverApi.activateConnection).toHaveBeenCalledWith("c2"),
    );
    // 连上后自动切换
    await waitFor(() =>
      expect(useHostStore.getState().activeHost).toEqual({
        kind: "remote",
        connId: "c2",
      }),
    );
  });

  it("切换即连失败：activate 后 state=invalid-token → 不切换", async () => {
    serverApi.listConnections.mockResolvedValue({
      activeConnId: null,
      connections: [conn("c2", "invalid-token", "坏令牌主机")],
    });
    serverApi.activateConnection.mockResolvedValue(undefined);
    renderSwitcher();

    const trigger = await screen.findByTestId("host-switcher");
    openMenu(trigger);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "坏令牌主机" }),
    );

    await waitFor(() =>
      expect(serverApi.activateConnection).toHaveBeenCalledWith("c2"),
    );
    // 失败终态：不切换（activeHost 保持本机），等待清空（可再点）
    await waitFor(() =>
      expect(useHostStore.getState().activeHost).toEqual({ kind: "local" }),
    );
  });

  it("点击 connected 连接：activeHost 切远程；同 key 缓存按主机隔离且回切保留", async () => {
    serverApi.listConnections.mockResolvedValue({
      activeConnId: null,
      connections: [conn("c1", "connected", "公司无头端")],
    });
    const client = renderSwitcher().client;
    // 预置一条任意 query 缓存：切换后同 key 在远程主机下不可见（隔离），
    // 但本机主机的缓存保留（回切秒开——批3B 不再全清）
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
    expect(client.getQueryData(["host", "probe"])).toBeUndefined();

    // 回切本机：缓存原地可见
    openMenu(trigger);
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "layout:hostSwitcher.local",
      }),
    );
    await waitFor(() =>
      expect(useHostStore.getState().activeHost).toEqual({ kind: "local" }),
    );
    expect(client.getQueryData(["host", "probe"])).toBe("stale");
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

describe("HostSwitcher 名称截断与冒泡提示（Logo 行挪位批）", () => {
  const LONG_NAME = "非常长非常长的远程主机名称示例ABCDEFG";

  beforeEach(() => {
    serverApi.listConnections.mockResolvedValue({
      connections: [conn("remote-long", "connected", LONG_NAME)],
    });
    useHostStore.setState({
      activeHost: { kind: "remote", connId: "remote-long" },
    });
  });

  it("默认形态（顶栏位）：名称 span max-w-28 truncate", async () => {
    renderSwitcher();
    const nameSpan = await screen.findByText(LONG_NAME);
    expect(nameSpan.classList).toContain("max-w-28");
    expect(nameSpan.classList).toContain("truncate");
  });

  it("compact 形态（侧栏 Logo 行位）：名称 span 收紧 max-w-16", async () => {
    renderSwitcher(true);
    const nameSpan = await screen.findByText(LONG_NAME);
    expect(nameSpan.classList).toContain("max-w-16");
    expect(nameSpan.classList).toContain("truncate");
  });

  it("冒泡提示：聚焦触发钮显示完整主机名（名称被截断时可看全称）", async () => {
    renderSwitcher(true);
    const trigger = await screen.findByTestId("host-switcher");
    fireEvent.focus(trigger);
    await waitFor(() => {
      const tip = document.querySelector('[role="tooltip"]');
      expect(tip?.textContent).toContain(LONG_NAME);
    });
  });
});
