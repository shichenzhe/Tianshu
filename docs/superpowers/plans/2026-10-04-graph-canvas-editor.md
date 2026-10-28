# React Flow 可视化画布编辑器 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 编排图编辑器从结构化表单重构为 React Flow 工作流画布（拖拽/连线/属性面板），JSON 模式保留为高级切换，后端零改动。

**Architecture:** 画布为默认主模式；`graph-canvas-model.ts` 纯函数承担 GraphJson ⇄ ReactFlow nodes/edges 双向映射、connectEdge 规则、autoLayout 分层布局；交互事件单向流回 GraphJson（唯一状态源）。属性面板复用现有 llm/code 字段表单。

**Tech Stack:** @xyflow/react@^12.12.0（peer react>=17）/ React 19 / zod 4 / Vitest。

**Spec:** `docs/superpowers/specs/2026-10-04-graph-canvas-editor-design.md`（执行者须同时读）

## Global Constraints

- **spec §0 决策表全部有效**：JSON 模式保留；坐标进 graphJson（`position:{x,y}` 可选，`.finite()`）；不引 dagre（自写分层布局）；END 虚拟节点不可删、START 不设实体（入口=无入边派生徽标）；branch 节点按 branchOptions 每选项一个 source handle；运行态不上画布。
- **connectEdge 规则（spec §2）**：`branch:<v>` handle → 条件边；`plain` → 无条件边（多条不同 to 允许，fan-out 语义）；完全重复边/自环拒绝；to 为 END 虚拟节点映射 `to:"END"`。
- 后端/数据库/IPC **零改动**；`validateGraph`/执行器/编译器忽略 position。
- UI 红线（CLAUDE.md）：t() 全覆盖（`chat:orchestration.*`）、zh/en 同步、语义主题 token（禁 `*-blue-*`）、弹层 `border-border/50 rounded-lg shadow-lg`、紧凑控件。
- Prettier：双引号/分号/tabWidth=2/printWidth=80；每任务 `npm run test` + `npm run typecheck` 全绿、`npm run lint` 零告警后 commit（中文 conventional）。
- 测试放 `tests/ai/`，mock 先例见 `tests/ai/graph-code-node.test.ts`（electron/prisma/Log/skill-loader/command-gate 四件）。

## 关键既有接口（已核实）

| 接口 | 位置 | 形态 |
|---|---|---|
| `GraphJson`/`LlmNode`/`CodeNode`/`isLlmNode`/`validateGraph` | `src-react/domains/ai/orchestration/api/graph.schema.ts` | union schema；`nodeBase` 在 :10，两分支 spread 于 :19/:28 |
| `EditorMode = "structured" \| "json"` | `lib/graph-editor-model.ts:19` | 本计划改为 `"canvas" \| "json"` |
| `newNode/newCodeNode/switchNodeKind/renameNode/removeNode/parseOrKeep/serializeGraph/canonicalJson/draftChanged/validateRaw/localizeGraphIssue/StringListInput` | `lib/graph-editor-model.ts` / `components/GraphNodeEditor.tsx` | 全部保留复用 |
| GraphEditorView 现状 | `views/GraphEditorView.tsx`（934 行） | mode state :119、模式分支 :182/:254/:262/:320、试运行/历史弹窗与顶栏保存逻辑**全部不动** |
| GraphNodeEditor 字段表单 | `components/GraphNodeEditor.tsx`（541 行） | `LlmNodeFields`/`CodeNodeFields`/`ModelSelect`/`Field`/`StringListInput` 导出复用 |
| `GraphEdgeEditor` | `components/GraphEdgeEditor.tsx` | 退役（T4 删文件） |

---

### Task 1: 依赖 + schema position + graph-canvas-model 纯函数

**Files:**
- Modify: `package.json`（npm i 自动）
- Modify: `src-react/domains/ai/orchestration/api/graph.schema.ts:10-53`（nodeBase 加 position；两分支自动继承）
- Create: `src-react/domains/ai/orchestration/lib/graph-canvas-model.ts`
- Test: `tests/ai/graph-canvas-model.test.ts`、`tests/ai/graph-schema.test.ts`（追加）

