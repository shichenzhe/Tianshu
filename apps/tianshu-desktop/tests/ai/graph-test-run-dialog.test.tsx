// @vitest-environment jsdom
// GraphTestRunDialog onStarted（触发成功即切历史弹窗信号）：runTest 成功
// 后调用 onStarted 并关弹窗；失败（GRAPH_ALREADY_RUNNING）不调 onStarted、
// 不关弹窗；回调缺席（编辑器调用点）行为不变。i18n/react-query mock 先例
// tests/ai/graph-editor-view.test.tsx。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const runTest = vi.fn();
vi.mock(
  "../../src-react/domains/ai/orchestration/api/orchestration.api",
  () => ({
    GraphApi: { runTest: (...a: unknown[]) => runTest(...a) },
  }),
);
vi.mock("@/domains/ai/api/workspace.api", () => ({
  WorkspaceApi: { list: async () => [{ id: 3, name: "ws" }] },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import GraphTestRunDialog from "../../src-react/domains/ai/orchestration/components/GraphTestRunDialog";

function renderDialog(
  onOpenChange: (open: boolean) => void,
  onStarted?: () => void,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <GraphTestRunDialog
        graphId={1}
        draftJson='{"version":1}'
        variables={[]}
        open
        onOpenChange={onOpenChange}
        onStarted={onStarted}
      />
    </QueryClientProvider>,
  );
}

/** 点执行按钮：先等 workspace 下拉 effect 选定（按钮解禁）再点击，
 *  避免与 workspaces query resolve 竞态（早退 handleRun 守卫） */
async function clickRun() {
  const label = await screen.findByText("chat:orchestration.testRun.button");
  const btn = label.closest("button")!;
  await waitFor(() => expect(btn.disabled).toBe(false));
  fireEvent.click(btn);
}

describe("GraphTestRunDialog onStarted（触发成功即切历史弹窗）", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("runTest 成功：调 onStarted 一次、关弹窗、入参透传", async () => {
    runTest.mockResolvedValue(undefined);
    const onStarted = vi.fn();
    const onOpenChange = vi.fn();
    renderDialog(onOpenChange, onStarted);
    await clickRun();
    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(runTest).toHaveBeenCalledWith(1, {}, 3, '{"version":1}');
  });

  it("runTest 失败（已在跑）：不调 onStarted、不关弹窗", async () => {
    runTest.mockRejectedValue(new Error("GRAPH_ALREADY_RUNNING"));
    const onStarted = vi.fn();
    const onOpenChange = vi.fn();
    renderDialog(onOpenChange, onStarted);
    await clickRun();
    await waitFor(() => expect(runTest).toHaveBeenCalledTimes(1));
    expect(onStarted).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("onStarted 缺席（编辑器调用点）：成功路径行为不变不炸", async () => {
    runTest.mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    renderDialog(onOpenChange);
    await clickRun();
    await waitFor(() => expect(runTest).toHaveBeenCalledTimes(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
