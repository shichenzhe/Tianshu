// tests/ai/graph-compiler.test.ts
import { describe, expect, it } from "vitest";
import {
  buildEdgePlan,
  compileStateGraph,
  GRAPH_RECURSION_LIMIT,
} from "../../electron/domains/ai/orchestration/graph-compiler";
import type { GraphJson } from "../../src-react/domains/ai/orchestration/api/graph.schema";

const json: GraphJson = {
  version: 1,
  inputSchema: {},
  nodes: [
    {
      id: "a",
      name: "A",
      kind: "llm",
      modelId: 1,
      prompt: "p",
      tools: false,
      outputMode: "branch",
      branchOptions: ["x", "y"],
    },
    {
      id: "b",
      name: "B",
      kind: "llm",
      modelId: 1,
      prompt: "p",
      tools: false,
      outputMode: "text",
    },
  ],
  edges: [
    { from: "a", to: "b", condition: { type: "branch", value: "x" } },
    { from: "a", to: "END", condition: { type: "branch", value: "y" } },
  ],
};

describe("buildEdgePlan", () => {
  it("条件边按 from 聚合成 mapping", () => {
    expect(buildEdgePlan(json)).toEqual({
      direct: [],
      conditional: [{ from: "a", mapping: { x: "b", y: "END" } }],
    });
  });
});

describe("compileStateGraph", () => {
  it("按 route 分支执行到 END", async () => {
    const handlers = {
      a: async () => ({ nodes: { a: { output: "" } }, route: "y" }),
      b: async () => ({ nodes: { b: { output: "ran-b" } } }),
    };
    const compiled = compileStateGraph(json, handlers);
    expect(GRAPH_RECURSION_LIMIT).toBe(25);
    expect(compiled.config.recursionLimit).toBe(GRAPH_RECURSION_LIMIT);
    const result = await compiled.graph.invoke(
      { inputs: {}, nodes: {} },
      compiled.config,
    );
    expect(result.nodes.b).toBeUndefined();
  });
  it("route=x 走 b", async () => {
    const handlers = {
      a: async () => ({ nodes: { a: { output: "" } }, route: "x" }),
      b: async () => ({ nodes: { b: { output: "ran-b" } } }),
    };
    const compiled = compileStateGraph(json, handlers);
    const result = await compiled.graph.invoke(
      { inputs: {}, nodes: {} },
      compiled.config,
    );
    expect(result.nodes.b).toEqual({ output: "ran-b" });
  });
  it("route 未映射标签回落 __fallback__→END（不按不存在节点炸图）", async () => {
    const handlers = {
      a: async () => ({ nodes: { a: { output: "" } }, route: "zzz" }),
      b: async () => ({ nodes: { b: { output: "ran-b" } } }),
    };
    const compiled = compileStateGraph(json, handlers);
    const result = await compiled.graph.invoke(
      { inputs: {}, nodes: {} },
      compiled.config,
    );
    expect(result.nodes.b).toBeUndefined();
  });
});