**Interfaces:**
- Consumes: `GraphJson`/`GraphNode`/`isLlmNode`（schema）、`newNode`/`newCodeNode`（graph-editor-model）。
- Produces（后续任务全部依赖，签名固定）:
  - `type CanvasNode = { id: string; kind: "llm" | "code"; name: string; modelId?: number; language?: string; branchOptions?: string[]; isEntry: boolean; position: { x: number; y: number } }`
  - `type CanvasEdge = { id: string; from: string; to: string; label?: string }`（id 即 `${from}->${to}:${label ?? ""}` 稳定串）
  - `END_NODE_ID = "__end__"`
  - `toCanvas(json: GraphJson, layouts: Record<string, { x: number; y: number }>): { nodes: CanvasNode[]; edges: CanvasEdge[] }`（to==="END" 的边映射到 END 虚拟节点；isEntry=无入边）
  - `applyPositions(json: GraphJson, positions: Record<string, { x: number; y: number }>): GraphJson`（写回 position；未知 id 忽略）
  - `autoLayout(json: GraphJson): Record<string, { x: number; y: number }>`（拓扑分层：层 x 间隔 320、层内 y 间隔 140，起点 {80,80}；环内节点按首次到达层放置，确定性）
  - `connectEdge(json: GraphJson, conn: { source: string; sourceHandle: string; target: string }): GraphJson | null`（sourceHandle `"branch:<v>"`/`"plain"`；target 为 END_NODE_ID 时 to="END"；重复/自环返回 null）
  - `layoutOf(json: GraphJson): Record<string, { x: number; y: number }>`（有 position 用之，缺的用 autoLayout 补——装载入口）

- [ ] **Step 1: 安装依赖**

```bash
npm i @xyflow/react@^12.12.0
```

- [ ] **Step 2: schema 测试先行（追加到 tests/ai/graph-schema.test.ts）**

```ts
describe("节点坐标 position（画布编辑器）", () => {
  it("llm/code 节点均可携带合法坐标", () => {
    const r = validateGraph(
      base(
        [
          llmNode("a", { position: { x: 10, y: -5 } }),
          {
            id: "b", name: "b", kind: "code", language: "bash",
            script: "echo", position: { x: 340, y: 0 },
          },
        ],
        [{ from: "a", to: "b" }, { from: "b", to: "END" }],
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.nodes[0]).toMatchObject({ position: { x: 10, y: -5 } });
    }
  });
  it("NaN/Infinity 坐标拒绝", () => {
    expect(
      validateGraph(base([llmNode("a", { position: { x: NaN, y: 0 } })], [{ from: "a", to: "END" }])).ok,
    ).toBe(false);
    expect(
      validateGraph(base([llmNode("a", { position: { x: Infinity, y: 0 } })], [{ from: "a", to: "END" }])).ok,
    ).toBe(false);
  });
  it("旧图无坐标照常通过（零迁移）", () => {
    expect(validateGraph(base([llmNode("a")], [{ from: "a", to: "END" }])).ok).toBe(true);
  });
});
```

- [ ] **Step 3: 跑测试确认 FAIL**（`npx vitest run tests/ai/graph-schema.test.ts`——NaN 用例应在 schema 层放行前失败）

- [ ] **Step 4: schema 加 position（nodeBase 中定义，两分支继承）**

```ts
// graph.schema.ts —— nodeBase 改为（id/name 保持原样，追加 position）：
const nodeBase = {
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "节点 id 须为 kebab-case"),
  name: z.string().min(1),
  /** 画布坐标（画布编辑器）：旧图缺省 → autoLayout 补；执行器忽略 */
  position: z
    .object({ x: z.number().finite(), y: z.number().finite() })
    .optional(),
};
```

- [ ] **Step 5: canvas-model 测试先行（tests/ai/graph-canvas-model.test.ts 全量）**

