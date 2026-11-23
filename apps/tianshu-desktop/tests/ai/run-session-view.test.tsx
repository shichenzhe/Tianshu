// @vitest-environment jsdom
/**
 * 固定运行入口：URL 选 run、结果视图与首次追问懒建会话。
 * IPC 是唯一外部边界；ChatPane 已由 session-resolver 专项覆盖，此处仅
 * 保留可发送的轻桩以验证 RunSessionView 的 resolver 接线。
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
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { RunOwner } from "@tianshu/core/run-session";
import type { RunRecord } from "../../src-react/domains/ai/automation/api/automation.api";
import { AutomationApi } from "../../src-react/domains/ai/automation/api/automation.api";
import SessionApi, {
  type SessionRecord,
} from "../../src-react/domains/ai/api/session.api";

vi.hoisted(() => {
  const memory = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, value),
      removeItem: (key: string) => memory.delete(key),
      clear: () => memory.clear(),
    },
    configurable: true,
  });
});

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

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    // 插值假体：带 n 的 key 追加 `·n`（occurrenceNote 等插值文本可断言）
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) =>
        options && "n" in options ? `${key}·${String(options.n)}` : key,
      i18n: { language: "zh-CN" },
    }),
  };
});

const invokeMock = vi.hoisted(() => vi.fn());
const ensureRunSessionMock = vi.hoisted(() => vi.fn());
const sendFollowUpMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({
  invoke: (channel: string, ...args: unknown[]) => invokeMock(channel, ...args),
  on: () => () => {},
  send: () => {},
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn() },
}));

interface PaneProps {
  session: SessionRecord;
  sessionResolver?: () => Promise<{ session: SessionRecord }>;
  onSessionResolved?: (session: SessionRecord) => void;
  initialDraft?: string;
  onDraftUnmount?: (draft: string) => void;
}
vi.mock("../../src-react/domains/ai/chat/components/ChatPane", async () => {
  const { createElement, useEffect, useRef, useState } = await import("react");
  // 草稿契约镜像 ChatPane → ChatInput：initialDraft 仅作初值回灌，
  // 卸载时以最新草稿回调 onDraftUnmount 一次（不逐键入回调）
  return {
    default: (props: PaneProps) => {
      const [draft, setDraft] = useState(props.initialDraft ?? "");
      const draftRef = useRef(draft);
      draftRef.current = draft;
      useEffect(() => () => props.onDraftUnmount?.(draftRef.current), []);
      return createElement(
        "div",
        { "data-testid": "run-chat-pane" },
        createElement("span", null, `session-${props.session.id}`),
        createElement("textarea", {
          "aria-label": "follow-up",
          value: draft,
          onChange: (event: { target: { value: string } }) =>
            setDraft(event.target.value),
        }),
        createElement(
          "button",
          {
            type: "button",
            onClick: () => {
              void (async () => {
                const resolved = props.sessionResolver
                  ? await props.sessionResolver()
                  : { session: props.session };
                await sendFollowUpMock();
                props.onSessionResolved?.(resolved.session);
              })().catch(() => undefined);
            },
          },
          "send-follow-up",
        ),
      );
    },
  };
});
vi.mock("../../src-react/domains/ai/chat/components/MessageList", () => ({
  default: () => null,
}));

/** GraphRunDetail 模块边界 mock：记录 props（断言 run/trace 透传），
 * 步骤行按钮回调 onSelectOccurrence（真 NodeRunDialog 集成在弹框侧） */
const graphDetail = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
}));
vi.mock(
  "../../src-react/domains/ai/automation/components/graph-run-detail",
  async () => {
    const { createElement } = await import("react");
    return {
      default: (props: {
        trace?: Array<{ name?: string; outputPreview?: string }>;
        onSelectOccurrence: (index: number) => void;
      }) => {
        graphDetail.props.push(props);
        return createElement(
          "div",
          { "data-testid": "graph-run-detail" },
          (props.trace ?? []).map((entry, index) =>
            createElement(
              "div",
              { key: index },
              createElement(
                "button",
                {
                  type: "button",
                  "data-testid": `run-step-row-${index}`,
                  onClick: () => props.onSelectOccurrence(index),
                },
                entry.name ?? "",
              ),
              entry.outputPreview
                ? createElement("span", null, entry.outputPreview)
                : null,
            ),
          ),
        );
      },
    };
  },
);

