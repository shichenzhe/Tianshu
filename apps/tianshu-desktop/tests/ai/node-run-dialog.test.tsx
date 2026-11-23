// @vitest-environment jsdom
/**
 * NodeRunDialog 节点详情弹框（spec 2026-11-23 §3，Task 5）：
 * - failed 默认定位错误 Tab、非 failed 默认摘要 Tab（状态/时间/耗时/tokens）
 * - 末次 occurrence 命中 graphRunNode 行 → 输入/输出 Tab 全文 + 逐区块复制
 *   （navigator.clipboard.writeText + toast）
 * - 非末次 occurrence 回落 outputPreview + occurrence 提示，不冒充全文
 * - outputImage → MessageImage；工具 Tab 列 toolCalls（ok=false 标红）
 * - 底部上一/下一/下一失败节点导航与边界禁用；occurrence=null 不渲染
 * mock 骨架先例 tests/ai/run-history-panel.test.tsx（@/lib/ipc、@/i18n、
 * react-i18next）；GraphApi.runNodes 与 MessageImage 模块边界 mock。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const runNodesMock = vi.fn();
const navigateMock = vi.fn();
const closeMock = vi.fn();
vi.mock(
  "../../src-react/domains/ai/orchestration/api/orchestration.api",
  () => ({
    GraphApi: { runNodes: (...a: unknown[]) => runNodesMock(...a) },
  }),
);
vi.mock("../../src-react/domains/ai/chat/components/MessageImage", () => ({
  MessageImage: ({ imagePath }: { imagePath: string }) => (
    <div data-testid="message-image" data-path={imagePath} />
  ),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/ipc", () => ({ invoke: vi.fn(), on: () => () => {} }));

import { toast } from "sonner";
import type { AutomationRunDetail } from "@tianshu/protocol";
import NodeRunDialog, {
  isLastOccurrence,
} from "../../src-react/domains/ai/automation/components/node-run-dialog";
import type { TraceEntry } from "../../src-react/domains/ai/orchestration/components/GraphRunTraceView";
import { formatDateTime } from "../../src-react/domains/ai/automation/lib/run-display";

/** TraceEntry 最小形状（GraphRunTraceView 镜像类型） */
function entry(over: Partial<TraceEntry> = {}): TraceEntry {
  return {
    id: "n1",
    name: "节点一",
    status: "success",
    startedAt: "2026-11-23T08:30:00Z",
    durationMs: 1500,
    ...over,
  };
}

/** AutomationRunDetail 最小形状（弹框只消费 run.id 发节点行查询） */
function runDetail(): AutomationRunDetail {
  return {
    id: 7,
    taskId: null,
    taskName: "工作流",
    attempt: 1,
    triggerType: "manual",
    status: "failed",
    durationMs: 3000,
    startedAt: "2026-11-23T08:30:00Z",
    graphTrace: "[]",
    graphJsonSnapshot: null,
  };
}

/** GraphRunNodeRow 最小形状（orchestration.api.ts 全字段） */
function nodeRow(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    runId: 7,
    nodeId: "n1",
    nodeName: "节点一",
    status: "success",
    input: null,
    output: null,
    errorJson: null,
    toolCallsJson: null,
    promptTokens: null,
    completionTokens: null,
    durationMs: 1500,
    startedAt: "2026-11-23T08:30:00Z",
    outputImage: null,
    errorOutput: null,
    fallbackJson: null,
    ...over,
  };
}

function mount(trace: TraceEntry[], occurrence: number | null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <NodeRunDialog
        run={runDetail()}
        trace={trace}
        occurrence={occurrence}
        onClose={closeMock}
        onNavigate={navigateMock}
      />
    </QueryClientProvider>,
  );
}

function tab(name: string): HTMLButtonElement {
  return screen.getByRole("tab", { name }) as HTMLButtonElement;
}

function navButton(label: string): HTMLButtonElement {
  return screen.getByRole("button", { name: label }) as HTMLButtonElement;
}