```ts
import { describe, expect, it } from "vitest";
import {
  END_NODE_ID, toCanvas, applyPositions, autoLayout, connectEdge, layoutOf,
} from "@/domains/ai/orchestration/lib/graph-canvas-model";
import type { GraphJson } from "@/domains/ai/orchestration/api/graph.schema";

const g = (nodes: object[], edges: object[]): GraphJson =>
  ({ version: 1, inputSchema: {}, nodes, edges }) as GraphJson;
const llm = (id: string, extra: object = {}) => ({
  id, name: id, kind: "llm", modelId: 1, prompt: "p", tools: false,
  outputMode: "text", ...extra,
});

describe("toCanvas", () => {
  it("END 边映射到虚拟节点；无入边节点标 isEntry", () => {
    const json = g(
      [llm("a"), llm("b")],
      [{ from: "a", to: "b" }, { from: "b", to: "END" }],
    );
    const c = toCanvas(json, { a: { x: 0, y: 0 }, b: { x: 1, y: 1 } });
    expect(c.nodes.map((n) => n.id)).toEqual(["a", "b", END_NODE_ID]);
    expect(c.nodes.find((n) => n.id === "a")?.isEntry).toBe(true);
    expect(c.nodes.find((n) => n.id === "b")?.isEntry).toBe(false);
    expect(c.edges).toEqual([
      { id: "a->b:", from: "a", to: "b" },
      { id: `b->${END_NODE_ID}:`, from: "b", to: END_NODE_ID },
    ]);
  });
  it("条件边带 label（branchOptions 值）", () => {
    const json = g(
      [llm("a", { outputMode: "branch", branchOptions: ["go", "stop"] }), llm("b")],
      [
        { from: "a", to: "b", condition: { type: "branch", value: "go" } },
        { from: "a", to: "END", condition: { type: "branch", value: "stop" } },
      ],
    );
    const c = toCanvas(json, {});
    expect(c.edges[0]).toMatchObject({ label: "go" });
    expect(c.edges[1].to).toBe(END_NODE_ID);
  });
});

describe("applyPositions / layoutOf", () => {
  it("写回坐标；未知 id 忽略；无坐标节点经 layoutOf 用 autoLayout 补", () => {
    const json = g([llm("a"), llm("b")], [{ from: "a", to: "b" }]);
    const moved = applyPositions(json, { a: { x: 99, y: 99 }, ghost: { x: 0, y: 0 } });
    expect(moved.nodes[0]).toMatchObject({ position: { x: 99, y: 99 } });
    const laid = layoutOf(json);
    expect(laid.a).toEqual({ x: 80, y: 80 });
    expect(laid.b.x).toBe(80 + 320);
    const withPos = applyPositions(json, { a: { x: 5, y: 5 } });
    expect(layoutOf(withPos).a).toEqual({ x: 5, y: 5 });
    expect(layoutOf(withPos).b).toEqual(autoLayout(json).b);
  });
});

describe("autoLayout", () => {
  it("确定性：同图两次结果全等；分支层内垂直排开", () => {
    const json = g(
      [llm("a", { outputMode: "branch", branchOptions: ["x", "y"] }), llm("b"), llm("c")],
      [
        { from: "a", to: "b", condition: { type: "branch", value: "x" } },
        { from: "a", to: "c", condition: { type: "branch", value: "y" } },
      ],
    );
    expect(autoLayout(json)).toEqual(autoLayout(json));
    const l = autoLayout(json);
    expect(l.b.y).not.toBe(l.c.y);
    expect(l.b.x).toBe(l.c.x);
  });
});

describe("connectEdge", () => {
  const json = g([llm("a"), llm("b")], []);
  it("plain handle 建无条件边；END 虚拟节点映射 to=END", () => {
    const next = connectEdge(json, { source: "a", sourceHandle: "plain", target: "b" });
    expect(next?.edges).toEqual([{ from: "a", to: "b" }]);
    const toEnd = connectEdge(json, { source: "a", sourceHandle: "plain", target: END_NODE_ID });
    expect(toEnd?.edges).toEqual([{ from: "a", to: "END" }]);
  });
  it("branch handle 建条件边", () => {
    const next = connectEdge(json, { source: "a", sourceHandle: "branch:go", target: "b" });
    expect(next?.edges).toEqual([
      { from: "a", to: "b", condition: { type: "branch", value: "go" } },
    ]);
  });
  it("自环与完全重复边返回 null；不同 to 的多条无条件边允许（fan-out）", () => {
    expect(connectEdge(json, { source: "a", sourceHandle: "plain", target: "a" })).toBeNull();
    const once = connectEdge(json, { source: "a", sourceHandle: "plain", target: "b" })!;
    expect(connectEdge(once, { source: "a", sourceHandle: "plain", target: "b" })).toBeNull();
    const c = g([llm("a"), llm("b"), llm("c")], [{ from: "a", to: "b" }]);
    expect(connectEdge(c, { source: "a", sourceHandle: "plain", target: "c" })?.edges).toHaveLength(2);
  });
});
```

