// @vitest-environment jsdom
/**
 * 工作流执行详情双视图容器（Task 4，GraphRunDetail 独立渲染——不经
 * RunSessionView，弹框由 Task 5/6 注入）：
 * - 头部：状态徽标/开始时间/触发方式/耗时/attempt 与「拓扑/步骤」切换；
 * - 默认视图：快照合法 → 拓扑（RunGraphCanvas 在模块边界 mock，断言
 *   props 透传，nodeRunStates/firstFailedNodeId 保持真实实现）；
 * - 快照缺失/损坏 → 自动锁定步骤视图并显示降级提示，结果摘要
 *   （error 优先 + localizeRunError，原 GraphRunResult 迁移）仍可见；
 * - 步骤日志：同节点多次 occurrence 各自成行（失败 error.code 预览），
 *   点击整行回调 occurrence 下标；视图切换不丢 selectedOccurrence；
 * - 失败运行未选择时以 firstFailedNodeId 作画布选中，显式选择优先；
 * - 画布 onSelectNode 可能外抛边 id（Task 3 review note）：非 trace
 *   节点 id 按无选择处理——不回调、不崩溃、不误高亮；拓扑节点点击
 *   取该节点末次 occurrence（设计者裁定 2026-11-23）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { AutomationRunDetail } from "@tianshu/protocol";

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

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({
  invoke: (channel: string, ...args: unknown[]) => invokeMock(channel, ...args),
  on: () => () => {},
  send: () => {},
}));

/** RunSelector → automation.api → @/lib/ipc 链路在测试内静默（不发真 IPC） */
invokeMock.mockImplementation(() => []);

// importOriginal 保 nodeRunStates/firstFailedNodeId 真实：run-graph-canvas
// 静态加载 GraphCanvas（@xyflow/react 真包重），沿用 Task 3 先例一并 mock
vi.mock("@xyflow/react", () => ({
  ReactFlow: () => null,
  ReactFlowProvider: ({ children }: { children: unknown }) => children,
  useReactFlow: () => ({
    setCenter: vi.fn(),
    getInternalNode: vi.fn(),
    screenToFlowPosition: vi.fn(),
  }),
  applyNodeChanges: (_changes: unknown[], nodes: unknown[]) => nodes,
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  Panel: () => null,
  MarkerType: { ArrowClosed: "arrowclosed" },
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
}));

vi.mock("@/domains/ai/orchestration/components/AddNodeMenu", () => ({
  default: () => null,
}));

const canvas = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
}));
vi.mock(
  "../../src-react/domains/ai/automation/components/run-graph-canvas",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../src-react/domains/ai/automation/components/run-graph-canvas")
      >();
    return {
      ...actual,
      default: (props: Record<string, unknown>) => {
        canvas.props.push(props);
        return <div data-testid="run-graph-canvas" />;
      },
    };
  },
);

import GraphRunDetail from "../../src-react/domains/ai/automation/components/graph-run-detail";
import type { TraceEntry } from "../../src-react/domains/ai/orchestration/components/GraphRunTraceView";
import {
  formatDateTime,
  formatDuration,
} from "../../src-react/domains/ai/automation/lib/run-display";

function makeTraceEntry(
  id: string,
  overrides: Partial<TraceEntry> = {},
): TraceEntry {
  return {
    id,
    name: id,
    status: "success",
    startedAt: "2026-11-23T10:00:00Z",
    durationMs: 100,
    ...overrides,
  };
}

/** 结构合法的执行时快照（start → llm） */
const validSnapshot = JSON.stringify({
  nodes: [
    { id: "start", kind: "start", name: "Start" },
    { id: "llm", kind: "llm", name: "Model", modelId: 1 },
  ],
  edges: [{ from: "start", to: "llm" }],
});

function makeRun(
  overrides: Partial<AutomationRunDetail> = {},
): AutomationRunDetail {
  return {
    id: 11,
    taskId: null,
    taskName: "Graph run",
    graphId: 3,
    attempt: 2,
    triggerType: "manual",
    status: "success",
    durationMs: 1500,
    startedAt: "2026-11-23T09:00:00Z",
    graphJsonSnapshot: validSnapshot,
    ...overrides,
  };
}

const simpleTrace: TraceEntry[] = [
  makeTraceEntry("start", { durationMs: 10 }),
  makeTraceEntry("llm", {
    durationMs: 1200,
    outputPreview: "最终输出文本",
  }),
];

const failedTrace: TraceEntry[] = [
  makeTraceEntry("start"),
  makeTraceEntry("llm", {
    status: "failed",
    durationMs: 300,
    error: { code: "LLM_TIMEOUT", message: "timeout" },
  }),
];

