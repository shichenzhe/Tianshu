import { create } from "zustand";
import type {
  AutomationRunNodeRecord,
  AutomationRunRecord,
  AutomationRunStatus,
  GraphRecord,
  GraphRunStatus,
  ServerEvent,
  TaskRecord,
} from "@tianshu/protocol";

import { activeTransport, subscribeTransportEvents } from "./connections.store";
import { getNotifyPrefs } from "./notify.store";
import { notifyLocal } from "../lib/notify";
import i18n from "../i18n";
import {
  automationDelete,
  automationList,
  automationRunNow,
  automationRunNodes,
  automationRunPage,
  automationSave,
  graphDelete,
  graphQuery,
  graphRun,
  graphRunAbort,
  toTaskSaveParams,
} from "../transport/graph-api";

/**
 * 编排区遥控状态（M2c）：graphs/tasks 两列表 + runs 客户端投影。
 * run 状态为客户端投影（九端点无 run 查询面）：runGraph 202 受理即乐观置
 * running，graph.run.updated 事件流式归档（payload.graphId 定位行——他人
 * 触发/重开页面均可追上状态流）；server.connected 重连清空投影（断流期间
 * 终局事件已失，宁可复位不卡运行中）+ 双列表重拉。automation.changed 是
 * 刷新信号不是状态镜像（协议头注释口径）——收即重拉 tasks，且不得触碰
 * runs 投影（终态徽标保持，GA-T8 审查修 1 同款）。
 */

/** run 客户端投影行（终态 output/error 供徽标点击查看详情） */
export interface GraphRunEntry {
  runId: number;
  state: GraphRunStatus;
  output?: string;
  error?: string;
}

/** action 出参：ok + wire 失败臂原样（code/message 供 describeGraphError 友好化） */
export type ActionOutcome = { ok: boolean; code: string; message: string };

const OUTCOME_OK: ActionOutcome = { ok: true, code: "", message: "" };

/**
 * 业务错码友好化（Fix Round 1）：server 侧已知图错经裸 Error(message) 上
 * wire（异常过滤器 message 原样透传、code 恒 5000），故已知标记按 message
 * 精确/前缀（冒号后为引用清单等 detail）匹配、code 字段兜底同表；已知码
 * → i18n 文案（detail 透传 server message），未知码 → message 原样，
 * 双空 → networkError 兜底。
 */
const KNOWN_ERROR_KEYS: Record<string, string> = {
  GRAPH_IN_USE: "orchestration:errGraphInUse",
  GRAPH_ALREADY_RUNNING: "orchestration:errAlreadyRunning",
  GRAPH_NOT_FOUND: "orchestration:errGraphNotFound",
  GRAPH_NOT_RUNNING: "orchestration:errGraphNotRunning",
};

export function describeGraphError(
  code: string,
  message: string,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string {
  const marker = Object.keys(KNOWN_ERROR_KEYS).find(
    (m) => message === m || message.startsWith(`${m}:`) || code === m,
  );
  if (!marker) return message || t("orchestration:networkError");
  if (marker === "GRAPH_IN_USE") {
    const detail = message.slice(marker.length + 1); // 冒号后引用清单
    return t(KNOWN_ERROR_KEYS[marker], { detail });
  }
  return t(KNOWN_ERROR_KEYS[marker]);
}

interface OrchestrationState {
  graphs: GraphRecord[];
  graphsTotal: number;
  graphsPage: number;
  graphsLoading: boolean;
  tasks: TaskRecord[];
  tasksTotal: number;
  tasksPage: number;
  tasksLoading: boolean;
  runs: Record<number, GraphRunEntry>;
  /** 运行历史（CRUD 批 automation/runPage）：独立资源防迟到序号 */
  historyRuns: AutomationRunRecord[];
  historyTotal: number;
  historyPage: number;
  historyLoading: boolean;
  /** 状态筛选（null = 全部）；切筛选即重拉 */
  historyFilter: AutomationRunStatus | null;
  /** 任务口径预筛（null = 全量；任务行「历史」入口带入） */
  historyTaskId: number | null;
  /** 节点详情（执行详情批 automation/runNodes）：按 runId 键控 */
  runNodes: Record<number, AutomationRunNodeRecord[]>;
  /** 按资源拆分的 loading（详情页单 run 浏览态） */
  runNodesLoading: Record<number, boolean>;
  /** 首页覆写（进页/下拉刷新/事件重拉共用） */
  loadGraphs(): Promise<void>;
  loadMoreGraphs(): Promise<void>;
  loadTasks(): Promise<void>;
  loadMoreTasks(): Promise<void>;
  loadHistory(): Promise<void>;
  loadMoreHistory(): Promise<void>;
  /** 切状态筛选/任务预筛：置参即重拉首页 */
  setHistoryFilter(status: AutomationRunStatus | null): void;
  setHistoryTaskId(taskId: number | null): void;
  /** 节点详情拉取（执行详情批）：详情页进入/事件驱动重拉共用 */
  loadRunNodes(runId: number): Promise<void>;
  /** 离开详情页清理该 run 的节点载荷与 loading（防驻留+guard 复位） */
  clearRunNodes(runId: number): void;
  /** 202 受理 → 乐观置 running（事件流接管后续状态） */
  runGraph(graphId: number): Promise<ActionOutcome>;
  /** 中止受理即成功——aborted 态交由事件回传，勿本地合成 */
  abortRun(graphId: number): Promise<ActionOutcome>;
  /** save 全量（Ruling 12 无 toggle 端点）：乐观翻转，失败重拉还原 */
  toggleTask(task: TaskRecord, next: boolean): Promise<ActionOutcome>;
  runNow(taskId: number): Promise<ActionOutcome>;
  deleteGraph(id: number): Promise<ActionOutcome>;
  deleteTask(id: number): Promise<ActionOutcome>;
  /** 事件订阅装配（App 级只绑一次，_layout useBootstrap 调用） */
  bindEvents(): void;
}

const PAGE_SIZE = 20;

/** run 终态集合（notify 触发判定用：queued/running 非终态不响） */
const TERMINAL_RUN_STATES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "aborted",
]);