- [ ] **Step 6: 跑测试确认 FAIL**

- [ ] **Step 7: 实现 graph-canvas-model.ts**

```ts
// src-react/domains/ai/orchestration/lib/graph-canvas-model.ts
/**
 * 画布模型纯函数（spec §5）：GraphJson ⇄ ReactFlow 展示模型双向映射、
 * 连线规则、分层自动布局。组件零状态逻辑，全部可测。
 */
import { isLlmNode, type GraphJson } from "../api/graph.schema";

export const END_NODE_ID = "__end__";

export interface CanvasNode {
  id: string;
  kind: "llm" | "code";
  name: string;
  modelId?: number;
  language?: string;
  branchOptions?: string[];
  isEntry: boolean;
  position: { x: number; y: number };
}

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

type XY = { x: number; y: number };

/** 拓扑分层（BFS）：层距 320 / 层内距 140，起点 {80,80}；环按首达层放置 */
export function autoLayout(json: GraphJson): Record<string, XY> {
  const incoming = new Map<string, string[]>();
  for (const n of json.nodes) incoming.set(n.id, []);
  for (const e of json.edges) {
    if (e.to !== "END") incoming.get(e.to)?.push(e.from);
  }
  const layer = new Map<string, number>();
  let frontier = json.nodes.filter((n) => (incoming.get(n.id) ?? []).length === 0).map((n) => n.id);
  if (frontier.length === 0 && json.nodes.length > 0) {
    frontier = [json.nodes[0].id]; // 纯环图：任取起点破环
  }
  let depth = 0;
  const seen = new Set<string>();
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      layer.set(id, depth);
      for (const e of json.edges) {
        if (e.from === id && e.to !== "END" && !seen.has(e.to)) next.push(e.to);
      }
    }
    frontier = next;
    depth += 1;
  }
  const perLayer = new Map<number, number>();
  const out: Record<string, XY> = {};
  for (const n of json.nodes) {
    const d = layer.get(n.id) ?? 0;
    const slot = perLayer.get(d) ?? 0;
    perLayer.set(d, slot + 1);
    out[n.id] = { x: 80 + d * 320, y: 80 + slot * 140 };
  }
  return out;
}

/** 装载布局：有 position 用之，缺失经 autoLayout 补齐 */
export function layoutOf(json: GraphJson): Record<string, XY> {
  const fallback = autoLayout(json);
  const out: Record<string, XY> = {};
  for (const n of json.nodes) {
    out[n.id] = n.position ?? fallback[n.id] ?? { x: 80, y: 80 };
  }
  return out;
}

export function toCanvas(
  json: GraphJson,
  layouts: Record<string, XY>,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const hasIncoming = new Set(json.edges.map((e) => e.to));
  const nodes: CanvasNode[] = json.nodes.map((n) => ({
    id: n.id,
    kind: isLlmNode(n) ? "llm" : "code",
    name: n.name,
    ...(isLlmNode(n) ? { modelId: n.modelId } : { language: n.language }),
    ...(isLlmNode(n) && n.outputMode === "branch"
      ? { branchOptions: n.branchOptions ?? [] }
      : {}),
    isEntry: !hasIncoming.has(n.id),
    position: layouts[n.id] ?? { x: 80, y: 80 },
  }));
  const endUsed = json.edges.some((e) => e.to === "END");
  if (endUsed) {
    nodes.push({
      id: END_NODE_ID, kind: "code", name: "END", isEntry: false,
      position: layouts[END_NODE_ID] ?? { x: 80 + (Object.keys(layouts).length + 1) * 320, y: 80 },
    });
  }
  const edges: CanvasEdge[] = json.edges.map((e) => {
    const to = e.to === "END" ? END_NODE_ID : e.to;
    const label = e.condition?.value;
    return { id: `${e.from}->${to}:${label ?? ""}`, from: e.from, to, ...(label ? { label } : {}) };
  });
  return { nodes, edges };
}

export function applyPositions(json: GraphJson, positions: Record<string, XY>): GraphJson {
  return {
    ...json,
    nodes: json.nodes.map((n) =>
      positions[n.id] ? { ...n, position: positions[n.id] } : n,
    ),
  };
}

export function connectEdge(
  json: GraphJson,
  conn: { source: string; sourceHandle: string; target: string },
): GraphJson | null {
  if (conn.source === conn.target) return null;
  const to = conn.target === END_NODE_ID ? "END" : conn.target;
  const branchMatch = /^branch:(.+)$/.exec(conn.sourceHandle ?? "");
  const next = branchMatch
    ? { from: conn.source, to, condition: { type: "branch" as const, value: branchMatch[1] } }
    : { from: conn.source, to };
  const dup = json.edges.some(
    (e) => e.from === next.from && e.to === next.to &&
      (e.condition?.value ?? "") === (next.condition?.value ?? ""),
  );
  if (dup) return null;
  return { ...json, edges: [...json.edges, next] };
}
```

