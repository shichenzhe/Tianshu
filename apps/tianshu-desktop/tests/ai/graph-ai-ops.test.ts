// 图 AI 变更单应用器单测：ops 折叠语义、前置校验抛错、坐标合并
import { describe, expect, it } from "vitest";
import {
  emptyGraph,
  newCodeNode,
  newHttpNode,
} from "@/domains/ai/orchestration/lib/graph-editor-model";
import type { GraphJson } from "@/domains/ai/orchestration/api/graph.schema";
import {
  applyGraphOps,
  graphChangeSetSchema,
  mergeSurvivingPositions,
  type GraphOp,
} from "@/domains/ai/orchestration/lib/graph-ai-ops";

describe("graphChangeSetSchema", () => {
  it("解析合法变更单并拒绝未知操作", () => {
    // 工厂产 name/script 空串（编辑器占位语义），schema 需合法值
    const node = { ...newCodeNode("code-1"), name: "代码", script: "echo hi" };
    const ok = graphChangeSetSchema.safeParse({
      ops: [
        { op: "addNode", node },
        { op: "removeNode", id: "node-1" },
      ],
    });
    expect(ok.success).toBe(true);
    const bad = graphChangeSetSchema.safeParse({ ops: [{ op: "explode" }] });
    expect(bad.success).toBe(false);
  });
});

describe("applyGraphOps", () => {
  it("addNode 追加节点、addEdge 追加边", () => {
    const graph = emptyGraph();
    const next = applyGraphOps(graph, [
      { op: "addNode", node: newCodeNode("code-1") },
      { op: "addEdge", edge: { from: "node-1", to: "code-1" } },
    ]);
    expect(next.nodes.map((n) => n.id)).toContain("code-1");
    expect(next.edges).toContainEqual({ from: "node-1", to: "code-1" });
    // 原图不被修改
    expect(graph.edges).toHaveLength(1);
  });

  it("removeNode 级联删除引用它的边", () => {
    const graph: GraphJson = {
      ...emptyGraph(),
      edges: [
        { from: "start", to: "node-1" },
        { from: "node-1", to: "start" },
      ],
    };
    const next = applyGraphOps(graph, [{ op: "removeNode", id: "node-1" }]);
    expect(next.nodes.map((n) => n.id)).not.toContain("node-1");
    expect(next.edges).toHaveLength(0);
  });

  it("renameNode 同步边引用", () => {
    const graph = emptyGraph();
    const next = applyGraphOps(graph, [
      { op: "renameNode", from: "node-1", to: "node-2" },
    ]);
    expect(next.nodes.map((n) => n.id)).toContain("node-2");
    expect(next.edges).toContainEqual({ from: "start", to: "node-2" });
  });

  it("updateNode 宽松补丁合并字段", () => {
    const graph = emptyGraph();
    const next = applyGraphOps(graph, [
      { op: "updateNode", id: "node-1", patch: { name: "改名后" } },
    ]);
    const target = next.nodes.find((n) => n.id === "node-1");
    expect(target?.name).toBe("改名后");
  });

  it("updateNode patch 含 id/kind 抛错", () => {
    const graph = emptyGraph();
    expect(() =>
      applyGraphOps(graph, [
        { op: "updateNode", id: "node-1", patch: { id: "evil" } },
      ]),
    ).toThrow(/id/);
    expect(() =>
      applyGraphOps(graph, [
        { op: "updateNode", id: "node-1", patch: { kind: "code" } },
      ]),
    ).toThrow(/kind/);
  });

  it("操作不存在的节点抛错且消息含节点 id", () => {
    const graph = emptyGraph();
    const ops: GraphOp[] = [
      { op: "updateNode", id: "ghost", patch: { name: "x" } },
    ];
    expect(() => applyGraphOps(graph, ops)).toThrow(/ghost/);
    expect(() =>
      applyGraphOps(graph, [{ op: "removeNode", id: "ghost" }]),
    ).toThrow(/ghost/);
    expect(() =>
      applyGraphOps(graph, [{ op: "renameNode", from: "ghost", to: "g2" }]),
    ).toThrow(/ghost/);
  });

  it("addEdge 自环与重复边抛错", () => {
    const graph = emptyGraph();
    expect(() =>
      applyGraphOps(graph, [{ op: "addEdge", edge: { from: "start", to: "start" } }]),
    ).toThrow();
    expect(() =>
      applyGraphOps(graph, [
        { op: "addEdge", edge: { from: "start", to: "node-1" } },
      ]),
    ).toThrow();
  });

  it("addEdge 引用不存在的端点抛错", () => {
    const graph = emptyGraph();
    expect(() =>
      applyGraphOps(graph, [
        { op: "addEdge", edge: { from: "ghost", to: "node-1" } },
      ]),
    ).toThrow(/ghost/);
  });

  it("removeEdge 按 from/to 删除", () => {
    const graph: GraphJson = {
      ...emptyGraph(),
      edges: [
        { from: "start", to: "node-1" },
        { from: "start", to: "node-1", condition: { type: "branch", value: "b" } },
      ],
    };
    const next = applyGraphOps(graph, [
      { op: "removeEdge", from: "start", to: "node-1" },
    ]);
    expect(next.edges).toHaveLength(1);
    expect(next.edges[0].condition?.value).toBe("b");
  });

  it("addNode 已存在同 id 节点抛错", () => {
    const graph = emptyGraph();
    expect(() =>
      applyGraphOps(graph, [{ op: "addNode", node: newHttpNode("node-1") }]),
    ).toThrow(/node-1/);
  });
});

describe("mergeSurvivingPositions", () => {
  it("next 缺坐标的存活节点继承 current 坐标，自带坐标不被覆盖", () => {
    const current: GraphJson = {
      ...emptyGraph(),
      endPosition: { x: 9, y: 9 },
      nodes: emptyGraph().nodes.map((n) => ({
        ...n,
        position: { x: 1, y: 2 },
      })),
    };
    const next: GraphJson = {
      ...current,
      nodes: [
        { ...newCodeNode("code-1") },
        {
          ...current.nodes[1],
          position: { x: 5, y: 5 },
        },
      ],
    };
    const merged = mergeSurvivingPositions(current, next);
    expect(merged.nodes[0].position).toBeUndefined();
    expect(merged.nodes[1].position).toEqual({ x: 5, y: 5 });
    expect(merged.endPosition).toEqual({ x: 9, y: 9 });
  });
});