import RunSessionView from "../../src-react/domains/ai/automation/views/RunSessionView";
import ChatView from "../../src-react/domains/ai/chat/views/ChatView";
import {
  setRunDraft,
  getRunDraft,
} from "../../src-react/domains/ai/automation/lib/run-draft-store";
import { usePageHeaderStore } from "../../src-react/components/layout/page-header.store";
import {
  capsOfCapabilities,
  useHostStore,
} from "../../src-react/domains/ai/data-source/host.store";

const TASK_OWNER: RunOwner = { kind: "task", ownerId: 4 };
const GRAPH_OWNER: RunOwner = { kind: "graph", ownerId: 3 };

function makeRun(id: number, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    taskId: 4,
    taskName: "Daily report",
    workspaceId: 7,
    sessionId: id + 100,
    attempt: 1,
    triggerType: "manual",
    status: "success",
    durationMs: 1200,
    startedAt: `2026-11-20T${String(id).padStart(2, "0")}:00:00.000Z`,
    ...overrides,
  };
}

function makeSession(id: number, run: RunRecord): SessionRecord {
  return {
    id,
    workspaceId: run.workspaceId ?? 7,
    currentModelId: 1,
    title: run.taskName,
    mode: "agent",
    createdAt: run.startedAt,
    updatedAt: run.startedAt,
    automationTaskId: run.taskId,
    runGraphId: run.taskId === null ? run.graphId : null,
    automationRunId: run.id,
  };
}

let runs: RunRecord[];
let sessions: Map<number, SessionRecord>;
let queryClient: QueryClient;

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">{`${location.pathname}${location.search}`}</div>
  );
}

function HeaderHost() {
  const slot = usePageHeaderStore((state) => state.slot);
  return <>{slot?.trailing}</>;
}

