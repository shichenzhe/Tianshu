// @vitest-environment jsdom
/**
 * 运行拓扑画布（Task 3）：
 * - nodeRunStates：同节点多次 occurrence 后一覆盖前一（status/durationMs
 *   取末次，lastOccurrence 为 trace 下标、occurrences 累计）；
 * - firstFailedNodeId：首个 failed occurrence 的节点 id，无失败 null；
 * - RunGraphCanvas：合法快照经只读 GraphCanvas 渲染（@xyflow/react
 *   12.12 无 nodesEditable/edgesConnectable prop——「不可编辑/不可连」以
 *   实际存在的节点级 draggable/deletable=false + RF 级
 *   nodesConnectable=false、deleteKeyCode=null、无 onConnect 透传落地），
 *   trace 末次状态映射进节点 data.runState，点击节点/空白回调透传；
 * - 快照缺失（null/undefined——Task 1 跨端编码差异同判）/损坏/结构非法
 *   → 渲染降级提示且不抛错。
 * 深手势不做 jsdom 深测（GraphCanvas spec §7），断言 props 透传行为。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

const flow = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
}));
vi.mock("@xyflow/react", () => ({
  ReactFlow: (props: Record<string, unknown>) => {
    flow.props.push(props);
    return <>{props.children as ReactNode}</>;
  },
  ReactFlowProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useReactFlow: () => ({
    setCenter: vi.fn(),
    getInternalNode: vi.fn(),
    screenToFlowPosition: vi.fn(),
  }),
  applyNodeChanges: (_changes: unknown[], nodes: unknown[]) => nodes,
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  Panel: ({ children }: { children: ReactNode }) => <>{children}</>,
  MarkerType: { ArrowClosed: "arrowclosed" },
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
}));

vi.mock("@/domains/ai/orchestration/components/AddNodeMenu", () => ({
  default: () => <div data-testid="add-node-menu" />,
}));

import RunGraphCanvas, {
  firstFailedNodeId,
  nodeRunStates,
} from "../../src-react/domains/ai/automation/components/run-graph-canvas";
import type { TraceEntry } from "../../src-react/domains/ai/orchestration/components/GraphRunTraceView";

function makeTraceEntry(
  id: string,
  status: TraceEntry["status"],
  durationMs: number,
): TraceEntry {
  return {
    id,
    name: id,
    status,
    startedAt: "2026-11-23T10:00:00Z",
    durationMs,
  };
}

/** 结构合法的执行时快照（start → llm → END） */
const validSnapshot = JSON.stringify({
  nodes: [
    { id: "start", kind: "start", name: "Start" },
    { id: "llm", kind: "llm", name: "Model", modelId: 1 },
  ],
  edges: [
    { from: "start", to: "llm" },
    { from: "llm", to: "END" },
  ],
});

function latestFlowProps(): Record<string, unknown> {
  const props = flow.props[flow.props.length - 1];
  if (!props) throw new Error("ReactFlow 未渲染");
  return props;
}

function flowNodes(): Array<Record<string, unknown>> {
  return latestFlowProps().nodes as Array<Record<string, unknown>>;
}

