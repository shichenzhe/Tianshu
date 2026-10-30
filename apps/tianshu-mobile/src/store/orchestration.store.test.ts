import { beforeEach, describe, expect, it, vi } from "vitest";

// —— connections 层替身：activeTransport 可换 mock/null；事件总线用内存 emitter ——
const connMock = vi.hoisted(() => {
  const listeners = new Set<(e: unknown) => void>();
  return {
    activeTransport: vi.fn(),
    subscribeTransportEvents: vi.fn((cb: (e: unknown) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
    emit: (e: unknown) => {
      for (const cb of listeners) cb(e);
    },
  };
});

vi.mock("./connections.store", () => ({
  activeTransport: connMock.activeTransport,
  subscribeTransportEvents: connMock.subscribeTransportEvents,
}));

// —— 通知链替身（M3）：notify lib mock（react-native 不可在 node 加载）；
// notify.store 只 mock getNotifyPrefs（prefs 运行时可换）；i18n 以 key 回显 ——
const notifyMock = vi.hoisted(() => ({ notifyLocal: vi.fn() }));
vi.mock("../lib/notify", () => ({
  notifyLocal: notifyMock.notifyLocal,
  requestNotificationPermission: vi.fn(async () => true),
}));

const prefsMock = vi.hoisted(() => ({
  prefs: { enabled: true, approvals: true, graphDone: true },
}));
vi.mock("./notify.store", () => ({
  getNotifyPrefs: vi.fn(() => prefsMock.prefs),
}));

vi.mock("../i18n", () => ({ default: { t: (key: string) => key } }));

// —— graph-api 层替身：请求函数全 vi.fn；toTaskSaveParams/toTaskRow 用真身
// （纯函数 + toggleTask 的 save 载荷断言走真实 parse 链） ——
const apiMock = vi.hoisted(() => ({
  graphQuery: vi.fn(),
  graphDelete: vi.fn(),
  graphRun: vi.fn(),
  graphRunAbort: vi.fn(),
  automationList: vi.fn(),
  automationSave: vi.fn(),
  automationDelete: vi.fn(),
  automationRunNow: vi.fn(),
  automationRunNodes: vi.fn(),
}));

vi.mock("../transport/graph-api", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../transport/graph-api")
  >();
  return { ...actual, ...apiMock };
});

import { toTaskSaveParams } from "../transport/graph-api";
import type {
  AutomationRunNodeRecord,
  GraphRecord,
  TaskRecord,
} from "@tianshu/protocol";
import { describeGraphError, useOrchestrationStore } from "./orchestration.store";

const ISO = "2026-10-17T01:00:00.000Z";

/** 伪 transport：store 只用其非空性判连接存在 */
function fakeTransport(): { request: ReturnType<typeof vi.fn> } {
  return { request: vi.fn() };
}

function graphRow(
  id: number,
  overrides: Partial<GraphRecord> = {},
): GraphRecord {
  return {
    id,
    name: `图${id}`,
    description: "描述",
    graphJson: "{}",
    version: 1,
    enabled: true,
    createdAt: ISO,
    updatedAt: ISO,
    nodeCount: 3,
    ...overrides,
  };
}

function taskRow(
  id: number,
  overrides: Partial<TaskRecord> = {},
): TaskRecord {
  return {
    id,
    name: `任务${id}`,
    prompt: "你好",
    workspaceId: 1,
    workspaceName: "默认",
    source: "local",
    modelId: 5,
    temperature: 0.7,
    targetKind: "prompt",
    graphId: null,
    eventJson: null,
    scheduleJson: JSON.stringify({ type: "interval", minutes: 30 }),
    scheduleText: "每 30 分钟",
    startAt: ISO,
    endAt: undefined,
    missedPolicy: "skip",
    accessMode: "default",
    enabled: true,
    status: "active",
    statusNote: undefined,
    lastRunAt: ISO,
    nextRunAt: ISO,
    templateSlug: undefined,
    projectId: null,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

/** 分页成功帧（graph-api 真身 parse 会在 store 测试外单测覆盖） */
function pageOf(records: unknown[], total = records.length) {
  return {
    ok: true as const,
    data: { page: 1, pageSize: 20, total, records },
  };
}

function failOf(message: string) {
  return { ok: false as const, code: "4000", message };
}

/** 节点详情行工厂（执行详情批） */
function nodeRow(
  id: number,
  runId: number,
  overrides: Partial<AutomationRunNodeRecord> = {},
): AutomationRunNodeRecord {
  return {
    id,
    runId,
    nodeId: `n${id}`,
    nodeName: `节点${id}`,
    status: "success",
    input: `输入${id}`,
    output: `输出${id}`,
    errorJson: null,
    toolCallsJson: null,
    promptTokens: 10,
    completionTokens: 20,
    durationMs: 1200,
    startedAt: ISO,
    outputImage: null,
    errorOutput: null,
    fallbackJson: null,
    ...overrides,
  };
}

/** 挂起 promise：防迟到用例手工控制响应次序 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 微任务冲刷：事件回调内 void fire-and-forget 的重拉 */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function resetStore(): void {
  useOrchestrationStore.setState({
    graphs: [],
    graphsTotal: 0,
    graphsPage: 1,
    graphsLoading: false,
    tasks: [],
    tasksTotal: 0,
    tasksPage: 1,
    tasksLoading: false,
    runs: {},
    runNodes: {},
    runNodesLoading: {},
  });
}

describe("orchestration store（mock graph-api 层）", () => {
  beforeEach(() => {
    for (const fn of Object.values(apiMock)) fn.mockReset();
    connMock.activeTransport.mockReset().mockReturnValue(fakeTransport());
    resetStore();
    notifyMock.notifyLocal.mockClear();
    prefsMock.prefs = { enabled: true, approvals: true, graphDone: true };
    // App 级幂等装配（首个用例真正订阅，其后空转）
    useOrchestrationStore.getState().bindEvents();
  });

  it("loadGraphs/loadTasks：无活动连接静默空表（不发请求）", async () => {
    connMock.activeTransport.mockReturnValue(null);
    await useOrchestrationStore.getState().loadGraphs();
    await useOrchestrationStore.getState().loadTasks();

    expect(apiMock.graphQuery).not.toHaveBeenCalled();
    expect(apiMock.automationList).not.toHaveBeenCalled();
    const s = useOrchestrationStore.getState();
    expect(s.graphs).toEqual([]);
    expect(s.tasks).toEqual([]);
    expect(s.graphsLoading).toBe(false);
  });

  it("loadGraphs：查询归档；loadMore 跨页 append 去重", async () => {
    apiMock.graphQuery
      .mockResolvedValueOnce(pageOf([graphRow(1), graphRow(2)]))
      .mockResolvedValueOnce({
        ok: true,
        data: {
          page: 2,
          pageSize: 20,
          total: 3,
          records: [graphRow(2), graphRow(3)],
        },
      });

    await useOrchestrationStore.getState().loadGraphs();
    expect(useOrchestrationStore.getState().graphs.map((g) => g.id)).toEqual([
      1, 2,
    ]);
    expect(useOrchestrationStore.getState().graphsTotal).toBe(2);

    useOrchestrationStore.setState({ graphsTotal: 3 }); // 造出第二页
    await useOrchestrationStore.getState().loadMoreGraphs();
    expect(useOrchestrationStore.getState().graphs.map((g) => g.id)).toEqual([
      1, 2, 3,
    ]); // 跨页重复 id=2 去重
  });

  it("runGraph：202 受理 {runId} → 乐观置 running；失败不动投影", async () => {
    apiMock.graphRun
      .mockResolvedValueOnce({ ok: true, data: { runId: 7 } })
      .mockResolvedValueOnce(failOf("RUN_IN_FLIGHT"));

    const okOut = await useOrchestrationStore.getState().runGraph(1);
    expect(okOut).toEqual({ ok: true, code: "", message: "" });
    expect(useOrchestrationStore.getState().runs[1]).toEqual({
      runId: 7,
      state: "running",
    });

    const badOut = await useOrchestrationStore.getState().runGraph(2);
    expect(badOut).toEqual({ ok: false, code: "4000", message: "RUN_IN_FLIGHT" });
    expect(useOrchestrationStore.getState().runs[2]).toBeUndefined();
  });

  it("graph.run.updated 事件归档：running→succeeded(output)/failed(error)", () => {
    connMock.emit({
      type: "graph.run.updated",
      payload: {
        runId: 7,
        graphId: 1,
        state: "running",
        progress: { nodeId: "n1", nodeStatus: "running" },
      },
    });
    expect(useOrchestrationStore.getState().runs[1]).toEqual({
      runId: 7,
      state: "running",
    });

    connMock.emit({
      type: "graph.run.updated",
      payload: { runId: 7, graphId: 1, state: "succeeded", output: "done" },
    });
    expect(useOrchestrationStore.getState().runs[1]).toEqual({
      runId: 7,
      state: "succeeded",
      output: "done",
    });

    connMock.emit({
      type: "graph.run.updated",
      payload: { runId: 9, graphId: 2, state: "failed", error: "boom" },
    });
    expect(useOrchestrationStore.getState().runs[2]).toEqual({
      runId: 9,
      state: "failed",
      error: "boom",
    });
  });

  it("终态通知：非终态不响；succeeded 带「状态 · 图名」触发一次；同终态重发不重复", () => {
    useOrchestrationStore.setState({ graphs: [graphRow(1)] });

    connMock.emit({
      type: "graph.run.updated",
      payload: { runId: 7, graphId: 1, state: "running" },
    });
    expect(notifyMock.notifyLocal).not.toHaveBeenCalled(); // running 非终态

    connMock.emit({
      type: "graph.run.updated",
      payload: { runId: 7, graphId: 1, state: "succeeded", output: "done" },
    });
    expect(notifyMock.notifyLocal).toHaveBeenCalledTimes(1);
    expect(notifyMock.notifyLocal).toHaveBeenCalledWith({
      title: "notify:graphDoneTitle",
      body: "notify:state.succeeded · 图1",
    });

    connMock.emit({
      type: "graph.run.updated",
      payload: { runId: 7, graphId: 1, state: "succeeded", output: "done" },
    });
    expect(notifyMock.notifyLocal).toHaveBeenCalledTimes(1); // 事件重发不重复打扰
  });

  it("终态通知：graphId 不在 graphs 列表只发状态文案", () => {
    connMock.emit({
      type: "graph.run.updated",
      payload: { runId: 9, graphId: 99, state: "aborted" },
    });
    expect(notifyMock.notifyLocal).toHaveBeenCalledWith({
      title: "notify:graphDoneTitle",
      body: "notify:state.aborted",
    });
  });

  it("终态通知：prefs 关（enabled 或 graphDone 任一关）不触发", () => {
    prefsMock.prefs = { enabled: false, approvals: true, graphDone: true };
    connMock.emit({
      type: "graph.run.updated",
      payload: { runId: 7, graphId: 1, state: "failed", error: "boom" },
    });

    prefsMock.prefs = { enabled: true, approvals: true, graphDone: false };
    connMock.emit({
      type: "graph.run.updated",
      payload: { runId: 8, graphId: 1, state: "succeeded" },
    });

    expect(notifyMock.notifyLocal).not.toHaveBeenCalled();
  });

  it("abortRun：携 runs[graphId].runId 调 graphRunAbort", async () => {
    useOrchestrationStore.setState({
      runs: { 1: { runId: 7, state: "running" } },
    });
    apiMock.graphRunAbort.mockResolvedValueOnce({
      ok: true,
      data: { aborted: true },
    });

    const out = await useOrchestrationStore.getState().abortRun(1);
    expect(out.ok).toBe(true);
    expect(apiMock.graphRunAbort).toHaveBeenCalledWith(7);
    // aborted 态交由事件回传——本地不合成
    expect(useOrchestrationStore.getState().runs[1].state).toBe("running");
  });

  it("automation.changed：刷新信号 → loadTasks 重拉", async () => {
    apiMock.automationList.mockResolvedValue(pageOf([taskRow(3)]));
    await useOrchestrationStore.getState().loadTasks();
    expect(apiMock.automationList).toHaveBeenCalledTimes(1);

    connMock.emit({
      type: "automation.changed",
      payload: { taskId: 3, enabled: false, nextRunAt: null },
    });
    await flush();

    expect(apiMock.automationList).toHaveBeenCalledTimes(2);
    // automation.changed 不得触碰 runs 投影（GA-T8 审查修 1）
    useOrchestrationStore.setState({ runs: { 1: { runId: 7, state: "succeeded" } } });
    connMock.emit({ type: "automation.changed", payload: { taskId: 4 } });
    await flush();
    expect(useOrchestrationStore.getState().runs[1].state).toBe("succeeded");
  });

  it("loadRunNodes：ok 归档 + loading 复位；无连接静默不写键（失败态由页面呈现）", async () => {
    apiMock.automationRunNodes.mockResolvedValueOnce({
      ok: true,
      data: [nodeRow(1, 7), nodeRow(2, 7, { status: "failed" })],
    });
    await useOrchestrationStore.getState().loadRunNodes(7);
    const s = useOrchestrationStore.getState();
    expect(s.runNodes[7]).toHaveLength(2);
    expect(s.runNodes[7]?.[1]?.status).toBe("failed");
    expect(s.runNodesLoading[7]).toBe(false);

    connMock.activeTransport.mockReturnValue(null);
    await useOrchestrationStore.getState().loadRunNodes(8);
    expect(apiMock.automationRunNodes).toHaveBeenCalledTimes(1);
    // 无连接不伪造空数组（「无节点级详情」是数据断言，真因是没连接）
    expect(useOrchestrationStore.getState().runNodes[8]).toBeUndefined();
    expect(useOrchestrationStore.getState().runNodesLoading[8]).toBeUndefined();
  });

  it("clearRunNodes：离开详情页清理指定 run 的节点载荷与 loading", async () => {
    apiMock.automationRunNodes.mockResolvedValueOnce({
      ok: true,
      data: [nodeRow(1, 7)],
    });
    await useOrchestrationStore.getState().loadRunNodes(7);
    expect(useOrchestrationStore.getState().runNodes[7]).toHaveLength(1);

    useOrchestrationStore.getState().clearRunNodes(7);
    expect(useOrchestrationStore.getState().runNodes[7]).toBeUndefined();
    expect(useOrchestrationStore.getState().runNodesLoading[7]).toBeUndefined();
  });

  it("clearRunNodes 不清防迟到序号：卸载→重进后，卸载前在途旧响应不得覆写（终审）", async () => {
    const stale = deferred<{ ok: true; data: AutomationRunNodeRecord[] }>();
    apiMock.automationRunNodes
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ ok: true, data: [nodeRow(2, 7)] });

    const first = useOrchestrationStore.getState().loadRunNodes(7);
    useOrchestrationStore.getState().clearRunNodes(7); // 卸载清理
    const second = useOrchestrationStore.getState().loadRunNodes(7); // 立即重进
    await second;
    expect(useOrchestrationStore.getState().runNodes[7]?.map((n) => n.id)).toEqual([2]);
    // 卸载前的慢响应后到——序号被 clear 重置的话它会撞号覆写新数据
    stale.resolve({ ok: true, data: [nodeRow(1, 7)] });
    await first;
    expect(useOrchestrationStore.getState().runNodes[7]?.map((n) => n.id)).toEqual([2]);
  });

  it("loadRunNodes：wire 失败 loading 复位、旧值保守不动", async () => {
    useOrchestrationStore.setState({ runNodes: { 7: [nodeRow(1, 7)] } });
    apiMock.automationRunNodes.mockResolvedValueOnce(failOf("BOOM"));
    await useOrchestrationStore.getState().loadRunNodes(7);
    expect(useOrchestrationStore.getState().runNodes[7]).toHaveLength(1);
    expect(useOrchestrationStore.getState().runNodesLoading[7]).toBe(false);
  });

  it("loadRunNodes 防迟到：同 runId 迟到旧响应丢弃（末值生效）", async () => {
    const slow = deferred<{ ok: true; data: AutomationRunNodeRecord[] }>();
    apiMock.automationRunNodes
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce({ ok: true, data: [nodeRow(2, 7)] });

    const first = useOrchestrationStore.getState().loadRunNodes(7);
    const second = useOrchestrationStore.getState().loadRunNodes(7);
    await second;
    expect(useOrchestrationStore.getState().runNodes[7]?.map((n) => n.id)).toEqual([2]);
    slow.resolve({ ok: true, data: [nodeRow(1, 7)] });
    await first;
    // 迟到的首响应不得覆写末值
    expect(useOrchestrationStore.getState().runNodes[7]?.map((n) => n.id)).toEqual([2]);
  });

  it("loadRunNodes 按 runId 拆分：两 run 并发互不干扰（防跨资源误判过期）", async () => {
    const slowRun1 = deferred<{ ok: true; data: AutomationRunNodeRecord[] }>();
    apiMock.automationRunNodes
      .mockReturnValueOnce(slowRun1.promise)
      .mockResolvedValueOnce({ ok: true, data: [nodeRow(9, 2)] });

    const p1 = useOrchestrationStore.getState().loadRunNodes(1);
    const p2 = useOrchestrationStore.getState().loadRunNodes(2);
    await p2;
    slowRun1.resolve({ ok: true, data: [nodeRow(8, 1)] });
    await p1;
    // run2 的快响应不曾取消 run1 的慢响应（全局 seq 会误杀）
    expect(useOrchestrationStore.getState().runNodes[1]?.map((n) => n.id)).toEqual([8]);
    expect(useOrchestrationStore.getState().runNodes[2]?.map((n) => n.id)).toEqual([9]);
  });

  it("graph.run.updated：浏览中 run（已拉节点）终态/节点完成事件重拉；纯 running 进度不拉；未浏览不拉", async () => {
    apiMock.automationRunNodes.mockResolvedValue({
      ok: true,
      data: [nodeRow(1, 7)],
    });
    await useOrchestrationStore.getState().loadRunNodes(7);
    expect(apiMock.automationRunNodes).toHaveBeenCalledTimes(1);

    // 节点起跑事件：节点行只在完成时落库，重拉无新数据——跳过
    connMock.emit({
      type: "graph.run.updated",
      payload: { runId: 7, graphId: 1, state: "running", progress: { nodeId: "n1", nodeStatus: "running" } },
    });
    await flush();
    expect(apiMock.automationRunNodes).toHaveBeenCalledTimes(1);

    // 节点完成事件（run 仍 running）：重拉
    connMock.emit({
      type: "graph.run.updated",
      payload: { runId: 7, graphId: 1, state: "running", progress: { nodeId: "n1", nodeStatus: "success" } },
    });
    await flush();
    expect(apiMock.automationRunNodes).toHaveBeenCalledTimes(2);

    // run 终态事件：重拉
    connMock.emit({
      type: "graph.run.updated",
      payload: { runId: 7, graphId: 1, state: "succeeded", output: "done" },
    });
    await flush();
    expect(apiMock.automationRunNodes).toHaveBeenCalledTimes(3);

    // 未浏览的 run 不触发拉取
    connMock.emit({
      type: "graph.run.updated",
      payload: { runId: 99, graphId: 1, state: "succeeded" },
    });
    await flush();
    expect(apiMock.automationRunNodes).toHaveBeenCalledTimes(3);
  });

  it("server.connected：runs 清空 + graphs/tasks 双拉", async () => {
    useOrchestrationStore.setState({
      runs: { 1: { runId: 7, state: "running" } },
      runNodes: { 7: [nodeRow(1, 7)] },
    });
    apiMock.graphQuery.mockResolvedValue(pageOf([]));
    apiMock.automationList.mockResolvedValue(pageOf([]));

    connMock.emit({
      type: "server.connected",
      payload: { instanceId: "inst-1", capabilities: ["chat", "graph"] },
    });
    await flush();

    expect(useOrchestrationStore.getState().runs).toEqual({});
    // 节点详情不清（执行详情批裁定）：浏览中重连不得空白已开的时间线，
    // 驻留内存由详情页卸载 clearRunNodes 负责
    expect(useOrchestrationStore.getState().runNodes).toEqual({ 7: [nodeRow(1, 7)] });
    expect(apiMock.graphQuery).toHaveBeenCalledTimes(1);
    expect(apiMock.automationList).toHaveBeenCalledTimes(1);
  });

  it("server.connected 能力门控：capabilities 不含 graph 跳过双拉（runs 仍清空）", async () => {
    useOrchestrationStore.setState({
      runs: { 1: { runId: 7, state: "running" } },
    });
    apiMock.graphQuery.mockResolvedValue(pageOf([]));
    apiMock.automationList.mockResolvedValue(pageOf([]));

    connMock.emit({
      type: "server.connected",
      payload: { instanceId: "face-1", capabilities: ["chat", "provider"] },
    });
    await flush();

    expect(useOrchestrationStore.getState().runs).toEqual({});
    expect(apiMock.graphQuery).not.toHaveBeenCalled();
    expect(apiMock.automationList).not.toHaveBeenCalled();
  });

  it("toggleTask：save 全量携 parse 后 schedule + 乐观翻转 + 回参原位覆写", async () => {
    const task = taskRow(3, { enabled: true });
    useOrchestrationStore.setState({ tasks: [task], tasksTotal: 1 });
    // deferred：save 未决期间可观察乐观翻转
    let resolveSave: (v: unknown) => void = () => {};
    apiMock.automationSave.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveSave = res;
        }),
    );

    const pending = useOrchestrationStore.getState().toggleTask(task, false);
    expect(useOrchestrationStore.getState().tasks[0].enabled).toBe(false); // 乐观翻转即时可见

    resolveSave({
      ok: true,
      data: taskRow(3, { enabled: false, updatedAt: "2026-10-17T02:00:00.000Z" }),
    });
    const out = await pending;
    expect(out.ok).toBe(true);
    // save 载荷：scheduleJson 已 parse 回对象，enabled 携翻转值
    expect(apiMock.automationSave).toHaveBeenCalledWith({
      id: 3,
      name: "任务3",
      prompt: "你好",
      workspaceId: 1,
      modelId: 5,
      temperature: 0.7,
      targetKind: "prompt",
      graphId: undefined,
      eventJson: undefined,
      schedule: { type: "interval", minutes: 30 },
      scheduleText: "每 30 分钟",
      startAt: ISO,
      endAt: undefined,
      missedPolicy: "skip",
      accessMode: "default",
      templateSlug: undefined,
      projectId: null,
      enabled: false,
    });
    // save 回参原位覆写
    expect(useOrchestrationStore.getState().tasks[0]).toMatchObject({
      id: 3,
      enabled: false,
    });
  });

  it("toggleTask 失败：重拉还原乐观翻转", async () => {
    const task = taskRow(3, { enabled: true });
    useOrchestrationStore.setState({ tasks: [task], tasksTotal: 1 });
    apiMock.automationSave.mockResolvedValueOnce(failOf("VERSION_CONFLICT"));
    apiMock.automationList.mockResolvedValueOnce(pageOf([taskRow(3, { enabled: true })]));

    const out = await useOrchestrationStore.getState().toggleTask(task, false);
    expect(out).toEqual({ ok: false, code: "4000", message: "VERSION_CONFLICT" });
    await flush(); // 失败分支 void loadTasks() 冲刷
    expect(useOrchestrationStore.getState().tasks[0].enabled).toBe(true);
  });

  it("runNow/deleteGraph/deleteTask：出参与本地行移除", async () => {
    useOrchestrationStore.setState({
      graphs: [graphRow(1), graphRow(2)],
      graphsTotal: 2,
      tasks: [taskRow(3)],
      tasksTotal: 1,
    });
    apiMock.automationRunNow.mockResolvedValueOnce({
      ok: true,
      data: { accepted: true },
    });
    apiMock.graphDelete.mockResolvedValueOnce({ ok: true, data: null });
    apiMock.automationDelete.mockResolvedValueOnce({ ok: true, data: null });

    const s = useOrchestrationStore.getState();
    expect((await s.runNow(3)).ok).toBe(true);
    expect((await s.deleteGraph(1)).ok).toBe(true);
    expect((await s.deleteTask(3)).ok).toBe(true);
    expect(apiMock.automationDelete).toHaveBeenCalledWith([3]);

    const after = useOrchestrationStore.getState();
    expect(after.graphs.map((g) => g.id)).toEqual([2]);
    expect(after.graphsTotal).toBe(1);
    expect(after.tasks).toEqual([]);
    expect(after.tasksTotal).toBe(0);
  });
});

