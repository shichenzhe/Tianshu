// @vitest-environment jsdom
// T17「服务端」控制台页骨架与连接管理：
// - ServerConsoleView 渲染：标题经 usePageHeader 迁入 TopBar 中段
//   （页内不画标题行）+ 连接列表空态 + 「添加连接」按钮
// - 添加对话框必填校验：空名称/非法地址拒绝提交并显示错误；合法表单
//   保存走 server:connectionSave（信封 mock，id 避开 ":"）
// - relay 模式字段面与必填校验
// - 连接行渲染：状态点配色/local 标签；删除走 server:connectionDelete
// - 本地无头端卡：localStatus 驱动启停按钮态，start 携带目录；打包态
//   （status.packaged）目录输入不渲染且空目录直连启动（PK 终审 F3）
// mock @/lib/ipc（invoke/on），i18n 未初始化时 t() 回退 key——断言锚
// data-testid 与 key 文本，不锚翻译文案
import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";

// Radix Select/Dialog 在 jsdom 的最小桩（先例 create-task-project.test.tsx）
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

// localStorage stub：本地无头端目录记忆读写，测试环境无原生 localStorage
// （先例 tests/ai/prompt-chips.test.tsx）
vi.hoisted(() => {
  const memory = new Map<string, string>();
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => void memory.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
});

const { invoke, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(),
  // 通道多监听器（真实 ipcRenderer.on 语义——面板与视图可同时订阅同通道）
  listeners: new Map<string, Array<(...args: unknown[]) => void>>(),
}));
vi.mock("@/lib/ipc", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    const arr = listeners.get(channel) ?? [];
    arr.push(listener);
    listeners.set(channel, arr);
    return () => {
      const cur = listeners.get(channel) ?? [];
      const index = cur.indexOf(listener);
      if (index >= 0) cur.splice(index, 1);
    };
  },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// 组件树某引入链会真初始化 @/i18n（渲染真翻译文案），mock useTranslation
// 锚 key 文本保持断言稳定（先例 create-task-project.test.tsx）
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
      i18n: { language: "zh-CN" },
    }),
  };
});

import ServerConsoleView from "../../../src-react/domains/ai/server/views/ServerConsoleView";
import ConnectionList from "../../../src-react/domains/ai/server/components/ConnectionList";
import { usePageHeaderStore } from "../../../src-react/components/layout/page-header.store";

const EMPTY_LIST = { activeConnId: null, connections: [] };
const LOCAL_STOPPED = {
  running: false,
  state: "stopped",
  port: null,
  instanceId: null,
  packaged: false,
};
/** 本机被控面默认关闭态（LocalFaceCard 渲染消费） */
const FACE_OFF = {
  enabled: false,
  running: false,
  port: 18411,
  host: "127.0.0.1",
  token: "",
  relayUrl: "",
  relayToken: "",
  relayConnected: false,
  instanceId: "face-1",
};

/** invoke 分发：按通道返回 fixture（连接清单/本地状态默认空态） */
function stubInvoke(handlers: Record<string, unknown> = {}): void {
  invoke.mockImplementation((channel: string, ...args: unknown[]) => {
    if (channel in handlers) {
      const value = handlers[channel];
      return typeof value === "function" ? value(...args) : value;
    }
    if (channel === "server:connectionList") return EMPTY_LIST;
    if (channel === "server:localStatus") return LOCAL_STOPPED;
    if (channel === "serverFace:status") return FACE_OFF;
    throw new Error(`未 mock 的通道：${channel}`);
  });
}

function renderView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ServerConsoleView />
    </QueryClientProvider>,
  );
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

beforeEach(() => {
  cleanup();
  invoke.mockReset();
  listeners.clear();
  // 目录记忆跨用例清空（内存 stub 无自动隔离——上一用例成功启动会把
  // 目录写入 localStorage，污染下一用例的初值）
  localStorage.clear();
  stubInvoke();
});