- [ ] **Step 8: 跑通两测试文件 + typecheck + lint**（`npx vitest run tests/ai/graph-canvas-model.test.ts tests/ai/graph-schema.test.ts`、`npm run typecheck` 0 错误——GraphNode 加 position 后既有 typecheck 不应受影响）
- [ ] **Step 9: 提交**

```bash
git add package.json package-lock.json src-react/domains/ai/orchestration/api/graph.schema.ts src-react/domains/ai/orchestration/lib/graph-canvas-model.ts tests/ai/graph-canvas-model.test.ts tests/ai/graph-schema.test.ts
git commit -m "feat(编排): 画布模型纯函数——双向映射/连线规则/分层布局与节点坐标"
```

---

### Task 2: 画布组件（NodeCard/EndMarker/GraphCanvas）

**Files:**
- Create: `src-react/domains/ai/orchestration/components/nodes/NodeCard.tsx`、`src-react/domains/ai/orchestration/components/nodes/EndMarker.tsx`
- Create: `src-react/domains/ai/orchestration/components/GraphCanvas.tsx`
- Modify: `src-react/domains/ai/orchestration/views/GraphEditorView.tsx`（仅顶部 import `@xyflow/react/dist/style.css` 一次）
- Test: `tests/ai/graph-canvas.test.tsx`（jsdom 冒烟）

**Interfaces:**
- Consumes: Task 1 全部产物；`GraphNode`（schema）。
- Produces:
  - `NodeCard`：RF 自定义节点，`data: { canvas: CanvasNode }`，export
  - `EndMarker`：RF 自定义节点（无 data 依赖），export
  - `GraphCanvas` 默认导出，props：
    ```ts
    interface GraphCanvasProps {
      graph: GraphJson;
      layouts: Record<string, { x: number; y: number }>;
      selectedId: string | null;           // 节点或边 id（边 id 即 toCanvas 的稳定串）
      onSelect: (id: string | null) => void;
      onMove: (positions: Record<string, { x: number; y: number }>) => void; // 拖拽落点
      onConnect: (conn: { source: string; sourceHandle: string; target: string }) => void;
      onAddNode: (kind: "llm" | "code") => void;
      onRemoveNode: (nodeId: string) => void;
      onRemoveEdge: (edgeId: string) => void;
      focusNodeId?: string | null;          // 错误定位：setCenter + 高亮
    }
    ```
  - 边 id ⇄ GraphJson 边的还原规则（onRemoveEdge 消费方使用）：
    `export function edgeIdToRef(id: string): { from: string; to: string; label?: string }`（按 `${from}->${to}:${label}` 反解，to 为 END_NODE_ID 时还原 "END"）——放 graph-canvas-model.ts（若 T1 未含，本任务补入并测试）。

- [ ] **Step 1: jsdom 冒烟测试先行（tests/ai/graph-canvas.test.tsx）**

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(cleanup);
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import GraphCanvas from "@/domains/ai/orchestration/components/GraphCanvas";
import { END_NODE_ID } from "@/domains/ai/orchestration/lib/graph-canvas-model";
import type { GraphJson } from "@/domains/ai/orchestration/api/graph.schema";

const graph: GraphJson = {
  version: 1, inputSchema: {},
  nodes: [
    { id: "a", name: "甲", kind: "llm", modelId: 1, prompt: "p", tools: false, outputMode: "branch", branchOptions: ["go", "stop"] },
    { id: "b", name: "乙", kind: "code", language: "bash", script: "echo" },
  ],
  edges: [
    { from: "a", to: "b", condition: { type: "branch", value: "go" } },
    { from: "b", to: "END" },
  ],
};