/**
 * 图终态后台通知（M3）：终态且此前投影 state 非同值才响（事件重发/重复
 * 终态不重复打扰；无既有投影——他人触发/重开页面追上状态流——按新终态
 * 响）。graphName 从 graphs 列表按 graphId 查，查不到只发状态文案。
 */
function notifyGraphDone(
  prevState: string | undefined,
  state: string,
  graphName: string | undefined,
): void {
  if (!TERMINAL_RUN_STATES.has(state) || prevState === state) return;
  const prefs = getNotifyPrefs();
  if (!prefs.enabled || !prefs.graphDone) return;
  const stateLabel = i18n.t(`notify:state.${state}`);
  notifyLocal({
    title: i18n.t("notify:graphDoneTitle"),
    body: graphName ? `${stateLabel} · ${graphName}` : stateLabel,
  });
}

/** bindEvents 幂等守卫（模块级：App 生命周期单份订阅） */
let eventsBound = false;
/** 各列表时序令牌：迟到的旧响应不得覆写新拉取结果 */
let graphSeq = 0;
let taskSeq = 0;
let historySeq = 0;
/** 节点详情时序令牌按 runId 拆分（防迟到铁律：跨资源互判过期即误杀） */
const runNodesSeq = new Map<number, number>();

/** 跨页 append 去重合并（同 id 后写覆盖，sessions.store 同款） */
function mergeById<T extends { id: number }>(prev: T[], next: T[]): T[] {
  const merged = new Map(prev.map((x) => [x.id, x]));
  for (const row of next) merged.set(row.id, row);
  return [...merged.values()];
}