describe("ServerConsoleView 骨架与连接管理", () => {
  it("空态：连接列表空态 + 「添加连接」按钮", async () => {
    renderView();
    expect(await screen.findByTestId("add-connection")).toBeTruthy();
    expect(await screen.findByText("ai:server.connection.empty")).toBeTruthy();
  });

  it("连接行：状态点/local 标签渲染", async () => {
    stubInvoke({
      "server:connectionList": {
        activeConnId: "local",
        connections: [
          {
            id: "local",
            name: "本地无头端",
            mode: "direct",
            baseUrl: "http://127.0.0.1:3000",
            local: true,
            state: "connected",
            capabilities: ["chat"],
          },
          {
            id: "c2",
            name: "远程桌面",
            mode: "relay",
            relayUrl: "ws://127.0.0.1:18412/ws",
            relayToken: "rt",
            connectionId: "desk-1",
            state: "invalid-token",
            capabilities: [],
          },
        ],
      },
    });
    renderView();
    expect(await screen.findByTestId("connection-local")).toBeTruthy();
    expect(screen.getByTestId("connection-c2")).toBeTruthy();
    expect(screen.getByTestId("connection-dot-local").className).toContain(
      "bg-primary",
    );
    expect(screen.getByTestId("connection-dot-c2").className).toContain(
      "bg-destructive",
    );
    expect(screen.getByText("ai:server.connection.localTag")).toBeTruthy();
  });

  it("server.connected 重连事件：连接清单即时 refetch（spec §13 项 2）", async () => {
    stubInvoke({
      "server:connectionList": {
        activeConnId: "local",
        connections: [
          {
            id: "local",
            name: "本地无头端",
            mode: "direct",
            baseUrl: "http://127.0.0.1:3000",
            local: true,
            state: "connected",
            capabilities: ["chat"],
          },
        ],
      },
    });
    renderView();
    await screen.findByTestId("connection-local");
    // selectedConnId 粘性活动连接后挂订阅：HD-P2c 会话遥控壳退役后仅
    // 本视图一条（数据到达 → effect 置选中 → 本视图订阅）
    await waitFor(() =>
      expect(
        listeners.get("server:event:local")?.length,
      ).toBeGreaterThanOrEqual(1),
    );
    const callsBefore = invoke.mock.calls.filter(
      (c) => c[0] === "server:connectionList",
    ).length;
    // 重连合成帧经合并通道下发（全部订阅者）→ invalidate 重取连接清单
    for (const fn of listeners.get("server:event:local") ?? []) {
      fn(undefined, {
        type: "server.connected",
        payload: { instanceId: "i-1", capabilities: ["chat"] },
      });
    }
    await waitFor(() => {
      const callsAfter = invoke.mock.calls.filter(
        (c) => c[0] === "server:connectionList",
      ).length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });
  });

  it("添加对话框：空名称/非法地址拒绝提交；合法表单保存走 connectionSave", async () => {
    renderView();
    fireEvent.click(await screen.findByTestId("add-connection"));
    // 空名称直接拒绝
    fireEvent.click(await screen.findByTestId("conn-save"));
    expect(await screen.findByTestId("conn-error")).toBeTruthy();
    expect(
      invoke.mock.calls.some((c) => c[0] === "server:connectionSave"),
    ).toBe(false);
    // 名字有、地址空/非法：仍拒绝
    fireEvent.change(screen.getByTestId("conn-name"), {
      target: { value: "远端" },
    });
    fireEvent.click(screen.getByTestId("conn-save"));
    expect(await screen.findByTestId("conn-error")).toBeTruthy();
    fireEvent.change(screen.getByTestId("conn-base-url"), {
      target: { value: "notaurl" },
    });
    fireEvent.click(screen.getByTestId("conn-save"));
    expect(await screen.findByTestId("conn-error")).toBeTruthy();
    // 合法 direct 表单 → 保存（baseUrl 尾斜杠归一；id 避开 ":"）
    stubInvoke({ "server:connectionSave": EMPTY_LIST });
    fireEvent.change(screen.getByTestId("conn-base-url"), {
      target: { value: "http://127.0.0.1:3000/" },
    });
    fireEvent.click(screen.getByTestId("conn-save"));
    await waitFor(() => {
      const call = invoke.mock.calls.find(
        (c) => c[0] === "server:connectionSave",
      );
      expect(call).toBeTruthy();
      const [, config] = call as [string, Record<string, unknown>];
      expect(config.name).toBe("远端");
      expect(config.mode).toBe("direct");
      expect(config.baseUrl).toBe("http://127.0.0.1:3000");
      expect(String(config.id)).not.toContain(":");
    });
  });

  it("relay 模式：切换后校验 relayToken/connectionId 必填", async () => {
    renderView();
    fireEvent.click(await screen.findByTestId("add-connection"));
    await selectOption(
      screen.getByTestId("conn-mode"),
      "ai:server.connection.modeRelay",
    );
    expect(screen.getByTestId("conn-relay-url")).toBeTruthy();
    fireEvent.change(screen.getByTestId("conn-relay-url"), {
      target: { value: "ws://127.0.0.1:18412/ws" },
    });
    fireEvent.click(screen.getByTestId("conn-save"));
    expect(await screen.findByTestId("conn-error")).toBeTruthy();
  });

  it("删除连接走 server:connectionDelete", async () => {
    stubInvoke({
      "server:connectionList": {
        activeConnId: "c2",
        connections: [
          {
            id: "c2",
            name: "远程桌面",
            mode: "relay",
            relayUrl: "ws://x/ws",
            relayToken: "rt",
            connectionId: "d",
            state: "idle",
            capabilities: [],
          },
        ],
      },
      "server:connectionDelete": EMPTY_LIST,
    });
    renderView();
    const row = await screen.findByTestId("connection-c2");
    const deleteButton = row.querySelector(
      'button[aria-label="ai:server.connection.delete"]',
    ) as HTMLButtonElement;
    expect(deleteButton).toBeTruthy();
    fireEvent.click(deleteButton);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("server:connectionDelete", "c2");
    });
  });

  it("本地无头端卡已删（HD-P3e 单机分体场景退役）：不渲染不查询", async () => {
    stubInvoke({ "server:connectionList": EMPTY_LIST });
    renderView();
    await screen.findByTestId("add-connection");
    // 卡整体不渲染；localStatus 查询不发（单 UI 本地主机直达，本机跑
    // 无头端属开发场景——启停通道保留经 IPC/脚本可达）
    expect(screen.queryByTestId("local-state")).toBeNull();
    expect(screen.queryByTestId("local-dir")).toBeNull();
    expect(invoke.mock.calls.some((c) => c[0] === "server:localStatus")).toBe(
      false,
    );
  });
});

