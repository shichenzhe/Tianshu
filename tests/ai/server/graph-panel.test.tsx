// @vitest-environment jsdom
// GA-T8 编排区遥控：GraphPanel / AutomationPanel / ServerConsoleView 能力门控
// 全链路（mock @/lib/ipc 的 invoke + on——事件经捕获的 server:event:<connId>
// 监听器投递）：
// - graph 列表渲染（名称/节点数/run 状态徽标，初始 idle）
// - 触发试运行：server:graphRun 透传 → 202 {runId} → 行内转运行中（中止
//   按钮出现）→ server:graphRunAbort 携 runId
// - graph.run.updated 事件到达 → 行内状态徽标流式更新（succeeded/failed）
// - automation 列表渲染（名称/scheduleText/下次运行时间）
// - 启停走 automation/save 全量 enabled 翻转（Ruling 12，无 toggle 端点）
// - 立即运行 server:automationRunNow 透传；automation.changed 事件重拉列表
// - 能力门控（Ruling 11）：连接运行时上报 capabilities 含 graph 才渲染编排
//   区（桌面被控端 chat+provider 不渲染）；含 graph 时经「编排」tab 进入
import type { ReactElement } from "react";
import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";

// Radix Switch 在 jsdom 的最小桩（先例 create-task-project.test.tsx）
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

// localStorage stub：ConnectionList 本地无头端目录记忆读写，测试环境无
// 原生 localStorage（先例 tests/ai/server/console-view.test.tsx）
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

import GraphPanel from "../../../src-react/domains/ai/server/components/GraphPanel";
import AutomationPanel from "../../../src-react/domains/ai/server/components/AutomationPanel";
import ServerConsoleView from "../../../src-react/domains/ai/server/views/ServerConsoleView";

const CONN = "conn-1";

/** starter 包装体信封（透传通道 {status, body} 全信封契约） */
function envelope(data: unknown) {
  return {
    status: 200,
    body: { code: "2000", success: true, data, message: "success" },
  };
}

function graph(id: number, name: string, nodeCount: number) {
  return {
    id,
    name,
    graphJson: "{}",
    version: 1,
    enabled: true,
    createdAt: "2026-10-15T10:00:00.000Z",
    updatedAt: "2026-10-16T10:00:00.000Z",
    nodeCount,
  };
}

const GRAPHS_PAGE = {
  page: 1,
  pageSize: 50,
  total: 2,
  records: [graph(1, "调研图", 4), graph(2, "翻译图", 2)],
};

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 3,
    name: "每日简报",
    prompt: "写一份简报",
    workspaceId: 1,
    workspaceName: "默认空间",
    source: "local",
    modelId: 5,
    targetKind: "prompt",
    graphId: null,
    eventJson: null,
    scheduleJson: '{"mode":"daily","time":"09:00"}',
    scheduleText: "每天 09:00",
    missedPolicy: "skip",
    accessMode: "default",
    enabled: true,
    status: "active",
    nextRunAt: "2026-10-18T01:00:00.000Z",
    projectId: null,
    createdAt: "2026-10-15T10:00:00.000Z",
    updatedAt: "2026-10-16T10:00:00.000Z",
    ...overrides,
  };
}

const TASKS_PAGE = {
  page: 1,
  pageSize: 50,
  total: 1,
  records: [task()],
};

/** 会话通道 stub（ServerConsoleView 右栏会话 tab / 面板直渲染均不触碰） */
const SESSION_EMPTY = {
  page: 1,
  pageSize: 50,
  total: 0,
  records: [],
};
const LOCAL_STOPPED = {
  running: false,
  state: "stopped",
  port: null,
  instanceId: null,
};
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

/** 图/任务页 fixture（automation.changed 重拉用例中途替换） */
let graphsPage: unknown = GRAPHS_PAGE;
let tasksPage: unknown = TASKS_PAGE;