/** 同节点 a 两条 occurrence（第二条失败），llm 一条 */
const multiTrace: TraceEntry[] = [
  makeTraceEntry("a", { durationMs: 50 }),
  makeTraceEntry("a", {
    status: "failed",
    durationMs: 80,
    error: { code: "TOOL_ERROR", message: "boom" },
  }),
  makeTraceEntry("llm", { durationMs: 200 }),
];

interface DetailOptions {
  run?: AutomationRunDetail;
  trace?: TraceEntry[];
  selectedOccurrence?: number | null;
}

function renderDetail(options: DetailOptions = {}) {
  const run = options.run ?? makeRun();
  const trace = options.trace ?? simpleTrace;
  const selectedOccurrence = options.selectedOccurrence ?? null;
  const onSelectOccurrence = vi.fn();
  const view = render(
    <GraphRunDetail
      run={run}
      trace={trace}
      selectedOccurrence={selectedOccurrence}
      onSelectOccurrence={onSelectOccurrence}
    />,
  );
  return { onSelectOccurrence, run, trace, ...view };
}

/** 渲染并切到步骤视图 */
function renderSteps(options: DetailOptions = {}) {
  const result = renderDetail(options);
  fireEvent.click(
    screen.getByRole("button", { name: "chat:runSession.detail.viewSteps" }),
  );
  return result;
}

function latestCanvasProps(): Record<string, unknown> {
  const props = canvas.props[canvas.props.length - 1];
  if (!props) throw new Error("RunGraphCanvas 未渲染");
  return props;
}

beforeEach(() => {
  canvas.props.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("GraphRunDetail 头部", () => {
  it("显示状态徽标/开始时间/触发方式/耗时/attempt", () => {
    const run = makeRun();
    renderDetail({ run });
    expect(screen.getByText("chat:automation.runs.statusSuccess")).toBeTruthy();
    expect(screen.getByText(formatDateTime(run.startedAt))).toBeTruthy();
    expect(screen.getByText("chat:automation.runs.triggerManual")).toBeTruthy();
    expect(screen.getByText(formatDuration(run.durationMs))).toBeTruthy();
    expect(screen.getByText("chat:automation.runs.attempt")).toBeTruthy();
  });
});

describe("GraphRunDetail 结果摘要（GraphRunResult 迁移）", () => {
  it("error 优先并经 localizeRunError 本地化", () => {
    renderDetail({
      run: makeRun({ error: "attachment_missing: report.pdf" }),
    });
    expect(screen.getByText("chat:runSession.resultSummary")).toBeTruthy();
    expect(
      screen.getByText("chat:automation.create.attachmentMissing"),
    ).toBeTruthy();
  });

  it("无 error 时回落末次 outputPreview", () => {
    renderDetail({ trace: simpleTrace });
    expect(screen.getByText("最终输出文本")).toBeTruthy();
  });
});

describe("GraphRunDetail 视图切换", () => {
  it("快照合法默认拓扑视图（RunGraphCanvas props 透传），切步骤渲染 RunStepLog", () => {
    const run = makeRun();
    renderDetail({ run, trace: simpleTrace });
    expect(screen.getByTestId("run-graph-canvas")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "chat:runSession.detail.viewTopology" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(
      screen.getByRole("button", { name: "chat:runSession.detail.viewSteps" }),
    );
    expect(screen.queryByTestId("run-graph-canvas")).toBeNull();
    expect(screen.getByTestId("run-step-log")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "chat:runSession.detail.viewTopology" })
        .getAttribute("aria-pressed"),
    ).toBe("false");

    const canvasProps = latestCanvasProps();
    expect(canvasProps.graphJson).toBe(run.graphJsonSnapshot);
    expect(canvasProps.trace).toBe(simpleTrace);
  });

  it("视图切换保持 selectedOccurrence 不丢（步骤行高亮 ↔ 画布 selectedNodeId）", () => {
    renderDetail({ trace: multiTrace, selectedOccurrence: 1 });
    expect(latestCanvasProps().selectedNodeId).toBe("a");

    fireEvent.click(
      screen.getByRole("button", { name: "chat:runSession.detail.viewSteps" }),
    );
    expect(
      screen.getByTestId("run-step-row-1").getAttribute("aria-current"),
    ).toBe("true");
    expect(
      screen.getByTestId("run-step-row-0").getAttribute("aria-current"),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "chat:runSession.detail.viewTopology",
      }),
    );
    expect(latestCanvasProps().selectedNodeId).toBe("a");
  });

  it("切换运行回落默认拓扑视图（不携带旧运行的手动选择）", () => {
    const { trace, onSelectOccurrence, rerender } = renderDetail({
      trace: simpleTrace,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "chat:runSession.detail.viewSteps" }),
    );
    rerender(
      <GraphRunDetail
        run={makeRun({ id: 12 })}
        trace={trace}
        selectedOccurrence={null}
        onSelectOccurrence={onSelectOccurrence}
      />,
    );
    expect(screen.getByTestId("run-graph-canvas")).toBeTruthy();
  });
});