describe("describeGraphError（业务错码友好化）", () => {
  /** 假 t：回显 key + 插值变量，断言稳定不依赖语言文件 */
  const fakeT = (key: string, vars?: Record<string, unknown>) =>
    `${key}${vars ? JSON.stringify(vars) : ""}`;

  it("已知码 GRAPH_IN_USE：冒号后引用清单透传 detail", () => {
    expect(describeGraphError("", "GRAPH_IN_USE:任务A,任务B", fakeT)).toBe(
      'orchestration:errGraphInUse{"detail":"任务A,任务B"}',
    );
  });

  it("已知码（无 detail）与 code 字段兜底匹配", () => {
    expect(describeGraphError("", "GRAPH_ALREADY_RUNNING", fakeT)).toBe(
      "orchestration:errAlreadyRunning",
    );
    expect(describeGraphError("GRAPH_NOT_FOUND", "图不存在", fakeT)).toBe(
      "orchestration:errGraphNotFound",
    );
    expect(describeGraphError("", "GRAPH_NOT_RUNNING", fakeT)).toBe(
      "orchestration:errGraphNotRunning",
    );
  });

  it("未知码：message 原样透传（server 裸 Error 标记走 message）", () => {
    expect(describeGraphError("4000", "VERSION_CONFLICT", fakeT)).toBe(
      "VERSION_CONFLICT",
    );
  });

  it("双空（网络层异常）：networkError 兜底", () => {
    expect(describeGraphError("", "", fakeT)).toBe(
      "orchestration:networkError",
    );
  });
});