function stubInvoke(handlers: Record<string, unknown> = {}): void {
  invoke.mockImplementation((channel: string, ...args: unknown[]) => {
    if (channel in handlers) {
      const value = handlers[channel];
      return typeof value === "function" ? value(...args) : value;
    }
    if (channel === "server:graphQuery") return envelope(graphsPage);
    if (channel === "server:graphRun") return envelope({ runId: 101 });
    if (channel === "server:graphRunAbort") return envelope({ aborted: true });
    if (channel === "server:automationQuery") return envelope(tasksPage);
    if (channel === "server:automationRunNow")
      return envelope({ accepted: true });
    if (channel === "server:sessionList") return envelope(SESSION_EMPTY);
    if (channel === "server:connectionList") return EMPTY_LIST;
    if (channel === "server:localStatus") return LOCAL_STOPPED;
    if (channel === "serverFace:status") return FACE_OFF;
    throw new Error(`未 mock 的通道：${channel}`);
  });
}

const EMPTY_LIST = {
  activeConnId: null,
  connections: [],
};

function connectionList(capabilities: string[]) {
  return {
    activeConnId: CONN,
    connections: [
      {
        id: CONN,
        name: "本地无头端",
        mode: "direct",
        baseUrl: "http://127.0.0.1:3000",
        local: true,
        state: "connected",
        capabilities,
      },
    ],
  };
}

