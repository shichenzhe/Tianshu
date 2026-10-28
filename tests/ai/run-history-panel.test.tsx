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
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/ipc", () => ({ invoke: vi.fn(), on: () => () => {} }));

import RunHistoryPanel from "../../src-react/domains/ai/automation/components/RunHistoryPanel";

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

describe("RunHistoryPanel 行点击三分支（graph run 弹运行历史）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("graph run 行点击：弹运行历史弹窗（GraphApi.runs(graphId)），不跳路由", async () => {
    renderPanel();
    fireEvent.click(
      await screen.findByText("chat:automation.history.viewGraphRuns"),
    );
    await waitFor(() => expect(graphRuns).toHaveBeenCalledWith(5, 1));
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("prompt run 行点击：照旧跳会话（现状不变）", async () => {
    renderPanel();
    fireEvent.click(
      await screen.findByText("chat:automation.history.viewSession"),
    );
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/module/ai?session=9"),
    );
    expect(graphRuns).not.toHaveBeenCalled();
  });

  it("graph run 行尾提示在 prompt run 行不出现（文案按行类型区分）", async () => {
    renderPanel();
    await screen.findByText("chat:automation.history.viewGraphRuns");
    await screen.findByText("chat:automation.history.viewSession");
    expect(
      screen.getAllByText("chat:automation.history.viewGraphRuns"),
    ).toHaveLength(1);
  });
});