describe("顶行注册（TopBar 中段）", () => {
  it("挂载即注册标题、卸载清空（页内不再画标题行，漏注册则 TopBar 中段整块空白）", async () => {
    const { unmount } = renderView();
    await screen.findByTestId("add-connection");
    // 标题经 usePageHeader 写入 TopBar 插槽（t 回退 key 断言锚）
    expect(usePageHeaderStore.getState().slot?.title?.props.children).toBe(
      "ai:server.pageTitle",
    );
    unmount();
    expect(usePageHeaderStore.getState().slot).toBeNull();
  });
});

describe("ConnectionList 删除收尾选中回退", () => {
  function conn(id: string) {
    return {
      id,
      name: `连接 ${id}`,
      mode: "direct" as const,
      baseUrl: `http://127.0.0.1:3000/${id}`,
      state: "connected" as const,
      capabilities: [],
    };
  }

  /** 直渲染 ConnectionList：清单随删除通道变化，onSelect 观察选中回退 */
  function renderList(selected: string | null, onSelect: (id: string) => void) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={client}>
        <ConnectionList selectedConnId={selected} onSelect={onSelect} />
      </QueryClientProvider>,
    );
  }

  function clickDelete(row: HTMLElement): void {
    const button = row.querySelector(
      'button[aria-label="ai:server.connection.delete"]',
    ) as HTMLButtonElement;
    fireEvent.click(button);
  }

  it("删除非选中连接：当前选中不漂移（不回退首行）", async () => {
    let list = [conn("c1"), conn("c2")];
    const onSelect = vi.fn();
    stubInvoke({
      "server:connectionList": () => ({
        activeConnId: "c2",
        connections: list,
      }),
      "server:connectionDelete": () => {
        list = [conn("c2")];
        return { activeConnId: "c2", connections: list };
      },
    });
    renderList("c2", onSelect);
    clickDelete(await screen.findByTestId("connection-c1"));
    // 清单刷新后 c1 行消失（effect 同步收尾）——选中保持 c2
    await waitFor(() =>
      expect(screen.queryByTestId("connection-c1")).toBeNull(),
    );
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByTestId("connection-c2")).toBeTruthy();
  });

  it("删除选中的连接：回退选中剩余首行", async () => {
    let list = [conn("c1"), conn("c2")];
    const onSelect = vi.fn();
    stubInvoke({
      "server:connectionList": () => ({
        activeConnId: "c2",
        connections: list,
      }),
      "server:connectionDelete": () => {
        list = [conn("c1")];
        return { activeConnId: "c1", connections: list };
      },
    });
    renderList("c2", onSelect);
    clickDelete(await screen.findByTestId("connection-c2"));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("c1"));
  });
});

describe("ServerConsoleView 远程会话遥控壳退役（HD-P2c）", () => {
  it("选中连接无编排/模型能力：右栏收起（详情卡/上下文条不渲染，列表居中独占）", async () => {
    stubInvoke({
      "server:connectionList": {
        activeConnId: "c9",
        connections: [
          {
            id: "c9",
            name: "远端主机",
            mode: "direct",
            baseUrl: "http://10.0.0.9:3000",
            state: "connected",
            capabilities: ["chat"],
          },
        ],
      },
    });
    renderView();
    await screen.findByTestId("connection-c9");
    expect(screen.queryByTestId("connection-detail")).toBeNull();
    expect(screen.queryByTestId("connection-context-bar")).toBeNull();
    // 平铺形态（HD-P3e）：无内部滚动区（页面文档流自滚）
    expect(document.querySelector(".overflow-y-auto")).toBeNull();
    // 会话/模型 tab 均已退役
    expect(screen.queryByTestId("console-tab-session")).toBeNull();
    expect(screen.queryByTestId("console-tab-models")).toBeNull();
  });

  it("有 graph 能力：右栏编排遥控直达（HD-P3d 单面板免 tab 栏）；模型/会话面板不渲染", async () => {
    stubInvoke({
      "server:connectionList": {
        activeConnId: "c9",
        connections: [
          {
            id: "c9",
            name: "无头端",
            mode: "direct",
            baseUrl: "http://x",
            state: "connected",
            capabilities: ["chat", "provider", "graph"],
          },
        ],
      },
    });
    renderView();
    // 编排遥控直达（唯一面板无切换，tab 栏随单面板化移除）
    expect(await screen.findByTestId("orchestration-area")).toBeTruthy();
    expect(screen.queryByTestId("console-tab-orchestration")).toBeNull();
    expect(screen.queryByTestId("console-tab-models")).toBeNull();
    expect(screen.queryByTestId("console-tab-session")).toBeNull();
  });
});
