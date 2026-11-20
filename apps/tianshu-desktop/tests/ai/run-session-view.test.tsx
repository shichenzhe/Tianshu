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
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { RunOwner } from "@tianshu/core/run-session";
import type { RunRecord } from "../../src-react/domains/ai/automation/api/automation.api";
import type { SessionRecord } from "../../src-react/domains/ai/api/session.api";

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
    useTranslation: () => ({
      t: (key: string) => key,
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
}
vi.mock("../../src-react/domains/ai/chat/components/ChatPane", async () => {
  const { createElement } = await import("react");
  return {
    default: (props: PaneProps) =>
      createElement(
        "div",
        { "data-testid": "run-chat-pane" },
        createElement("span", null, `session-${props.session.id}`),
        createElement("textarea", { "aria-label": "follow-up" }),
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
      ),
  };
});
vi.mock("../../src-react/domains/ai/chat/components/MessageList", () => ({
  default: () => null,
}));

import RunSessionView from "../../src-react/domains/ai/automation/views/RunSessionView";
import ChatView from "../../src-react/domains/ai/chat/views/ChatView";
import { usePageHeaderStore } from "../../src-react/components/layout/page-header.store";
import { useHostStore } from "../../src-react/domains/ai/data-source/host.store";

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
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  usePageHeaderStore.getState().setPageHeader(null);
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

  it("时间选择器切换 canonical run URL", async () => {
    renderTask("/module/ai?automation=4&run=10");
    expect(await screen.findByText("session-110")).toBeTruthy();
    const trigger = screen.getByRole("button", {
      name: "chat:runSession.selectRun",
    });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByTestId("run-option-9"));

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

    expect(await screen.findByText("run-failed-output")).toBeTruthy();
    expect(screen.getByRole("textbox")).toBeTruthy();
  });
});

describe("ChatView 旧运行会话深链", () => {
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