function defaultInvoke(channel: string, ...args: unknown[]): unknown {
  switch (channel) {
    case "provider:list":
      return [{ id: 1, name: "Provider" }];
    case "model:listAll":
      return [];
    case "workspace:list":
      return [
        {
          id: 7,
          name: "Workspace 7",
          defaultModelId: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: 8,
          name: "Workspace 8",
          defaultModelId: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ];
    case "session:listAll":
      return [...sessions.values()];
    case "session:getById":
      return sessions.get((args[0] as { id: number }).id) ?? null;
    case "automation:runs:page":
      return { total: runs.length, items: runs };
    case "orchestration:runs":
      return { total: runs.length, items: runs };
    case "automation:run:get":
      return runs.find((run) => run.id === args[0]) ?? null;
    case "automation:run:ensureSession":
      return ensureRunSessionMock(...args);
    case "orchestration:runNodes":
      return [];
    default:
      return [];
  }
}

function renderOwner(owner: RunOwner, entry: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <LocationProbe />
        <HeaderHost />
        <RunSessionView owner={owner} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderTask(entry = "/module/ai?automation=4") {
  return renderOwner(TASK_OWNER, entry);
}

beforeEach(() => {
  runs = [
    makeRun(10, { startedAt: "2026-11-20T10:00:00.000Z" }),
    makeRun(9, { startedAt: "2026-11-20T09:00:00.000Z" }),
  ];
  sessions = new Map(
    runs.map((run) => [run.sessionId!, makeSession(run.sessionId!, run)]),
  );
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  invokeMock.mockReset().mockImplementation(defaultInvoke);
  ensureRunSessionMock.mockReset();
  sendFollowUpMock.mockReset().mockResolvedValue(undefined);
  useHostStore.getState().switchHost({ kind: "local" });
  graphDetail.props.length = 0;
  setRunDraft(9, "");
  setRunDraft(10, "");
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  usePageHeaderStore.getState().setPageHeader(null);
  vi.restoreAllMocks();
});

describe("RunSessionView 运行选择", () => {
  it("缺省 run 跟随分页最新运行", async () => {
    renderTask();
    expect(await screen.findByText("session-110")).toBeTruthy();

    const latest = makeRun(11, { startedAt: "2026-11-20T11:00:00.000Z" });
    runs = [latest, ...runs];
    sessions.set(111, makeSession(111, latest));
    await act(() =>
      queryClient.invalidateQueries({ queryKey: ["automation"] }),
    );

    expect(await screen.findByText("session-111")).toBeTruthy();
  });

  it("graph 固定入口的缺省运行与看板只查询顶层运行", async () => {
    runs = [
      makeRun(9, {
        taskId: null,
        graphId: 3,
        sessionId: 90,
      }),
    ];
    sessions = new Map([[90, makeSession(90, runs[0])]]);

    renderOwner(GRAPH_OWNER, "/module/ai?graphRun=3");

    expect(await screen.findByText("session-90")).toBeTruthy();
    expect(await screen.findByTestId("run-board-item-9")).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith("orchestration:runs", 3, 1, true);
  });

  it("页头只保留会话搜索，不再出现运行下拉触发器", async () => {
    renderTask();
    expect(await screen.findByTestId("run-board-item-10")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("任务与图固定入口均渲染右侧运行看板", async () => {
    renderTask();
    expect(await screen.findByTestId("run-board-item-10")).toBeTruthy();
    expect(screen.getByTestId("run-board-list")).toBeTruthy();
    expect(screen.getByText("chat:runSession.board.title")).toBeTruthy();
    cleanup();

    runs = [
      makeRun(9, {
        taskId: null,
        graphId: 3,
        sessionId: 90,
      }),
    ];
    sessions = new Map([[90, makeSession(90, runs[0])]]);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderOwner(GRAPH_OWNER, "/module/ai?graphRun=3");
    expect(await screen.findByTestId("run-board-item-9")).toBeTruthy();
    expect(screen.getByTestId("run-board-list")).toBeTruthy();
  });

  it("owner 切换即时清空旧看板条目（不闪旧 owner 数据）", async () => {
    const view = renderTask();
    expect(await screen.findByTestId("run-board-item-10")).toBeTruthy();

    // 新 owner 首页延迟返回：切换提交的瞬间不得残留旧 owner 条目
    let resolveGraphRuns: (value: unknown) => void = () => {};
    const graphRunsDeferred = new Promise((resolve) => {
      resolveGraphRuns = resolve;
    });
    invokeMock.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === "orchestration:runs") return graphRunsDeferred;
      return defaultInvoke(channel, ...args);
    });
    const graphRun = makeRun(9, { taskId: null, graphId: 3, sessionId: 90 });
    runs = [graphRun];
    sessions = new Map([[90, makeSession(90, graphRun)]]);

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/module/ai?graphRun=3"]}>
          <LocationProbe />
          <HeaderHost />
          <RunSessionView owner={GRAPH_OWNER} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.queryByTestId("run-board-item-10")).toBeNull();

    await act(async () => {
      resolveGraphRuns({ total: 1, items: [graphRun] });
    });
    expect(await screen.findByTestId("run-board-item-9")).toBeTruthy();
  });

  it("显式 run 在新运行完成后保持原检查点", async () => {
    renderTask("/module/ai?automation=4&run=9");
    expect(await screen.findByText("session-109")).toBeTruthy();

    const latest = makeRun(11, { startedAt: "2026-11-20T11:00:00.000Z" });
    runs = [latest, ...runs];
    sessions.set(111, makeSession(111, latest));
    await act(() =>
      queryClient.invalidateQueries({ queryKey: ["automation"] }),
    );

    expect(screen.getByText("session-109")).toBeTruthy();
    expect(screen.queryByText("session-111")).toBeNull();
  });

  it("已删除的显式 run 回到 owner-only URL 并解析最新运行", async () => {
    runs = [runs[0]];
    sessions = new Map([[110, makeSession(110, runs[0])]]);
    renderTask("/module/ai?automation=4&run=9");

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/module/ai?automation=4",
      ),
    );
    expect(await screen.findByText("session-110")).toBeTruthy();
  });

  it("owner 不匹配的显式 run 不展示并回到该 owner 最新运行", async () => {
    runs[1] = makeRun(9, { taskId: 99, taskName: "Other task" });
    sessions.set(109, makeSession(109, runs[1]));
    renderTask("/module/ai?automation=4&run=9");

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/module/ai?automation=4",
      ),
    );
    expect(await screen.findByText("session-110")).toBeTruthy();
    expect(screen.queryByText("session-109")).toBeNull();
  });

  it("显式 run 的瞬态网络错误保留 URL 且不重定向", async () => {
    invokeMock.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === "automation:run:get" && args[0] === 9) {
        return Promise.reject(new Error("NETWORK_DOWN"));
      }
      return defaultInvoke(channel, ...args);
    });
    renderTask("/module/ai?automation=4&run=9");

    expect(await screen.findByText("NETWORK_DOWN")).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe(
      "/module/ai?automation=4&run=9",
    );
  });

  it("看板条目点击切换 canonical run URL", async () => {
    renderTask("/module/ai?automation=4&run=10");
    expect(await screen.findByText("session-110")).toBeTruthy();
    fireEvent.click(await screen.findByTestId("run-board-item-9"));

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toContain(
        "automation=4&run=9",
      ),
    );
    expect(await screen.findByText("session-109")).toBeTruthy();
  });
});