beforeEach(() => {
  flow.props.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("nodeRunStates（同节点末次覆盖）", () => {
  it("同节点先 success 后 failed：status/durationMs 取末次、occurrences=2、lastOccurrence=末次下标", () => {
    const trace = [
      makeTraceEntry("a", "success", 100),
      makeTraceEntry("a", "failed", 250),
    ];
    const states = nodeRunStates(trace);
    expect(states.get("a")).toEqual({
      status: "failed",
      durationMs: 250,
      occurrences: 2,
      lastOccurrence: 1,
    });
  });

  it("多节点互不覆盖：各自记末次与出现次数", () => {
    const trace = [
      makeTraceEntry("a", "success", 10),
      makeTraceEntry("b", "skipped", 0),
      makeTraceEntry("a", "success", 20),
    ];
    const states = nodeRunStates(trace);
    expect(states.get("a")).toEqual({
      status: "success",
      durationMs: 20,
      occurrences: 2,
      lastOccurrence: 2,
    });
    expect(states.get("b")).toEqual({
      status: "skipped",
      durationMs: 0,
      occurrences: 1,
      lastOccurrence: 1,
    });
  });

  it("空 trace → 空 Map", () => {
    expect(nodeRunStates([]).size).toBe(0);
  });
});

describe("firstFailedNodeId", () => {
  it("返回首个 failed occurrence 的节点 id", () => {
    const trace = [
      makeTraceEntry("a", "success", 10),
      makeTraceEntry("b", "failed", 20),
      makeTraceEntry("c", "failed", 30),
    ];
    expect(firstFailedNodeId(trace)).toBe("b");
  });

  it("无失败返回 null", () => {
    expect(
      firstFailedNodeId([
        makeTraceEntry("a", "success", 10),
        makeTraceEntry("b", "skipped", 0),
      ]),
    ).toBeNull();
    expect(firstFailedNodeId([])).toBeNull();
  });
});

describe("RunGraphCanvas（合法快照 → 只读渲染）", () => {
  it("节点不可编辑（节点级 draggable/deletable=false）、不可连线（nodesConnectable=false）、删除键禁用、无 onConnect 透传、不渲染 AddNodeMenu", () => {
    render(
      <RunGraphCanvas
        graphJson={validSnapshot}
        trace={[makeTraceEntry("llm", "success", 120)]}
        selectedNodeId={null}
        onSelectNode={() => {}}
      />,
    );
    const props = latestFlowProps();
    // 「nodesEditable=false」：@xyflow/react 12.12 无该 prop，以节点级
    // draggable/deletable=false + nodesConnectable=false 落地
    expect(
      flowNodes().every((n) => n.draggable === false && n.deletable === false),
    ).toBe(true);
    expect(props.nodesConnectable).toBe(false);
    expect(props.deleteKeyCode).toBeNull();
    expect(props.onConnect).toBeUndefined();
    expect(screen.queryByTestId("add-node-menu")).toBeNull();
  });

  it("trace 末次状态映射进节点 data.runState；布局经 layoutOf 兜底有穷", () => {
    render(
      <RunGraphCanvas
        graphJson={validSnapshot}
        trace={[
          makeTraceEntry("llm", "success", 100),
          makeTraceEntry("llm", "failed", 250),
        ]}
        selectedNodeId="llm"
        onSelectNode={() => {}}
      />,
    );
    const llm = flowNodes().find((n) => n.id === "llm");
    const start = flowNodes().find((n) => n.id === "start");
    expect(llm).toBeDefined();
    expect(start).toBeDefined();
    expect((llm!.data as Record<string, unknown>).runState).toEqual({
      status: "failed",
      durationMs: 250,
      occurrences: 2,
      lastOccurrence: 1,
    });
    // 无 trace 的节点不带 runState 字段（编辑态卡片结构不变）
    expect(start!.data).not.toHaveProperty("runState");
    // 快照无 position → layoutOf autoLayout 兜底（坐标为有限数）
    const position = llm!.position as { x: number; y: number };
    expect(Number.isFinite(position.x)).toBe(true);
    expect(Number.isFinite(position.y)).toBe(true);
    // 选中态受 selectedNodeId 受控
    expect(llm!.selected).toBe(true);
    expect(start!.selected).toBe(false);
  });

  it("点击节点透传 onSelectNode(node.id)、点空白透传 onSelectNode(null)", () => {
    const onSelectNode = vi.fn();
    render(
      <RunGraphCanvas
        graphJson={validSnapshot}
        trace={[]}
        selectedNodeId={null}
        onSelectNode={onSelectNode}
      />,
    );
    const props = latestFlowProps();
    act(() => {
      (props.onNodeClick as (event: unknown, node: { id: string }) => void)(
        null,
        { id: "llm" },
      );
    });
    expect(onSelectNode).toHaveBeenCalledWith("llm");
    act(() => {
      (props.onPaneClick as () => void)();
    });
    expect(onSelectNode).toHaveBeenCalledWith(null);
  });
});

describe("RunGraphCanvas（快照缺失/非法 → 降级）", () => {
  it.each([
    ["null（server 显式 null）", null],
    ["undefined（desktop 省略）", undefined],
    ["损坏 JSON", "{not-json"],
    ["结构非法（无 nodes/edges 数组）", JSON.stringify({ nodes: "nope" })],
  ])("%s：渲染降级提示且不渲染画布、不抛错", (_name, graphJson) => {
    expect(() =>
      render(
        <RunGraphCanvas
          graphJson={graphJson}
          trace={[]}
          selectedNodeId={null}
          onSelectNode={() => {}}
        />,
      ),
    ).not.toThrow();
    expect(
      screen.queryByText("chat:runSession.detail.snapshotMissing"),
    ).not.toBeNull();
    expect(flow.props.length).toBe(0);
    expect(screen.queryByTestId("add-node-menu")).toBeNull();
  });
});
