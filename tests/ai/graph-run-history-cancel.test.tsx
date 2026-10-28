// @vitest-environment jsdom
// GraphRunHistoryDialog：running 行渲染中断按钮，点击 → cancelTestRun(graphId)；
// 失败（GRAPH_NOT_RUNNING）toast 错误；success 行不显示中断按钮。
// 不 mock react-i18next——实现经 mapIpcError 拉起真实 @/i18n（localStorage
// 无缓存回退 zh-CN，按钮 aria-label「中断运行」），正则兼容 key 形式兜底；
// @/lib/ipc mock on（jsdom 无 window.ipcRenderer，弹窗 useEffect 订阅
// graphs/tasks-changed 双通道，先例 tests/ai/graph-editor-view.test.tsx）。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const runs = vi.fn();
const cancel = vi.fn();
vi.mock(
  "../../src-react/domains/ai/orchestration/api/orchestration.api",
  () => ({
    GraphApi: {
      runs: (...a: unknown[]) => runs(...a),
      cancelTestRun: (...a: unknown[]) => cancel(...a),
    },
    // 弹窗从模块顶层解构 import（非 GraphApi 成员），mock 须同为顶层导出
    GRAPH_CHANGED_EVENT: "orchestration:graphs-changed",
  }),
);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/ipc", () => ({ invoke: vi.fn(), on: () => () => {} }));

import { toast } from "sonner";
import GraphRunHistoryDialog from "../../src-react/domains/ai/orchestration/components/GraphRunHistoryDialog";

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <GraphRunHistoryDialog open onOpenChange={() => {}} graphId={1} />
    </QueryClientProvider>,
  );
}

/** RunRecord 最小形状（automation.api.ts：taskId/taskName/attempt 必填） */
function run(over: Record<string, unknown>) {
  return {
    id: 9,
    taskId: null,
    taskName: "g",
    attempt: 1,
    triggerType: "manual",
    startedAt: "2026-10-08T10:00:00Z",
    durationMs: null,
    sessionId: null,
    ...over,
  };
}

describe("运行历史中断", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    cancel.mockResolvedValue(undefined);
  });

  it("running 行显示中断按钮，点击调用 cancelTestRun(1)", async () => {
    runs.mockResolvedValue({
      total: 1,
      items: [run({ id: 9, status: "running" })],
    });
    renderDialog();
    const btn = await screen.findByRole("button", { name: /中断|cancelRun/ });
    fireEvent.click(btn);
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(1));
  });

  it("成功行不显示中断按钮；取消失败 toast 错误", async () => {
    runs.mockResolvedValue({
      total: 1,
      items: [run({ id: 10, status: "success", durationMs: 100 })],
    });
    renderDialog();
    await screen.findByText(/2026-10-08|10:00/);
    expect(screen.queryByRole("button", { name: /中断|cancelRun/ })).toBeNull();

    cancel.mockRejectedValue(new Error("GRAPH_NOT_RUNNING"));
    runs.mockResolvedValue({
      total: 1,
      items: [run({ id: 11, status: "running" })],
    });
    renderDialog();
    fireEvent.click(
      await screen.findByRole("button", { name: /中断|cancelRun/ }),
    );
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(1));
    // GRAPH_NOT_RUNNING 经 mapIpcError 映射为 chat:errors 文案（非错误码原文）
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("没有正在运行的试运行"),
    );
  });
});