describe("RunSessionView 结果与追问", () => {
  it("prompt run 直接复用原始会话", async () => {
    renderTask("/module/ai?automation=4&run=9");
    expect(await screen.findByText("session-109")).toBeTruthy();
    expect(screen.getByRole("textbox")).toBeTruthy();
    expect(ensureRunSessionMock).not.toHaveBeenCalled();
  });

  it("graph run 展示最终输出与节点轨迹，并允许伴随追问", async () => {
    runs = [
      makeRun(9, {
        taskId: null,
        graphId: 3,
        sessionId: undefined,
        graphTrace: JSON.stringify([
          {
            id: "node-1",
            name: "Final node",
            status: "success",
            startedAt: "2026-11-20T09:00:00.000Z",
            durationMs: 20,
            outputPreview: "final-output",
          },
        ]),
      }),
    ];
    sessions = new Map();
    renderOwner(GRAPH_OWNER, "/module/ai?graphRun=3&run=9");

    expect(await screen.findByText("final-output")).toBeTruthy();
    expect(screen.getByText("Final node")).toBeTruthy();
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("首次发送失败后的重试仍只 ensure 一次并复用真实会话", async () => {
    runs = [makeRun(9, { sessionId: undefined })];
    sessions = new Map();
    ensureRunSessionMock.mockResolvedValue({
      runId: 9,
      sessionId: 190,
      created: true,
    });
    sendFollowUpMock.mockRejectedValueOnce(new Error("SEND_FAILED"));
    sessions.set(190, makeSession(190, runs[0]));
    renderTask("/module/ai?automation=4&run=9");
    const send = await screen.findByRole("button", { name: "send-follow-up" });

    fireEvent.click(send);
    expect(await screen.findByText("session-190")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "send-follow-up" }));

    await waitFor(() => expect(sendFollowUpMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(ensureRunSessionMock).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith("session:getById", { id: 190 });
  });

  it("RUN_WORKSPACE_REQUIRED 仅在用户显式选择后带 workspaceId 重试", async () => {
    runs = [makeRun(9, { sessionId: undefined, workspaceId: undefined })];
    sessions = new Map();
    ensureRunSessionMock
      .mockRejectedValueOnce(new Error("RUN_WORKSPACE_REQUIRED"))
      .mockResolvedValueOnce({ runId: 9, sessionId: 190, created: true });
    sessions.set(190, makeSession(190, runs[0]));
    renderTask("/module/ai?automation=4&run=9");
    fireEvent.click(
      await screen.findByRole("button", { name: "send-follow-up" }),
    );

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(ensureRunSessionMock).toHaveBeenCalledWith(9, undefined);
    fireEvent.click(screen.getByRole("button", { name: "Workspace 8" }));
    fireEvent.click(screen.getByRole("button", { name: "common:confirm" }));

    expect(await screen.findByText("session-190")).toBeTruthy();
    expect(ensureRunSessionMock).toHaveBeenCalledTimes(2);
    expect(ensureRunSessionMock).toHaveBeenLastCalledWith(9, 8);
  });

  it.each(["running", "skipped"] as const)(
    "%s 不显示追问输入",
    async (status) => {
      runs = [makeRun(9, { sessionId: undefined, status })];
      sessions = new Map();
      renderTask("/module/ai?automation=4&run=9");

      expect(
        await screen.findAllByText(
          `chat:automation.runs.status${status === "running" ? "Running" : "Skipped"}`,
        ),
      ).toBeTruthy();
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(ensureRunSessionMock).not.toHaveBeenCalled();
    },
  );

  it("failed 且没有原始会话时显示错误并允许补建追问", async () => {
    runs = [
      makeRun(9, {
        sessionId: undefined,
        status: "failed",
        error: "run-failed-output",
      }),
    ];
    sessions = new Map();
    renderTask("/module/ai?automation=4&run=9");

    // 主区错误段落 + 看板条目失败摘要各一处
    expect(await screen.findAllByText("run-failed-output")).toHaveLength(2);
    expect(screen.getByRole("textbox")).toBeTruthy();
  });
});

describe("RunSessionView 图运行详情与按次草稿", () => {
  function graphTrace() {
    return JSON.stringify([
      {
        id: "node-1",
        name: "First node",
        status: "success",
        startedAt: "2026-11-20T09:00:00.000Z",
        durationMs: 10,
      },
      {
        id: "node-2",
        name: "Second node",
        status: "success",
        startedAt: "2026-11-20T09:00:01.000Z",
        durationMs: 20,
        outputPreview: "final-output",
      },
    ]);
  }

  function renderGraphRun(trace: string, overrides: Partial<RunRecord> = {}) {
    runs = [
      makeRun(9, {
        taskId: null,
        graphId: 3,
        sessionId: undefined,
        graphTrace: trace,
        ...overrides,
      }),
    ];
    sessions = new Map();
    return renderOwner(GRAPH_OWNER, "/module/ai?graphRun=3&run=9");
  }

  it("图运行渲染 GraphRunDetail（透传 run/trace），不再渲染旧线性轨迹", async () => {
    renderGraphRun(graphTrace());
    expect(await screen.findByTestId("graph-run-detail")).toBeTruthy();
    const detailProps = graphDetail.props[graphDetail.props.length - 1];
    expect((detailProps.run as RunRecord).id).toBe(9);
    expect(
      (detailProps.trace as Array<{ id: string }>).map((entry) => entry.id),
    ).toEqual(["node-1", "node-2"]);
    expect(detailProps.selectedOccurrence).toBeNull();
    // 旧 GraphRunResult 的内联轨迹视图不再渲染（弹框也尚未打开）
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("点击步骤行打开节点弹框，onClose 后消失且详情视图保留", async () => {
    renderGraphRun(graphTrace());
    fireEvent.click(await screen.findByTestId("run-step-row-1"));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Second node")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("graph-run-detail")).toBeTruthy();
    expect(screen.getByTestId("run-step-row-1")).toBeTruthy();
  });

  it("弹框内就地导航：保持打开、tab 回落默认、occurrence 提示可见", async () => {
    renderGraphRun(
      JSON.stringify([
        {
          id: "node-a",
          name: "Retry node",
          status: "failed",
          startedAt: "2026-11-20T09:00:00.000Z",
          durationMs: 30,
          error: { code: "E_BOOM", message: "boom" },
        },
        {
          id: "node-a",
          name: "Retry node",
          status: "success",
          startedAt: "2026-11-20T09:00:02.000Z",
          durationMs: 40,
        },
        {
          id: "node-b",
          name: "Tail node",
          status: "success",
          startedAt: "2026-11-20T09:00:03.000Z",
          durationMs: 50,
        },
      ]),
    );
    fireEvent.click(await screen.findByTestId("run-step-row-0"));

    const dialog = await screen.findByRole("dialog");
    // failed occurrence 默认错误页；非末次 occurrence 显示插值提示
    expect(
      within(dialog)
        .getByRole("tab", { name: "chat:runSession.node.tabs.error" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByText("chat:runSession.detail.occurrenceNote·1"),
    ).toBeTruthy();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "chat:runSession.node.next" }),
    );
    // 原地切到 occurrence 1：弹框保持打开、回落默认摘要页、提示消失
    const updated = screen.getByRole("dialog");
    expect(
      within(updated)
        .getByRole("tab", { name: "chat:runSession.node.tabs.summary" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.queryByText(/occurrenceNote/)).toBeNull();
    expect(screen.queryByText("E_BOOM")).toBeNull();
  });

  it("按次草稿：切走再切回恢复，且绝不携带到另一运行", async () => {
    renderTask("/module/ai?automation=4&run=10");
    await screen.findByText("session-110");
    fireEvent.change(screen.getByLabelText("follow-up"), {
      target: { value: "draft-for-run-10" },
    });

    fireEvent.click(screen.getByTestId("run-board-item-9"));
    await screen.findByText("session-109");
    expect(
      (screen.getByLabelText("follow-up") as HTMLTextAreaElement).value,
    ).toBe("");

    fireEvent.click(screen.getByTestId("run-board-item-10"));
    await screen.findByText("session-110");
    expect(
      (screen.getByLabelText("follow-up") as HTMLTextAreaElement).value,
    ).toBe("draft-for-run-10");
    // 草稿按次落库：run 10 有、run 9 从未出现 run 10 的草稿
    expect(getRunDraft(10)).toBe("draft-for-run-10");
    expect(getRunDraft(9)).toBe("");
  });
});

describe("ChatView 旧运行会话深链", () => {
  it("旧远程主机停留在固定 URL 时走普通空态且零新端点调用", async () => {
    useHostStore.setState({
      activeHost: { kind: "remote", connId: "old-host" },
      caps: capsOfCapabilities(["chat", "graph"]),
    });
    const listAll = vi.spyOn(SessionApi, "listAll").mockResolvedValue([]);
    const runGroups = vi
      .spyOn(AutomationApi, "runGroups")
      .mockResolvedValue([]);
    const runById = vi
      .spyOn(AutomationApi, "runById")
      .mockResolvedValue(makeRun(9));
    const ensure = vi
      .spyOn(AutomationApi, "ensureRunSession")
      .mockResolvedValue({ runId: 9, sessionId: 109, created: false });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/module/ai?automation=4&run=9"]}>
          <LocationProbe />
          <ChatView />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(listAll).toHaveBeenCalled());
    expect(runGroups).not.toHaveBeenCalled();
    expect(runById).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    expect(screen.queryByTestId("run-board-list")).toBeNull();
    expect(screen.queryByTestId("run-board-pinned")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByTestId("run-chat-pane")).toBeNull();
  });

  it("?session= 规范化为固定任务入口与 run", async () => {
    const run = runs[1];
    sessions = new Map([[109, makeSession(109, run)]]);
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/module/ai?session=109"]}>
          <LocationProbe />
          <ChatView />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/module/ai?automation=4&run=9",
      ),
    );
    expect(await screen.findByText("session-109")).toBeTruthy();
  });
});
