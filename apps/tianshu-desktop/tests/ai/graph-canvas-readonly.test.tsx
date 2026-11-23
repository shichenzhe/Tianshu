// @vitest-environment jsdom
/**
 * GraphCanvas 只读运行模式（Task 3）：readOnly 断言画布层 props 与节点层
 * flags——@xyflow/react 12.12 无 nodesEditable/edgesConnectable prop，
 * 「节点不可编辑/边不可连」以实际存在的节点级 draggable/deletable=false +
 * RF 级 nodesConnectable=false、deleteKeyCode=null、无 onConnect 透传落地；
 * position change 不再收集（防抖到期 onMove 不触发）、删除回调不外抛、
 * 点击选择保留；nodeStates 末次状态映射进节点 data.runState。
 * readOnly 缺省（编辑态）回归：flags/回调/AddNodeMenu/防抖上抛零变化。
 * 深手势不做 jsdom 深测（GraphCanvas spec §7），断言 props 透传行为。
 * 另含 NodeCard runState 叠加（状态描边 + 右上角徽标）直渲断言。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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

vi.mock("@/domains/ai/api/model.api", () => ({
  default: { listAll: async () => [] },
  modelDisplayName: (m: { name?: string; modelId: string }) =>
    m.name ?? m.modelId,
}));
vi.mock("@/domains/ai/api/provider.api", () => ({
  default: { list: async () => [] },
}));

import GraphCanvas from "../../src-react/domains/ai/orchestration/components/GraphCanvas";
import NodeCard from "../../src-react/domains/ai/orchestration/components/nodes/NodeCard";
import type { CanvasNode } from "../../src-react/domains/ai/orchestration/lib/graph-canvas-model";
import type { GraphJson } from "../../src-react/domains/ai/orchestration/api/graph.schema";

const graph = {
  nodes: [
    { id: "start", kind: "start", name: "Start" },
    { id: "llm", kind: "llm", name: "Model", modelId: 1 },
  ],
  edges: [{ from: "start", to: "llm" }],
} as unknown as GraphJson;

const layouts = {
  start: { x: 0, y: 0 },
  llm: { x: 320, y: 0 },
};

interface CanvasSpy {
  onSelect: ReturnType<typeof vi.fn>;
  onMove: ReturnType<typeof vi.fn>;
  onConnect: ReturnType<typeof vi.fn>;
  onAddNode: ReturnType<typeof vi.fn>;
  onAddNodeAt: ReturnType<typeof vi.fn>;
  onRemoveNode: ReturnType<typeof vi.fn>;
  onRemoveEdge: ReturnType<typeof vi.fn>;
}

function makeSpy(): CanvasSpy {
  return {
    onSelect: vi.fn(),
    onMove: vi.fn(),
    onConnect: vi.fn(),
    onAddNode: vi.fn(),
    onAddNodeAt: vi.fn(),
    onRemoveNode: vi.fn(),
    onRemoveEdge: vi.fn(),
  };
}

function renderCanvas(spy: CanvasSpy, readOnly?: boolean) {
  render(
    <GraphCanvas
      graph={graph}
      layouts={layouts}
      selectedId={null}
      onSelect={spy.onSelect}
      onMove={spy.onMove}
      onConnect={spy.onConnect}
      onAddNode={spy.onAddNode}
      onAddNodeAt={spy.onAddNodeAt}
      onRemoveNode={spy.onRemoveNode}
      onRemoveEdge={spy.onRemoveEdge}
      {...(readOnly === undefined ? {} : { readOnly })}
    />,
  );
}

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
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("GraphCanvas readOnly", () => {
  it("节点级禁拖禁删、RF 级禁连禁删键、无 onConnect 透传、不渲染 AddNodeMenu", () => {
    renderCanvas(makeSpy(), true);
    const props = latestFlowProps();
    // 「nodesEditable=false」：@xyflow/react 12.12 无该 prop，以节点级
    // draggable/deletable=false + nodesConnectable=false 落地（含 END 虚拟节点）
    expect(
      flowNodes().every((n) => n.draggable === false && n.deletable === false),
    ).toBe(true);
    expect(props.nodesConnectable).toBe(false);
    expect(props.deleteKeyCode).toBeNull();
    expect(props.onConnect).toBeUndefined();
    expect(screen.queryByTestId("add-node-menu")).toBeNull();
  });

  it("只读运行拓扑初始 fitView（整图适配视口，布局超出不裁切）", () => {
    renderCanvas(makeSpy(), true);
    expect(latestFlowProps().fitView).toBe(true);
  });

  it("position change 不收集（防抖到期 onMove 不触发）、删除回调不外抛、点击选择保留", () => {
    const spy = makeSpy();
    renderCanvas(spy, true);
    const props = latestFlowProps();
    act(() => {
      (props.onNodesChange as (changes: unknown[]) => void)([
        { type: "position", id: "llm", position: { x: 9, y: 9 } },
      ]);
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(spy.onMove).not.toHaveBeenCalled();
    act(() => {
      (props.onNodesDelete as (nodes: unknown[]) => void)([{ id: "llm" }]);
      (props.onEdgesDelete as (edges: unknown[]) => void)([{ id: "e" }]);
    });
    expect(spy.onRemoveNode).not.toHaveBeenCalled();
    expect(spy.onRemoveEdge).not.toHaveBeenCalled();
    // 只读保留点击选择
    act(() => {
      (props.onNodeClick as (event: unknown, node: { id: string }) => void)(
        null,
        { id: "llm" },
      );
    });
    expect(spy.onSelect).toHaveBeenCalledWith("llm");
  });

  it("nodeStates 末次状态映射进节点 data.runState（无 trace 节点不带字段）", () => {
    render(
      <GraphCanvas
        graph={graph}
        layouts={layouts}
        selectedId={null}
        onSelect={vi.fn()}
        onMove={vi.fn()}
        onConnect={vi.fn()}
        onAddNode={vi.fn()}
        onAddNodeAt={vi.fn()}
        onRemoveNode={vi.fn()}
        onRemoveEdge={vi.fn()}
        readOnly
        nodeStates={new Map([["llm", { status: "failed", durationMs: 250 }]])}
      />,
    );
    const llm = flowNodes().find((n) => n.id === "llm");
    const start = flowNodes().find((n) => n.id === "start");
    expect((llm!.data as Record<string, unknown>).runState).toEqual({
      status: "failed",
      durationMs: 250,
    });
    expect(start!.data).not.toHaveProperty("runState");
  });
});

describe("GraphCanvas 编辑态默认（readOnly 缺省零变化）", () => {
  it("deleteKeyCode/onConnect/AddNodeMenu 保持原行为，节点不带禁用 flags", () => {
    renderCanvas(makeSpy());
    const props = latestFlowProps();
    expect(props.deleteKeyCode).toEqual(["Backspace", "Delete"]);
    expect(props.onConnect).toBeInstanceOf(Function);
    expect(props.nodesConnectable).toBeUndefined();
    // 编辑器初始定位逻辑保持现状，fitView 仅只读运行拓扑启用
    expect(props.fitView).toBeUndefined();
    expect(screen.queryByTestId("add-node-menu")).not.toBeNull();
    const endNode = flowNodes().find((n) => n.id === "__end__");
    const card = flowNodes().find((n) => n.id === "llm");
    expect(endNode!.draggable).toBe(true);
    expect(endNode!.deletable).toBe(false);
    expect(card).not.toHaveProperty("draggable");
    expect(card).not.toHaveProperty("deletable");
  });

  it("position change 防抖批量上抛 onMove、松手立即落库", () => {
    const spy = makeSpy();
    renderCanvas(spy);
    const props = latestFlowProps();
    act(() => {
      (props.onNodesChange as (changes: unknown[]) => void)([
        { type: "position", id: "llm", position: { x: 9, y: 9 } },
      ]);
    });
    expect(spy.onMove).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(301);
    });
    expect(spy.onMove).toHaveBeenCalledWith({ llm: { x: 9, y: 9 } });
    act(() => {
      (props.onNodesChange as (changes: unknown[]) => void)([
        { type: "position", id: "start", position: { x: 1, y: 2 } },
      ]);
      (props.onNodeDragStop as () => void)();
    });
    expect(spy.onMove).toHaveBeenCalledWith({ start: { x: 1, y: 2 } });
  });
});

describe("NodeCard runState 叠加", () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const canvasNode: CanvasNode = {
    id: "llm",
    kind: "llm",
    name: "Node A",
    isEntry: false,
    position: { x: 0, y: 0 },
  };

  function renderCard(runState?: { status: string; durationMs: number }) {
    render(
      <QueryClientProvider client={queryClient}>
        <NodeCard
          id="llm"
          selected={false}
          data={{ canvas: canvasNode, ...(runState ? { runState } : {}) }}
        />
      </QueryClientProvider>,
    );
    return screen.getByText("Node A").parentElement!.parentElement!;
  }

  it("failed：destructive 描边 + 右上角徽标（状态字 + 耗时）", () => {
    const card = renderCard({ status: "failed", durationMs: 1500 });
    expect(card.className).toContain("border-destructive");
    expect(
      screen.getByText("chat:automation.runs.statusFailed · 1.5s"),
    ).not.toBeNull();
  });

  it("success：primary 描边 + 徽标", () => {
    const card = renderCard({ status: "success", durationMs: 40 });
    expect(card.className).toContain("border-primary");
    expect(
      screen.getByText("chat:automation.runs.statusSuccess · 40ms"),
    ).not.toBeNull();
  });

  it("skipped：border 描边 + 徽标；无 runState 时维持编辑态描边", () => {
    const card = renderCard({ status: "skipped", durationMs: 0 });
    expect(card.className).toContain("border-border");
    expect(card.className).not.toContain("border-destructive");
    expect(
      screen.getByText("chat:automation.runs.statusSkipped · 0ms"),
    ).not.toBeNull();
    cleanup();
    const plain = renderCard(undefined);
    expect(plain.className).toContain("border-border");
    expect(screen.queryByText(/statusFailed/)).toBeNull();
  });
});

describe("GraphCanvas 自持样式（真实视口回归守卫）", () => {
  // RF 基础样式（.react-flow 的 height:100%、手势 pane 层、节点 absolute
  // 定位）曾只在 GraphEditorView 按需加载——运行详情等非编辑器路由下
  // 样式缺失：画布容器塌陷、无法平移缩放、节点堆叠点击无效。守卫组件
  // 自己 import 样式，防止再被挪回单一视图按需加载（jsdom 不渲染 CSS，
  // 无法行为测试，以源码断言守卫）
  it("GraphCanvas 源码自带 @xyflow/react 样式 import", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const source = await readFile(
      resolve(
        __dirname,
        "../../src-react/domains/ai/orchestration/components/GraphCanvas.tsx",
      ),
      "utf-8",
    );
    expect(source).toContain("@xyflow/react/dist/style.css");
  });
});