describe("GraphRunDetail 失败定位", () => {
  it("failed 且未选择：firstFailedNodeId 作画布选中", () => {
    renderDetail({
      run: makeRun({ status: "failed" }),
      trace: failedTrace,
    });
    expect(latestCanvasProps().selectedNodeId).toBe("llm");
  });

  it("非失败或已显式选择：不作失败回退", () => {
    const { rerender, trace, onSelectOccurrence } = renderDetail({
      run: makeRun({ status: "failed" }),
      trace: failedTrace,
    });
    expect(latestCanvasProps().selectedNodeId).toBe("llm");
    rerender(
      <GraphRunDetail
        run={makeRun({ status: "failed" })}
        trace={trace}
        selectedOccurrence={0}
        onSelectOccurrence={onSelectOccurrence}
      />,
    );
    expect(latestCanvasProps().selectedNodeId).toBe("start");
    rerender(
      <GraphRunDetail
        run={makeRun({ status: "success" })}
        trace={trace}
        selectedOccurrence={null}
        onSelectOccurrence={onSelectOccurrence}
      />,
    );
    expect(latestCanvasProps().selectedNodeId).toBeNull();
  });
});

describe("RunStepLog 步骤行（经容器步骤视图）", () => {
  it("同节点两条各自成行：序号/耗时/失败 code 预览，点击行回调 occurrence 下标", () => {
    const { onSelectOccurrence } = renderSteps({ trace: multiTrace });
    const row0 = screen.getByTestId("run-step-row-0");
    const row1 = screen.getByTestId("run-step-row-1");
    expect(within(row0).getByText("1")).toBeTruthy();
    expect(within(row0).queryByText("TOOL_ERROR")).toBeNull();
    expect(within(row1).getByText("TOOL_ERROR")).toBeTruthy();
    expect(within(row1).getByText(formatDuration(80))).toBeTruthy();

    fireEvent.click(screen.getByTestId("run-step-row-2"));
    expect(onSelectOccurrence).toHaveBeenCalledWith(2);
    fireEvent.click(row1);
    expect(onSelectOccurrence).toHaveBeenCalledWith(1);
  });

  it("空 trace 显示空态提示", () => {
    renderSteps({ trace: [] });
    expect(screen.getByText("chat:orchestration.trace.empty")).toBeTruthy();
  });
});

describe("GraphRunDetail 快照降级", () => {
  it.each([
    ["损坏 JSON", "{not-json"],
    ["缺失（null）", null],
  ])(
    "%s：显示降级提示、自动落在步骤视图、拓扑按钮禁用、结果摘要仍可见",
    (_name, graphJsonSnapshot) => {
      renderDetail({
        run: makeRun({ graphJsonSnapshot, error: "boom" }),
        trace: simpleTrace,
      });
      expect(
        screen.getByText("chat:runSession.detail.snapshotMissing"),
      ).toBeTruthy();
      expect(screen.queryByTestId("run-graph-canvas")).toBeNull();
      expect(canvas.props.length).toBe(0);
      expect(screen.getByTestId("run-step-log")).toBeTruthy();
      expect(screen.getByText("chat:runSession.resultSummary")).toBeTruthy();
      expect(screen.getByText("boom")).toBeTruthy();
      const topology = screen.getByRole("button", {
        name: "chat:runSession.detail.viewTopology",
      }) as HTMLButtonElement;
      expect(topology.disabled).toBe(true);
    },
  );
});

describe("画布非节点 id 容错（Task 3 review note）", () => {
  it("边形 id/null：不崩溃、不回调、不误选；节点 id 取末次 occurrence", () => {
    const { onSelectOccurrence } = renderDetail({ trace: multiTrace });
    expect(latestCanvasProps().selectedNodeId).toBeNull();
    const onSelectNode = latestCanvasProps().onSelectNode as (
      id: string | null,
    ) => void;

    expect(() =>
      act(() => {
        onSelectNode("edge-start-llm");
      }),
    ).not.toThrow();
    expect(() =>
      act(() => {
        onSelectNode(null);
      }),
    ).not.toThrow();
    expect(onSelectOccurrence).not.toHaveBeenCalled();

    act(() => {
      onSelectNode("a");
    });
    expect(onSelectOccurrence).toHaveBeenCalledTimes(1);
    expect(onSelectOccurrence).toHaveBeenCalledWith(1);
  });
});
