// @vitest-environment jsdom
// RunHistoryPanel 行点击三分支：graph run（graphId 无 sessionId）→ 弹
// GraphRunHistoryDialog（GraphApi.runs(graphId) 被调、不跳路由）；prompt run
// （sessionId 无 graphId）→ 跳会话（现状不变）。i18n/react-router mock 先例
// tests/ai/graph-test-run-dialog.test.tsx / graph-editor-view.test.tsx。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const taskRuns = vi.fn();
const graphRuns = vi.fn();
const navigateMock = vi.fn();
vi.mock("../../src-react/domains/ai/automation/api/automation.api", () => ({
  AutomationApi: { runs: (...a: unknown[]) => taskRuns(...a) },
  // GraphRunHistoryDialog 顶层解构 import 该事件常量，mock 须同为顶层导出
  AUTOMATION_CHANGED_EVENT: "automation:tasks-changed",
}));
vi.mock(
  "../../src-react/domains/ai/orchestration/api/orchestration.api",
  () => ({
    GraphApi: { runs: (...a: unknown[]) => graphRuns(...a) },
    GRAPH_CHANGED_EVENT: "orchestration:graphs-changed",
  }),
);
vi.mock("react-router-dom", () => ({ useNavigate: () => navigateMock }));
vi.mock(
  "../../src-react/domains/ai/orchestration/components/GraphRunTraceView",
  () => ({
    default: () => <div data-testid="graph-run-trace" />,
    parseTrace: (trace: string) => trace,
  }),
);
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/ipc", () => ({ invoke: vi.fn(), on: () => () => {} }));

import RunHistoryPanel from "../../src-react/domains/ai/automation/components/RunHistoryPanel";
import RunHistoryView from "../../src-react/domains/ai/automation/views/RunHistoryView";
import {
  LOCAL_HOST_CAPS,
  useHostStore,
} from "../../src-react/domains/ai/data-source/host.store";

/** RunRecord 最小形状（automation.api.ts：taskId/taskName/attempt 必填） */
function run(over: Record<string, unknown>) {
  return {
    id: 1,
    taskId: 1,
    taskName: "任务",
    attempt: 1,
    triggerType: "schedule",
    status: "success",
    durationMs: 100,
    startedAt: "2026-10-22T10:00:00Z",
    ...over,
  };
}

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RunHistoryPanel taskId={1} />
    </QueryClientProvider>,
  );
}

function renderView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RunHistoryView />
    </QueryClientProvider>,
  );
}

describe("RunHistoryPanel 行点击三分支（graph run 弹运行历史）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useHostStore.setState({
      activeHost: { kind: "local" },
      caps: LOCAL_HOST_CAPS,
    });
    // graph run（executor 落库：graphId/graphTrace、无 sessionId）+ prompt run
    taskRuns.mockResolvedValue({
      total: 2,
      items: [
        run({ id: 11, graphId: 5, graphTrace: "{}" }),
        run({ id: 12, sessionId: 9 }),
      ],
    });
    graphRuns.mockResolvedValue({ total: 0, items: [] });
  });
  afterEach(() => cleanup());

  it("本地任务运行（含图任务）统一进入 automation + run 固定深链", async () => {
    renderPanel();
    const labels = await screen.findAllByText("chat:runSessions.openRun");
    expect(labels).toHaveLength(2);

    fireEvent.click(labels[0]);
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(
        "/module/ai?automation=1&run=11",
      ),
    );
    fireEvent.click(labels[1]);
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(
        "/module/ai?automation=1&run=12",
      ),
    );
    expect(graphRuns).not.toHaveBeenCalled();
  });

  it("旧远程主机保留图历史弹窗和 session 深链", async () => {
    useHostStore.setState({
      activeHost: { kind: "remote", connId: "old" },
      caps: { ...LOCAL_HOST_CAPS, runSessions: false },
    });
    renderPanel();

    fireEvent.click(
      await screen.findByText("chat:automation.history.viewGraphRuns"),
    );
    await waitFor(() => expect(graphRuns).toHaveBeenCalledWith(5, 1));
    expect(navigateMock).not.toHaveBeenCalled();

    fireEvent.click(
      await screen.findByText("chat:automation.history.viewSession"),
    );
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/module/ai?session=9"),
    );
  });

  it("全局运行历史本地按任务优先/顶层图归属进入固定深链", async () => {
    taskRuns.mockResolvedValue({
      total: 2,
      items: [
        run({ id: 21, taskId: 7, graphId: 5, sessionId: 9 }),
        run({
          id: 22,
          taskId: null,
          graphId: 3,
          taskName: "顶层工作流",
          graphTrace: "{}",
        }),
      ],
    });
    renderView();

    const graphTask = await screen.findByText("任务");
    fireEvent.click(graphTask.closest("tr") as HTMLTableRowElement);
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(
        "/module/ai?automation=7&run=21",
      ),
    );
    fireEvent.click(
      screen.getByText("顶层工作流").closest("tr") as HTMLTableRowElement,
    );
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/module/ai?graphRun=3&run=22"),
    );
    expect(screen.queryByTestId("graph-run-trace")).toBeNull();
  });

  it("旧远程主机的全局图运行仍就地展开轨迹", async () => {
    useHostStore.setState({
      activeHost: { kind: "remote", connId: "old" },
      caps: { ...LOCAL_HOST_CAPS, runSessions: false },
    });
    taskRuns.mockResolvedValue({
      total: 1,
      items: [
        run({
          id: 22,
          taskId: null,
          graphId: 3,
          taskName: "顶层工作流",
          graphTrace: "{}",
        }),
      ],
    });
    renderView();

    fireEvent.click(
      (await screen.findByText("顶层工作流")).closest(
        "tr",
      ) as HTMLTableRowElement,
    );
    expect(await screen.findByTestId("graph-run-trace")).toBeTruthy();
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
