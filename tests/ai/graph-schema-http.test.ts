// tests/ai/graph-schema-http.test.ts
/**
 * HTTP 节点 schema：合法通过（默认 method/空头参/bodyType 补全）、
 * url 必填、非法 method 拒绝、与 llm/code 混合图合法。
 */
import { describe, expect, it } from "vitest";
import { validateGraph } from "../../src-react/domains/ai/orchestration/api/graph.schema";

const httpNode = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  kind: "http",
  url: "https://api.test/x",
  ...extra,
});
const llm = (id: string) => ({
  id,
  name: id,
  kind: "llm",
  modelId: 1,
  prompt: "p",
});
const base = (nodes: object[], edges: object[]) => ({
  version: 1,
  inputSchema: {},
  nodes,
  edges,
});

describe("HTTP 节点 schema", () => {
  it("合法通过；缺省补 method=GET / headers=[] / query=[] / bodyType=none / timeoutMs=10000", () => {
    const r = validateGraph(
      base([httpNode("call")], [{ from: "call", to: "END" }]),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.nodes[0]).toMatchObject({
        kind: "http",
        method: "GET",
        headers: [],
        query: [],
        bodyType: "none",
        timeoutMs: 120_000,
      });
    }
  });

  it("url 必填拒绝；非法 method 拒绝", () => {
    expect(
      validateGraph(
        base([httpNode("call", { url: "" })], [{ from: "call", to: "END" }]),
      ).ok,
    ).toBe(false);
    expect(
      validateGraph(
        base(
          [httpNode("call", { method: "TRACE" })],
          [{ from: "call", to: "END" }],
        ),
      ).ok,
    ).toBe(false);
  });

  it("body 有值且 bodyType 缺省 → 推断为 json（写了 body 即意图发送，防 UI/执行器双双丢失）", () => {
    const r = validateGraph(
      base(
        [httpNode("call", { method: "POST", body: '{"k":1}' })],
        [{ from: "call", to: "END" }],
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.nodes[0]).toMatchObject({
        method: "POST",
        bodyType: "json",
        body: '{"k":1}',
      });
    }
  });

  it("bodyType 显式 none 时即使有 body 也不推断（尊重显式配置）", () => {
    const r = validateGraph(
      base(
        [httpNode("call", { method: "POST", bodyType: "none", body: "x" })],
        [{ from: "call", to: "END" }],
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.nodes[0]).toMatchObject({ bodyType: "none" });
    }
  });

  it("与 llm 混合图合法；http 节点可作入口与终点", () => {
    const r = validateGraph(
      base(
        [llm("think"), httpNode("call")],
        [
          { from: "think", to: "call" },
          { from: "call", to: "END" },
        ],
      ),
    );
    expect(r.ok).toBe(true);
  });
});