function renderTree(node: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

/** 向捕获的合并通道投递事件（全部订阅者） */
function emitEvent(payload: unknown): void {
  const arr = listeners.get(`server:event:${CONN}`) ?? [];
  if (!arr.length) throw new Error("未订阅通道 server:event");
  for (const fn of arr) fn(undefined, payload);
}

beforeEach(() => {
  cleanup();
  invoke.mockReset();
  listeners.clear();
  graphsPage = GRAPHS_PAGE;
  tasksPage = TASKS_PAGE;
  stubInvoke();
});

describe("GraphPanel 编排图遥控", () => {
  it("列表渲染：名称/节点数/run 状态徽标（初始未运行）", async () => {
    renderTree(<GraphPanel connId={CONN} />);
    expect(await screen.findByTestId("graph-row-1")).toBeTruthy();
    expect(screen.getByTestId("graph-row-2")).toBeTruthy();
    expect(screen.getByText("调研图")).toBeTruthy();
    expect(screen.getAllByText("ai:server.graph.nodes")).toHaveLength(2);
    // run 状态徽标：初始 idle；触发按钮在位
    expect(screen.getByTestId("graph-state-1").textContent).toBe(
      "ai:server.graph.runState.idle",
    );
    expect(screen.getByTestId("graph-run-1")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith(
      "server:graphQuery",
      expect.anything(),
      CONN,
    );
  });

  it("触发 → server:graphRun 透传 → 行内转运行中（中止出现）→ runAbort 携 runId", async () => {
    renderTree(<GraphPanel connId={CONN} />);
    await screen.findByTestId("graph-row-1");
    fireEvent.click(screen.getByTestId("graph-run-1"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "server:graphRun",
        { graphId: 1 },
        CONN,
      ),
    );
    // 202 回 {runId} → 行内状态转运行中，触发按钮换中止
    expect(await screen.findByTestId("graph-abort-1")).toBeTruthy();
    expect(screen.queryByTestId("graph-run-1")).toBeNull();
    expect(screen.getByTestId("graph-state-1").textContent).toBe(
      "ai:server.graph.runState.running",
    );
    fireEvent.click(screen.getByTestId("graph-abort-1"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "server:graphRunAbort",
        { runId: 101 },
        CONN,
      ),
    );
  });

  it("graph.run.updated 事件到达：行内状态徽标流式更新（succeeded / failed）", async () => {
    renderTree(<GraphPanel connId={CONN} />);
    await screen.findByTestId("graph-row-1");
    emitEvent({
      type: "graph.run.updated",
      payload: { runId: 101, graphId: 1, state: "running" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("graph-state-1").textContent).toBe(
        "ai:server.graph.runState.running",
      ),
    );
    emitEvent({
      type: "graph.run.updated",
      payload: { runId: 101, graphId: 1, state: "succeeded", output: "完成" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("graph-state-1").textContent).toBe(
        "ai:server.graph.runState.succeeded",
      ),
    );
    emitEvent({
      type: "graph.run.updated",
      payload: { runId: 102, graphId: 2, state: "failed", error: "boom" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("graph-state-2").textContent).toBe(
        "ai:server.graph.runState.failed",
      ),
    );
  });

  it("automation.changed 不重置 run 投影（终态徽标保持，仅重拉列表——GA-T8 审查）", async () => {
    renderTree(<GraphPanel connId={CONN} />);
    await screen.findByTestId("graph-row-1");
    emitEvent({
      type: "graph.run.updated",
      payload: { runId: 101, graphId: 1, state: "succeeded", output: "完成" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("graph-state-1").textContent).toBe(
        "ai:server.graph.runState.succeeded",
      ),
    );
    // 任务级变更信号只重拉列表，不得抹掉图 run 终态（也不得翻转运行中态）
    emitEvent({ type: "automation.changed", payload: { taskId: 3 } });
    // 重拉已发生（列表失效重取），但徽标保持 succeeded
    await waitFor(() =>
      expect(invoke.mock.calls.some((c) => c[0] === "server:graphQuery")).toBe(
        true,
      ),
    );
    expect(screen.getByTestId("graph-state-1").textContent).toBe(
      "ai:server.graph.runState.succeeded",
    );
  });

  it("server.connected 重连：run 展示态复位（无 run 查询面，断流期间终局无从补查）", async () => {
    renderTree(<GraphPanel connId={CONN} />);
    await screen.findByTestId("graph-row-1");
    emitEvent({
      type: "graph.run.updated",
      payload: { runId: 101, graphId: 1, state: "running" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("graph-state-1").textContent).toBe(
        "ai:server.graph.runState.running",
      ),
    );
    emitEvent({
      type: "server.connected",
      payload: { instanceId: "iid", capabilities: ["chat", "graph"] },
    });
    await waitFor(() =>
      expect(screen.getByTestId("graph-state-1").textContent).toBe(
        "ai:server.graph.runState.idle",
      ),
    );
  });
});

describe("GraphPanel webhook 配置（WH 消费端批）", () => {
  const WH_OFF = { enabled: false, url: "" };
  const WH_ON = {
    enabled: true,
    url: "/webhook/abc123",
    responseTemplate: "",
    statusCode: 201,
    async: false,
    fullAccess: true,
  };

  function whHandlers(overrides: Record<string, unknown> = {}) {
    return {
      "server:webhookStatus": envelope(WH_OFF),
      "server:webhookEnable": envelope(WH_ON),
      "server:webhookDisable": envelope(WH_OFF),
      ...overrides,
    };
  }

  it("未启态：打开惰性拉 status → enable 表单；提交载荷四配置（缺省 200/false）", async () => {
    stubInvoke(whHandlers());
    renderTree(<GraphPanel connId={CONN} />);
    await screen.findByTestId("graph-row-1");
    fireEvent.click(screen.getByTestId("graph-webhook-1"));
    // 惰性拉取：status 通道按图 id
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "server:webhookStatus",
        { graphId: 1 },
        CONN,
      ),
    );
    await screen.findByTestId("graph-webhook-enable-1");
    fireEvent.click(screen.getByTestId("graph-webhook-enable-1"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "server:webhookEnable",
        { graphId: 1, statusCode: 200, async: false, fullAccess: false },
        CONN,
      ),
    );
    // enable 成功转已启态：URL 回显
    expect(await screen.findByText("/webhook/abc123")).toBeTruthy();
  });

  it("已启态：URL+配置回显；关闭调 disable；重开换 token 携回显配置", async () => {
    stubInvoke(whHandlers({ "server:webhookStatus": envelope(WH_ON) }));
    renderTree(<GraphPanel connId={CONN} />);
    await screen.findByTestId("graph-row-1");
    fireEvent.click(screen.getByTestId("graph-webhook-1"));
    await screen.findByTestId("graph-webhook-disable-1");
    // 配置回显（statusCode 201 / 全权已开启）
    expect(screen.getByText(/201/)).toBeTruthy();
    // 重开换 token：载荷携回显配置
    fireEvent.click(screen.getByTestId("graph-webhook-rotate-1"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "server:webhookEnable",
        { graphId: 1, statusCode: 201, async: false, fullAccess: true },
        CONN,
      ),
    );
    // 关闭：disable 透传后回未启态（enable 按钮再现）
    fireEvent.click(screen.getByTestId("graph-webhook-disable-1"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "server:webhookDisable",
        { graphId: 1 },
        CONN,
      ),
    );
    await screen.findByTestId("graph-webhook-enable-1");
  });
});

describe("AutomationPanel 任务遥控", () => {
  it("列表渲染：名称/schedule 摘要/下次运行时间", async () => {
    renderTree(<AutomationPanel connId={CONN} />);
    expect(await screen.findByTestId("automation-row-3")).toBeTruthy();
    expect(screen.getByText("每日简报")).toBeTruthy();
    expect(screen.getByTestId("automation-schedule-3").textContent).toBe(
      "每天 09:00",
    );
    expect(screen.getByTestId("automation-nextrun-3").textContent).toContain(
      "2026-10-18T01:00:00.000Z",
    );
    expect(invoke).toHaveBeenCalledWith(
      "server:automationQuery",
      expect.anything(),
      CONN,
    );
  });

  it("启停走 automation/save 全量 enabled 翻转（Ruling 12，无 toggle 通道）", async () => {
    renderTree(<AutomationPanel connId={CONN} />);
    await screen.findByTestId("automation-row-3");
    fireEvent.click(screen.getByTestId("automation-toggle-3"));
    await waitFor(() => {
      const call = invoke.mock.calls.find(
        (c) => c[0] === "server:automationSave",
      );
      expect(call).toBeTruthy();
      const [, payload, connId] = call as [
        string,
        Record<string, unknown>,
        string,
      ];
      expect(connId).toBe(CONN);
      expect(payload).toMatchObject({
        id: 3,
        name: "每日简报",
        enabled: false,
        missedPolicy: "skip",
        schedule: { mode: "daily", time: "09:00" },
        scheduleText: "每天 09:00",
      });
    });
    // 无 toggle 端点面被触碰
    expect(
      invoke.mock.calls.some((c) => c[0] === "server:automationToggle"),
    ).toBe(false);
  });

  it("立即运行 → server:automationRunNow 透传；automation.changed 事件重拉列表", async () => {
    renderTree(<AutomationPanel connId={CONN} />);
    await screen.findByTestId("automation-row-3");
    fireEvent.click(screen.getByTestId("automation-runnow-3"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "server:automationRunNow",
        { taskId: 3 },
        CONN,
      ),
    );
    // 事件是刷新信号非状态镜像：重拉列表后新任务可见
    tasksPage = {
      ...TASKS_PAGE,
      total: 2,
      records: [...TASKS_PAGE.records, task({ id: 4, name: "重连新增任务" })],
    };
    emitEvent({ type: "automation.changed", payload: { taskId: 4 } });
    expect(await screen.findByTestId("automation-row-4")).toBeTruthy();
    expect(screen.getByText("重连新增任务")).toBeTruthy();
  });
});

describe("ServerConsoleView 能力门控（Ruling 11）", () => {
  it("无 graph capability（桌面被控端 chat+provider）：右栏收起列表居中（HD-P3d 去冗余）", async () => {
    stubInvoke({
      "server:connectionList": connectionList(["chat", "provider"]),
    });
    renderTree(<ServerConsoleView />);
    await screen.findByTestId("connection-conn-1");
    // 无编排遥控面：右栏（详情卡/上下文条）不再渲染——列表居中独占
    expect(screen.queryByTestId("connection-detail")).toBeNull();
    expect(screen.queryByTestId("connection-context-bar")).toBeNull();
    expect(screen.queryByTestId("console-tab-models")).toBeNull();
    expect(screen.queryByTestId("console-tab-orchestration")).toBeNull();
    expect(invoke.mock.calls.some((c) => c[0] === "server:graphQuery")).toBe(
      false,
    );
    expect(
      invoke.mock.calls.some((c) => c[0] === "server:automationQuery"),
    ).toBe(false);
  });

  it("有 graph capability（运行时上报值）：默认编排 tab，graph/automation 面板挂载", async () => {
    stubInvoke({
      "server:connectionList": connectionList(["chat", "provider", "graph"]),
    });
    renderTree(<ServerConsoleView />);
    await screen.findByTestId("connection-conn-1");
    // HD-P3b：模型 tab 随 ProviderPanel 退役（单 UI 模型页已覆盖读写）
    expect(await screen.findByTestId("graph-panel")).toBeTruthy();
    expect(screen.getByTestId("automation-panel")).toBeTruthy();
    expect(await screen.findByTestId("graph-row-1")).toBeTruthy();
    expect(screen.queryByTestId("console-tab-models")).toBeNull();
  });
});