export const useOrchestrationStore = create<OrchestrationState>((set, get) => {
  async function fetchGraphs(page: number, append: boolean): Promise<void> {
    // 无活动连接静默空表（进页未连接/拆除后）：不发请求不置 loading
    if (activeTransport() === null) {
      set({ graphs: [], graphsTotal: 0, graphsPage: 1, graphsLoading: false });
      return;
    }
    const token = ++graphSeq;
    set({ graphsLoading: true });
    const r = await graphQuery({ page, pageSize: PAGE_SIZE });
    if (token !== graphSeq) return;
    if (!r.ok) {
      set({ graphsLoading: false }); // 业务错/网络错：保守不动旧表
      return;
    }
    set((s) => ({
      graphs: append ? mergeById(s.graphs, r.data.records) : r.data.records,
      graphsTotal: r.data.total,
      graphsPage: page,
      graphsLoading: false,
    }));
  }

  async function fetchTasks(page: number, append: boolean): Promise<void> {
    if (activeTransport() === null) {
      set({ tasks: [], tasksTotal: 0, tasksPage: 1, tasksLoading: false });
      return;
    }
    const token = ++taskSeq;
    set({ tasksLoading: true });
    const r = await automationList({ page, pageSize: PAGE_SIZE });
    if (token !== taskSeq) return;
    if (!r.ok) {
      set({ tasksLoading: false });
      return;
    }
    set((s) => ({
      tasks: append ? mergeById(s.tasks, r.data.records) : r.data.records,
      tasksTotal: r.data.total,
      tasksPage: page,
      tasksLoading: false,
    }));
  }

  async function fetchHistory(page: number, append: boolean): Promise<void> {
    if (activeTransport() === null) {
      set({
        historyRuns: [],
        historyTotal: 0,
        historyPage: 1,
        historyLoading: false,
      });
      return;
    }
    const token = ++historySeq;
    set({ historyLoading: true });
    const { historyFilter, historyTaskId } = get();
    const r = await automationRunPage({
      page,
      ...(historyTaskId !== null ? { taskId: historyTaskId } : {}),
      ...(historyFilter !== null ? { status: historyFilter } : {}),
    });
    if (token !== historySeq) return;
    if (!r.ok) {
      set({ historyLoading: false }); // 保守不动旧表（graphs/tasks 同款）
      return;
    }
    set((s) => ({
      historyRuns: append
        ? mergeById(s.historyRuns, r.data.items)
        : r.data.items,
      historyTotal: r.data.total,
      historyPage: page,
      historyLoading: false,
    }));
  }

  function dropGraph(id: number): void {
    set((s) => ({
      graphs: s.graphs.filter((g) => g.id !== id),
      graphsTotal: Math.max(0, s.graphsTotal - 1),
    }));
  }

  async function fetchRunNodes(runId: number): Promise<void> {
    // 无连接静默（不写键不置 loading——「无节点级详情」是数据断言，
    // 真因没连接时由页面呈现失败态+重试，不伪造空数组）
    if (activeTransport() === null) {
      return;
    }
    const token = (runNodesSeq.get(runId) ?? 0) + 1;
    runNodesSeq.set(runId, token);
    set((s) => ({ runNodesLoading: { ...s.runNodesLoading, [runId]: true } }));
    const r = await automationRunNodes(runId);
    if (token !== runNodesSeq.get(runId)) return;
    if (!r.ok) {
      // 业务错/网络错：保守不动旧集（fetchGraphs 同款）；页面失败态可重试
      set((s) => ({
        runNodesLoading: { ...s.runNodesLoading, [runId]: false },
      }));
      return;
    }
    set((s) => ({
      runNodes: { ...s.runNodes, [runId]: r.data },
      runNodesLoading: { ...s.runNodesLoading, [runId]: false },
    }));
  }

  function dropTask(id: number): void {
    set((s) => ({
      tasks: s.tasks.filter((x) => x.id !== id),
      tasksTotal: Math.max(0, s.tasksTotal - 1),
    }));
  }

  return {
    graphs: [],
    graphsTotal: 0,
    graphsPage: 1,
    graphsLoading: false,
    tasks: [],
    tasksTotal: 0,
    tasksPage: 1,
    tasksLoading: false,
    runs: {},
    historyRuns: [],
    historyTotal: 0,
    historyPage: 1,
    historyLoading: false,
    historyFilter: null,
    historyTaskId: null,
    runNodes: {},
    runNodesLoading: {},

    loadGraphs: () => fetchGraphs(1, false),

    loadMoreGraphs: () => {
      const { graphs, graphsTotal, graphsLoading, graphsPage } = get();
      if (graphsLoading || graphs.length >= graphsTotal) {
        return Promise.resolve();
      }
      return fetchGraphs(graphsPage + 1, true);
    },

    loadTasks: () => fetchTasks(1, false),

    loadHistory: () => fetchHistory(1, false),

    loadMoreHistory: () => {
      const { historyRuns, historyTotal, historyLoading, historyPage } = get();
      if (historyLoading || historyRuns.length >= historyTotal) {
        return Promise.resolve();
      }
      return fetchHistory(historyPage + 1, true);
    },

    setHistoryFilter: (status) => {
      set({ historyFilter: status });
      void fetchHistory(1, false);
    },

    setHistoryTaskId: (taskId) => {
      set({ historyTaskId: taskId });
      void fetchHistory(1, false);
    },

    loadRunNodes: (runId) => fetchRunNodes(runId),

    /** 离开详情页清理（卸载调用）：节点全文载荷不驻留内存，事件重拉
     *  guard 恢复「正在浏览」语义（否则后台对已离开的 run 持续全量拉取） */
    clearRunNodes: (runId) => {
      runNodesSeq.delete(runId);
      set((s) => {
        const { [runId]: _nodes, ...restNodes } = s.runNodes;
        const { [runId]: _loading, ...restLoading } = s.runNodesLoading;
        return { runNodes: restNodes, runNodesLoading: restLoading };
      });
    },

    loadMoreTasks: () => {
      const { tasks, tasksTotal, tasksLoading, tasksPage } = get();
      if (tasksLoading || tasks.length >= tasksTotal) {
        return Promise.resolve();
      }
      return fetchTasks(tasksPage + 1, true);
    },

    runGraph: async (graphId) => {
      const r = await graphRun(graphId);
      if (!r.ok) return { ok: false, code: r.code, message: r.message };
      set((s) => ({
        runs: {
          ...s.runs,
          [graphId]: { runId: r.data.runId, state: "running" },
        },
      }));
      return OUTCOME_OK;
    },

    abortRun: async (graphId) => {
      const entry = get().runs[graphId];
      if (!entry) return { ok: false, code: "", message: "" };
      const r = await graphRunAbort(entry.runId);
      return r.ok
        ? OUTCOME_OK
        : { ok: false, code: r.code, message: r.message };
    },

    toggleTask: async (task, next) => {
      // 乐观翻转（Switch 即时反馈）；失败以服务端真值重拉还原
      set((s) => ({
        tasks: s.tasks.map((x) =>
          x.id === task.id ? { ...x, enabled: next } : x,
        ),
      }));
      const r = await automationSave(toTaskSaveParams(task, next));
      if (!r.ok) {
        void get().loadTasks();
        return { ok: false, code: r.code, message: r.message };
      }
      // save 回参即服务端新行：原位覆写（automation.changed 亦会重拉，幂等）
      if (r.data) {
        set((s) => ({
          tasks: s.tasks.map((x) => (x.id === r.data!.id ? r.data! : x)),
        }));
      }
      return OUTCOME_OK;
    },

    runNow: async (taskId) => {
      const r = await automationRunNow(taskId);
      return r.ok
        ? OUTCOME_OK
        : { ok: false, code: r.code, message: r.message };
    },

    deleteGraph: async (id) => {
      const r = await graphDelete(id);
      if (!r.ok) return { ok: false, code: r.code, message: r.message };
      dropGraph(id);
      return OUTCOME_OK;
    },

    deleteTask: async (id) => {
      const r = await automationDelete([id]);
      if (!r.ok) return { ok: false, code: r.code, message: r.message };
      dropTask(id);
      return OUTCOME_OK;
    },

    bindEvents: () => {
      if (eventsBound) return;
      eventsBound = true;
      subscribeTransportEvents((e: ServerEvent) => {
        if (e.type === "graph.run.updated") {
          const { graphId, runId, state, output, error, progress } = e.payload;
          const prev = get().runs[graphId];
          notifyGraphDone(
            prev?.state,
            state,
            get().graphs.find((g) => g.id === graphId)?.name,
          );
          set((s) => ({
            runs: {
              ...s.runs,
              [graphId]: {
                runId,
                state,
                ...(output !== undefined ? { output } : {}),
                ...(error !== undefined ? { error } : {}),
              },
            },
          }));
          // 节点详情浏览中（详情页已拉过该 run）：流式推进即重拉节点行。
          // 纯「节点起跑」进度跳过——graphRunNode 行只在节点完成时落库，
          // 重拉必为旧表（executor 每节点起跑/完成双发事件，跳过省一半
          // 全量 POST，载荷为节点全文最重）
          if (
            get().runNodes[runId] !== undefined &&
            !(state === "running" && progress?.nodeStatus === "running")
          ) {
            void get().loadRunNodes(runId);
          }
          return;
        }
        if (e.type === "automation.changed") {
          void get().loadTasks();
          // 运行收尾/任务变更也刷新历史页（在浏览时实时追平；非浏览态
          // 空列表重拉为静默 no-op 面请求——historyFilter/historyTaskId 保留）
          void get().loadHistory();
          return;
        }
        if (e.type === "server.connected") {
          // 只清 runs 投影（断流终局已失宁清不卡）；节点详情不清——
          // 浏览中重连不得空白已开的时间线（驻留由详情页卸载清理负责）
          set({ runs: {} });
          // 能力门控（Fix Round 1 + CRUD 批）：graph/automation 任一能力才
          // 拉对应列表——桌面被控端报 automation 不报 graph（graph/query
          // 必败不发），无头端报 graph 时 graph+tasks 双拉（tasks 对其恒可达）
          const caps = e.payload.capabilities;
          if (caps.includes("graph")) {
            void get().loadGraphs();
            void get().loadTasks();
          } else if (caps.includes("automation")) {
            void get().loadTasks();
          }
        }
      });
    },
  };
});