describe("toTaskSaveParams（真实纯函数：scheduleJson 往返）", () => {
  it("scheduleJson parse 回 schedule 对象；graphId/eventJson null 化 undefined", () => {
    const params = toTaskSaveParams(taskRow(1, { eventJson: null }), false);
    expect(params.schedule).toEqual({ type: "interval", minutes: 30 });
    expect(params.graphId).toBeUndefined();
    expect(params.eventJson).toBeUndefined();
    expect(params.enabled).toBe(false);
    // wire 往返稳定：JSON 序列化不炸、schedule 结构保留
    const round = JSON.parse(JSON.stringify(params)) as typeof params;
    expect(round.schedule).toEqual({ type: "interval", minutes: 30 });
  });

  it("坏 scheduleJson 兜底空对象", () => {
    const params = toTaskSaveParams(taskRow(1, { scheduleJson: "not-json" }), true);
    expect(params.schedule).toEqual({});
  });

  it("graph 任务占位透传：prompt=''/modelId=0/graphId 指向图", () => {
    const graphTask = taskRow(2, {
      targetKind: "graph",
      graphId: 5,
      prompt: "",
      modelId: 0,
    });
    const params = toTaskSaveParams(graphTask, true);
    expect(params.prompt).toBe("");
    expect(params.modelId).toBe(0);
    expect(params.graphId).toBe(5);
    expect(params.targetKind).toBe("graph");
  });
});