describe("GraphCanvas 冒烟", () => {
  it("渲染节点名/END 虚拟节点/分支 handle 标签", () => {
    render(
      <GraphCanvas
        graph={graph} layouts={{}} selectedId={null}
        onSelect={() => {}} onMove={() => {}} onConnect={() => {}}
        onAddNode={() => {}} onRemoveNode={() => {}} onRemoveEdge={() => {}}
      />,
    );
    expect(screen.getByText("甲")).toBeTruthy();
    expect(screen.getByText("乙")).toBeTruthy();
    expect(screen.getByText("END")).toBeTruthy();
    expect(screen.getByText("go")).toBeTruthy(); // 分支 handle 标签
  });
});
```

- [ ] **Step 2: 确认 FAIL**（组件不存在）
- [ ] **Step 3: 实现 NodeCard/EndMarker/GraphCanvas**（要点，全部语义 token）：

NodeCard：卡片 `w-[220px] rounded-lg border bg-card p-2 shadow-sm`（选中 `border-primary ring-1 ring-primary/40`）；头部徽标（llm=Sparkles+`text-primary`，code=Terminal+`text-muted-foreground`）+ isEntry 时右上 `Badge variant="outline"` 入口标；主体名称 + 摘要（llm：模型名经 `models/all` query 映射（ModelSelect 同款数据），缺省 `chat:orchestration.editor.selectModel` 占位灰字；branch 时 chips 列 branchOptions；code：语言大写标签）；handles：`<Handle type="target" position={Position.Left} id="target" />` + source 区——branch 节点 `branchOptions.map(v => <Handle type="source" position={Position.Right} id={`branch:${v}`} style={{ top: 均分偏移 }} />)` 每个旁标小标签 v；普通节点单 `<Handle type="source" position={Position.Right} id="plain" />`。

EndMarker：`rounded-full border border-dashed border-border px-4 py-2 text-xs text-muted-foreground`，仅 target handle；`draggable={false}` `deletable={false}`（在 GraphCanvas 组装时设置 node 属性）。

GraphCanvas：
```tsx
// 骨架（import { ReactFlow, Background, Controls, MiniMap, useReactFlow,
//   type Node, type Edge, type Connection, type NodeMouseHandler } from "@xyflow/react"）
// nodeTypes = { card: NodeCard, end: EndMarker } 模块级常量（RF 要求稳定引用）
// toCanvas(graph, layouts) → useMemo：
//   RF nodes = canvas 节点.map(n => ({ id, type: n.id === END_NODE_ID ? "end" : "card",
//     position, data: { canvas: n }, selected: n.id === selectedId,
//     deletable: n.id !== END_NODE_ID, draggable: n.id !== END_NODE_ID }))
//   RF edges = canvas edges.map(e => ({ id, source: e.from, target: e.to,
//     label: e.label, labelStyle 字号 10, animated: false,
//     style: { stroke: "hsl(var(--border))" } …语义 token 经 CSS 变量 }))
// onConnect={(c: Connection) => c.source && c.target && onConnect({ source: c.source,
//   sourceHandle: c.sourceHandle ?? "plain", target: c.target })}
// onNodesChange：收集 position changes → 防抖 300ms 批量 onMove(Record)（RF
//   applyNodeChanges 不自持状态——nodes 由 props 派生，position change 直接
//   映射为 onMove 载荷；dimensions/remove 类 change 由外层经 onRemoveNode 处理）
// onNodeClick/onEdgeClick → onSelect(id)；onPaneClick → onSelect(null)
// Delete 键：RF 默认 onNodesDelete/onEdgesDelete → onRemoveNode/onRemoveEdge(edgeId)
// focusNodeId 变化：useEffect 经 useReactFlow().setCenter(节点中心, { zoom: 1.2 })
//   + 临时 selected 样式（经 props selectedId 由外层驱动亦可，最小实现：
//   setCenter + onSelect(focusNodeId)）
// 工具栏（画布左上 absolute）：「+ AI 节点 / + 代码节点」两 Button（h-7）
```

- [ ] **Step 4: GraphEditorView 顶部加 `import "@xyflow/react/dist/style.css";`**（本任务仅此一行，视图改造在 T3）
- [ ] **Step 5: 跑冒烟 + 全量回归 + typecheck + lint**
- [ ] **Step 6: 提交**

```bash
git add src-react/domains/ai/orchestration/components tests/ai/graph-canvas.test.tsx src-react/domains/ai/orchestration/views/GraphEditorView.tsx
git commit -m "feat(编排): React Flow 画布——节点卡片/分支 handle/END 虚拟节点/连线与删除"
```

---

### Task 3: 属性面板 + GraphEditorView 画布模式改造

**Files:**
- Create: `src-react/domains/ai/orchestration/components/NodePropertiesPanel.tsx`
- Modify: `src-react/domains/ai/orchestration/views/GraphEditorView.tsx`（mode/布局/选中态/错误定位接线；GraphJsonEditor/试运行/历史弹窗/保存逻辑不动）
- Modify: `src-react/domains/ai/orchestration/lib/graph-editor-model.ts:19`（`EditorMode = "canvas" | "json"`）
- Delete（退役）: 留到 T4 统一清理（本任务先不 import）
- Test: `tests/ai/graph-editor-view.test.tsx`（改造）、`tests/ai/graph-editor-model.test.ts`（EditorMode 相关断言适配）

**Interfaces:**
- Consumes: T1（connectEdge/applyPositions/toCanvas/edgeIdToRef/layoutOf）、T2（GraphCanvas props）、既有 `GraphNodeEditor` 的 `LlmNodeFields`/`CodeNodeFields`/`Field`/`StringListInput`（**需在 GraphNodeEditor.tsx 将 LlmNodeFields/CodeNodeFields/Field 加 export**——最小改动）。
- Produces: `NodePropertiesPanel` 默认导出，props：
  ```ts
  interface NodePropertiesPanelProps {
    graph: GraphJson;
    selectedId: string | null;       // 节点 id 或边稳定 id；null=图级
    onPatchNode: (nodeId: string, patch: GraphNodePatch) => void;
    onSwitchKind: (nodeId: string, kind: "llm" | "code") => void;
    onRenameNode: (nodeId: string, nextId: string) => void;
    onRemoveNode: (nodeId: string) => void;
    onRemoveEdge: (edgeId: string) => void;
    onPatchEdgeCondition: (edgeId: string, value: string | undefined) => void;
    onGraphMeta: (patch: { name?: string; description?: string; variables?: string[] }) => void;
    idLocked: (nodeId: string) => boolean;
  }
  ```

- [ ] **Step 1: 测试先行**——graph-editor-view.test.tsx 改造：默认渲染画布节点名；切 JSON 再切回同步；选中节点后面板出现字段（kind 切换钮）。既有用例中 structured 字样全部改 canvas（`sed` 核对零遗漏）。graph-editor-model.test.ts 中 EditorMode 断言适配。
- [ ] **Step 2: 确认 FAIL**
- [ ] **Step 3: 实现 NodePropertiesPanel**（三分支）：
  - 未选中：图名称/描述 Input + inputSchema 变量 StringListInput（onGraphMeta）
  - 节点：顶栏（`Badge` 节点 id + 删除钮）+ kind 切换 Select + `LlmNodeFields`/`CodeNodeFields`（从 GraphNodeEditor 复用，onPatch/onSwitchKind 透传；id 锁定提示沿 nodeIdLocked）
  - 边：from/to 只读 `code` 样式 + 源为 branch 节点时条件下拉（选项=其 branchOptions + 「无条件」清空项）+ 删除边；非 branch 源显示只读「无条件」
- [ ] **Step 4: GraphEditorView 改造**：
  - `mode: EditorMode`（"canvas"|"json"），默认 "canvas"；MODES 常量与切换钮文案（i18n `modeCanvas`/`modeJson`——modeStructured 键退役）
  - 布局：`flex`——左画布区（`flex-1 min-h-0`，内嵌 GraphCanvas）+ 右 `NodePropertiesPanel`（`w-[300px] shrink-0 border-l border-border/50 overflow-y-auto`）；JSON 模式时面板隐藏（全宽 GraphJsonEditor）
  - 状态：`selectedId`（string|null）；`onMove` → 防抖后 `setGraph(applyPositions)`；`onConnect` → `setGraph(connectEdge(...))`（null 时忽略）；`onAddNode` → nextNodeId + newNode/newCodeNode + setGraph + 自动选中新节点；`onRemoveNode` → removeNodeFromGraph + 清 selectedId；`onRemoveEdge` → edgeIdToRef 反解过滤 edges；`onPatchEdgeCondition` → 重写该边 condition
  - 装载：既有 record 装载后 `layoutOf` 计算坐标（不落 graphJson，拖动/保存才落）
  - 错误定位：错误列表条目若含 nodeId（danglingEdge/branchOptionsRequired/uniqueEntry 的 params），点击设 `focusNodeId`（GraphCanvas setCenter）+ `selectedId`；GraphIssue 已带 params.nodeId（schema 现状），`localizeGraphIssue` 不变
  - 试运行/运行历史/保存/乐观锁/模板预填逻辑**全部不动**
- [ ] **Step 5: 跑改造测试 + 全量 + typecheck + lint**
- [ ] **Step 6: 提交**

```bash
git add src-react/domains/ai/orchestration tests/ai/graph-editor-view.test.tsx tests/ai/graph-editor-model.test.ts
git commit -m "feat(编排): 画布主模式与选中驱动属性面板——错误定位/连线规则接线"
```

---

### Task 4: i18n + 退役清理 + 全量回归与冒烟清单

**Files:**
- Modify: `src-react/i18n/locales/zh-CN/chat.json`、`en-US/chat.json`（`orchestration.editor` 增：modeCanvas/modeLabel（如「AI 节点」已有 kindLlm 复用）/addLlmNode/addCodeNode/entryBadge/endNode/edgeNoCondition/edgeCondition/removeEdge/panelGraphTitle 等——以 T2/T3 实际引用的 key 反查补齐，zh/en 同步集合一致）
- Delete: `src-react/domains/ai/orchestration/components/GraphEdgeEditor.tsx`（确认零引用后）
- Modify: `docs/update-log.md` 若项目惯例需要（当前仅 0.1.0 初始条目，无逐 feature 惯例——跳过）

**Interfaces:** 无新接口。

- [ ] **Step 1: grep T2/T3 新增 `t("chat:orchestration.` 引用，zh/en 双语补齐（node 脚本比对叶子 key 集合一致，先例 T12）**
- [ ] **Step 2: 删 GraphEdgeEditor.tsx 前全局 grep 零引用确认**
- [ ] **Step 3: 全量验证**：`npm run test` 全绿（含既有 2225+ 用例零回归）、`npm run typecheck` 0、`npm run lint` 0、`npx vite build` 通过（ReactFlow 打包体积/分块确认）
- [ ] **Step 4: 手工冒烟清单写入交付说明**（spec §8 八条）
- [ ] **Step 5: 提交**

```bash
git add src-react/i18n/locales src-react/domains/ai/orchestration
git commit -m "feat(编排): 画布编辑器 i18n 全量与 GraphEdgeEditor 退役"
```

---

## Self-Review 记录

- **Spec 覆盖**：§0 决策→Global Constraints；§1 数据模型→T1；§2 画布交互→T2（卡片/handles/连线/删除/工具栏/小地图）；§3 属性面板→T3；§4 校验联动→T3（focusNodeId）；§5 组件结构→文件清单一致；§6 错误处理→T1（finite）/T3（装载 layoutOf）/T4（build）；§7 测试→各任务 TDD + T4 全量；§8 冒烟→T4；§9 范围外未引入。无缺口。
- **占位符扫描**：T2 Step 3 为「要点式」组件规格（RF 组件 ~300 行，给了 nodeTypes 受控映射/onConnect/onDelete/焦点定位的完整接线语义与关键代码），执行者有 spec §2 与 RF 官方 API；其余任务均含实码。
- **类型一致性**：CanvasNode/CanvasEdge/END_NODE_ID/connectEdge 签名 T1 定义、T2/T3 消费一致；edgeIdToRef 在 T2 Interfaces 声明并标注「T1 未含则 T2 补入并测试」；GraphCanvasProps 与 NodePropertiesPanelProps 的回调名在 T2/T3 间一致（onPatchNode/onSwitchKind/onRemoveNode/onRemoveEdge）；EditorMode 改名影响面（MODES/断言）在 T3 列全。