describe("NodeRunDialog 节点详情弹框", () => {
  const writeTextMock = vi.fn(async () => undefined);

  beforeEach(() => {
    runNodesMock.mockReset();
    runNodesMock.mockResolvedValue([]);
    navigateMock.mockClear();
    closeMock.mockClear();
    writeTextMock.mockClear();
    vi.mocked(toast.success).mockClear();
    // W3C 剪贴板假体（jsdom 无 navigator.clipboard，先例
    // tests/app-settings/memory-dialogs.test.tsx）
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      configurable: true,
    });
  });
  afterEach(() => cleanup());

  it("failed 节点默认定位错误 Tab；摘要 Tab 含状态/时间/耗时/tokens", async () => {
    mount(
      [
        entry({
          status: "failed",
          error: { code: "E_TOOL", message: "boom", detail: "stderr line" },
          tokens: { promptTokens: 10, completionTokens: 5 },
        }),
      ],
      0,
    );
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(
      tab("chat:runSession.node.tabs.error").getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByText("E_TOOL")).toBeTruthy();
    expect(screen.getByText("boom")).toBeTruthy();
    expect(screen.getByText("stderr line")).toBeTruthy();

    fireEvent.click(tab("chat:runSession.node.tabs.summary"));
    expect(
      tab("chat:runSession.node.tabs.summary").getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByText("chat:automation.runs.statusFailed")).toBeTruthy();
    expect(
      screen.getByText(formatDateTime("2026-11-23T08:30:00Z")),
    ).toBeTruthy();
    expect(screen.getByText("1.5s")).toBeTruthy();
    expect(screen.getByText("chat:automation.runs.tokens")).toBeTruthy();
  });

  it("非 failed 默认摘要 Tab，无错误内容时错误 Tab 禁用", () => {
    mount([entry()], 0);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      tab("chat:runSession.node.tabs.summary").getAttribute("aria-selected"),
    ).toBe("true");
    expect(tab("chat:runSession.node.tabs.error").disabled).toBe(true);
  });

  it("末次 occurrence 命中节点行 → 输入/输出全文 + 复制写剪贴板并 toast", async () => {
    runNodesMock.mockResolvedValue([
      nodeRow({ input: "full-input-text", output: "full-output-text" }),
    ]);
    mount([entry()], 0);
    await waitFor(() => expect(runNodesMock).toHaveBeenCalledWith(7));
    const inputTab = tab("chat:runSession.node.tabs.input");
    await waitFor(() => expect(inputTab.disabled).toBe(false));
    fireEvent.click(inputTab);
    expect(screen.getByText("full-input-text")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "chat:runSession.node.copy" }),
    );
    await waitFor(() =>
      expect(writeTextMock).toHaveBeenCalledWith("full-input-text"),
    );
    expect(toast.success).toHaveBeenCalledWith(
      "chat:runSession.node.copySuccess",
    );

    fireEvent.click(tab("chat:runSession.node.tabs.output"));
    expect(screen.getByText("full-output-text")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "chat:runSession.node.copy" }),
    );
    await waitFor(() =>
      expect(writeTextMock).toHaveBeenCalledWith("full-output-text"),
    );
  });

  it("非末次 occurrence 回落 outputPreview 与提示，不渲染全文", () => {
    runNodesMock.mockResolvedValue([
      nodeRow({ input: "full-input-text", output: "full-output-text" }),
    ]);
    const trace = [
      entry({ outputPreview: "preview-text" }),
      entry({ id: "n2", name: "节点二" }),
      entry({ name: "节点一再跑" }),
    ];
    mount(trace, 0);
    fireEvent.click(tab("chat:runSession.node.tabs.output"));
    expect(screen.getByText("preview-text")).toBeTruthy();
    expect(screen.queryByText("full-output-text")).toBeNull();
    expect(
      screen.getByText("chat:runSession.detail.occurrenceNote"),
    ).toBeTruthy();
    expect(tab("chat:runSession.node.tabs.input").disabled).toBe(true);
  });

  it("outputImage 输出 Tab 渲染 MessageImage", () => {
    mount([entry({ outputImage: "images/out.png" })], 0);
    fireEvent.click(tab("chat:runSession.node.tabs.output"));
    const image = screen.getByTestId("message-image");
    expect(image.getAttribute("data-path")).toBe("images/out.png");
  });

  it("工具 Tab 列出 toolCalls，ok=false 标红", () => {
    mount(
      [
        entry({
          toolCalls: [
            { name: "web_search", ok: true, durationMs: 200 },
            { name: "fs_write", ok: false, durationMs: 900 },
          ],
        }),
      ],
      0,
    );
    fireEvent.click(tab("chat:runSession.node.tabs.tools"));
    expect(screen.getByText(/web_search/)).toBeTruthy();
    const failed = screen.getByText(/fs_write/);
    expect(failed.className).toContain("text-destructive");
  });

  it("底部导航：prev/next 边界禁用，nextFailed 跳首个后续失败", () => {
    const trace = [
      entry({ id: "a", name: "A" }),
      entry({
        id: "b",
        name: "B",
        status: "failed",
        error: { code: "E1", message: "x" },
      }),
      entry({ id: "c", name: "C" }),
    ];
    let view = mount(trace, 1);
    fireEvent.click(navButton("chat:runSession.node.prev"));
    expect(navigateMock).toHaveBeenCalledWith(0);
    fireEvent.click(navButton("chat:runSession.node.next"));
    expect(navigateMock).toHaveBeenCalledWith(2);
    expect(navButton("chat:runSession.node.nextFailed").disabled).toBe(true);
    view.unmount();

    view = mount(trace, 0);
    expect(navButton("chat:runSession.node.prev").disabled).toBe(true);
    fireEvent.click(navButton("chat:runSession.node.nextFailed"));
    expect(navigateMock).toHaveBeenCalledWith(1);
    view.unmount();

    view = mount(trace, 2);
    expect(navButton("chat:runSession.node.next").disabled).toBe(true);
    view.unmount();
  });

  it("occurrence=null 不渲染也不发起节点行查询", () => {
    mount([entry()], null);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(runNodesMock).not.toHaveBeenCalled();
  });
});

describe("isLastOccurrence 纯函数（graphRunNode 行 runId+nodeId 唯一）", () => {
  it("同 nodeId 仅末次出现为 true，越界为 false", () => {
    const trace = [entry({ id: "a" }), entry({ id: "b" }), entry({ id: "a" })];
    expect(isLastOccurrence(trace, 0)).toBe(false);
    expect(isLastOccurrence(trace, 1)).toBe(true);
    expect(isLastOccurrence(trace, 2)).toBe(true);
    expect(isLastOccurrence(trace, 5)).toBe(false);
  });
});
