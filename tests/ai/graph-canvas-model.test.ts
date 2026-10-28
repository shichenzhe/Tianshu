import { describe, expect, it } from "vitest";
import {
  END_NODE_ID,
  toCanvas,
  applyPositions,
  autoLayout,
  connectEdge,
  edgeIdToRef,
  layoutOf,
} from "@/domains/ai/orchestration/lib/graph-canvas-model";
import type { GraphJson } from "@/domains/ai/orchestration/api/graph.schema";

const g = (nodes: object[], edges: object[]): GraphJson =>
  ({ version: 1, inputSchema: {}, nodes, edges }) as GraphJson;
const llm = (id: string, extra: object = {}) => ({
  id,
  name: id,
  kind: "llm",
  modelId: 1,
  prompt: "p",
  tools: false,
  outputMode: "text",
  ...extra,
});

describe("toCanvas", () => {
  it("END 边映射到虚拟节点；无入边节点标 isEntry", () => {
    const json = g(
      [llm("a"), llm("b")],
      [
        { from: "a", to: "b" },
        { from: "b", to: "END" },
      ],
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
  it("END 虚拟节点常驻：无 END 边的图也渲染（新图须有落点可创建第一条 END 边）", () => {
    const c = toCanvas(g([llm("a")], []), { a: { x: 0, y: 0 } });
    expect(c.nodes.map((n) => n.id)).toEqual(["a", END_NODE_ID]);
    expect(c.edges).toEqual([]);
  });
  it("code 分支节点的 branchOptions 进画布并锚定 sourceHandle（与 llm 同构）", () => {
    const json = g(
      [
        {
          id: "route",
          name: "route",
          kind: "code",
          language: "bash",
          script: "echo go",
          outputMode: "branch",
          branchOptions: ["go", "stop"],
        },
        llm("sink"),
      ],
      [
        {
          from: "route",
          to: "sink",
          condition: { type: "branch", value: "go" },
        },
        {
          from: "route",
          to: "END",
          condition: { type: "branch", value: "stop" },
        },
        { from: "sink", to: "END" },
      ],
    );
    const c = toCanvas(json, {});
    expect(c.nodes.find((n) => n.id === "route")?.branchOptions).toEqual([
      "go",
      "stop",
    ]);
    expect(c.edges[0]).toMatchObject({
      label: "go",
      sourceHandle: "branch:go",
    });
  });
  it("条件边带 label（branchOptions 值）", () => {
    const json = g(
      [
        llm("a", { outputMode: "branch", branchOptions: ["go", "stop"] }),
        llm("b"),
      ],
      [
        { from: "a", to: "b", condition: { type: "branch", value: "go" } },
        { from: "a", to: "END", condition: { type: "branch", value: "stop" } },
      ],
    );
    const c = toCanvas(json, {});
    expect(c.edges[0]).toMatchObject({ label: "go" });
    expect(c.edges[1].to).toBe(END_NODE_ID);
  });
  it("条件边锚定 sourceHandle=branch:<value>（含 END 目标）；无条件边/条件越界缺省兜底", () => {
    const json = g(
      [
        llm("a", { outputMode: "branch", branchOptions: ["go", "stop"] }),
        llm("b"),
        llm("c"),
      ],
      [
        { from: "a", to: "b", condition: { type: "branch", value: "go" } },
        { from: "a", to: "END", condition: { type: "branch", value: "stop" } },
        { from: "a", to: "b" },
        { from: "a", to: "c", condition: { type: "branch", value: "ghost" } },
      ],
    );
    const c = toCanvas(json, {});
    // 锚定 id 与 NodeCard 渲染的 branch handle 对齐，防全量出边都从第一 handle 出发
    expect(c.edges[0].sourceHandle).toBe("branch:go");
    expect(c.edges[1].sourceHandle).toBe("branch:stop");
    // 无条件边/越界条件（校验失败态）不锚定：RF getHandle 缺 id 取第一
    // handle 兜底，越界 id 匹配不到 handle 反致 error008 边消失
    expect(c.edges[2].sourceHandle).toBeUndefined();
    expect(c.edges[3].sourceHandle).toBeUndefined();
  });
});

describe("applyPositions / layoutOf", () => {
  it("写回坐标；未知 id 忽略；无坐标节点经 layoutOf 用 autoLayout 补", () => {
    const json = g([llm("a"), llm("b")], [{ from: "a", to: "b" }]);
    const moved = applyPositions(json, {
      a: { x: 99, y: 99 },
      ghost: { x: 0, y: 0 },
    });
    expect(moved.nodes[0]).toMatchObject({ position: { x: 99, y: 99 } });
    const laid = layoutOf(json);
    expect(laid.a).toEqual({ x: 80, y: 80 });
    expect(laid.b.x).toBe(80 + 320);
    const withPos = applyPositions(json, { a: { x: 5, y: 5 } });
    expect(layoutOf(withPos).a).toEqual({ x: 5, y: 5 });
    expect(layoutOf(withPos).b).toEqual(autoLayout(json).b);
  });

  it("END 虚拟节点落点写图级 endPosition；toCanvas 优先读之", () => {
    const json = g([llm("a")], [{ from: "a", to: "END" }]);
    // 拖 END：positions 键为 END_NODE_ID，落进 json.endPosition
    const moved = applyPositions(json, {
      [END_NODE_ID]: { x: 700, y: 260 },
    });
    expect(moved.endPosition).toEqual({ x: 700, y: 260 });
    expect(moved.nodes).toHaveLength(1); // 不混入虚拟节点
    const c = toCanvas(moved, layoutOf(moved));
    expect(c.nodes.find((n) => n.id === END_NODE_ID)?.position).toEqual({
      x: 700,
      y: 260,
    });
    // 无 endPosition 的旧图：END 仍自动摆右缘（缺省回退）
    expect(
      toCanvas(json, layoutOf(json)).nodes.find((n) => n.id === END_NODE_ID)
        ?.position,
    ).not.toEqual({ x: 700, y: 260 });
  });
});

describe("autoLayout", () => {
  it("确定性：同图两次结果全等；分支层内垂直排开", () => {
    const json = g(
      [
        llm("a", { outputMode: "branch", branchOptions: ["x", "y"] }),
        llm("b"),
        llm("c"),
      ],
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

describe("edgeIdToRef", () => {
  it("普通边反解；END 虚拟节点 id 还原 to=END", () => {
    expect(edgeIdToRef("a->b:")).toEqual({ from: "a", to: "b" });
    expect(edgeIdToRef(`b->${END_NODE_ID}:`)).toEqual({ from: "b", to: "END" });
  });
  it("带 label 的边反解（含 END 目标）", () => {
    expect(edgeIdToRef("a->b:go")).toEqual({ from: "a", to: "b", label: "go" });
    expect(edgeIdToRef(`a->${END_NODE_ID}:stop`)).toEqual({
      from: "a",
      to: "END",
      label: "stop",
    });
  });
});

describe("connectEdge", () => {
  const json = g([llm("a"), llm("b")], []);
  it("plain handle 建无条件边；END 虚拟节点映射 to=END", () => {
    const next = connectEdge(json, {
      source: "a",
      sourceHandle: "plain",
      target: "b",
    });
    expect(next?.edges).toEqual([{ from: "a", to: "b" }]);
    const toEnd = connectEdge(json, {
      source: "a",
      sourceHandle: "plain",
      target: END_NODE_ID,
    });
    expect(toEnd?.edges).toEqual([{ from: "a", to: "END" }]);
  });
  it("branch handle 建条件边", () => {
    const next = connectEdge(json, {
      source: "a",
      sourceHandle: "branch:go",
      target: "b",
    });
    expect(next?.edges).toEqual([
      { from: "a", to: "b", condition: { type: "branch", value: "go" } },
    ]);
  });
  it("自环与完全重复边返回 null；不同 to 的多条无条件边允许（fan-out）", () => {
    expect(
      connectEdge(json, { source: "a", sourceHandle: "plain", target: "a" }),
    ).toBeNull();
    const once = connectEdge(json, {
      source: "a",
      sourceHandle: "plain",
      target: "b",
    })!;
    expect(
      connectEdge(once, { source: "a", sourceHandle: "plain", target: "b" }),
    ).toBeNull();
    const c = g([llm("a"), llm("b"), llm("c")], [{ from: "a", to: "b" }]);
    expect(
      connectEdge(c, { source: "a", sourceHandle: "plain", target: "c" })
        ?.edges,
    ).toHaveLength(2);
  });
});
