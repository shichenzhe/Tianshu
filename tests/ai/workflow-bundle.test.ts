// workflow-bundle 单测：bundle 组装/解析/名称去重纯函数（批量导出/回导核心口径）
import { describe, expect, it } from "vitest";
import {
  buildWorkflowBundle,
  dedupeName,
  parseWorkflowBundle,
} from "../../electron/domains/ai/orchestration/workflow-bundle";

const ITEM = {
  name: "搜索并总结",
  description: "联网检索后汇总",
  graphJson: '{"nodes":[]}',
};

describe("buildWorkflowBundle", () => {
  it("组装 bundle：kind/version/workflows，graphJson 转对象", () => {
    const doc = buildWorkflowBundle([
      ITEM,
      { ...ITEM, name: "B", description: undefined, graphJson: "{}" },
    ]);
    expect(doc.kind).toBe("tianshu-workflow-bundle");
    expect(doc.version).toBe(1);
    expect(doc.workflows).toEqual([
      {
        kind: "tianshu-workflow",
        version: 1,
        name: "搜索并总结",
        description: "联网检索后汇总",
        graphJson: { nodes: [] },
      },
      {
        kind: "tianshu-workflow",
        version: 1,
        name: "B",
        description: "",
        graphJson: {},
      },
    ]);
  });

  it("graphJson 非法项跳过（库里不该发生，容错兜底）", () => {
    const doc = buildWorkflowBundle([
      ITEM,
      { ...ITEM, name: "bad", graphJson: "{oops" },
    ]);
    expect(doc.workflows.map((w) => w.name)).toEqual(["搜索并总结"]);
  });

  it("空清单 → 空 workflows（repo 侧调用前已挡空，纯函数兜底）", () => {
    expect(buildWorkflowBundle([]).workflows).toEqual([]);
  });
});

describe("parseWorkflowBundle", () => {
  it("合法 bundle → 逐项提取（description 兜底空串；空名项进 failed）", () => {
    const parsed = parseWorkflowBundle({
      kind: "tianshu-workflow-bundle",
      version: 1,
      workflows: [
        { name: "A", description: "d", graphJson: { nodes: 1 } },
        { name: "", graphJson: { nodes: 2 } },
      ],
    });
    expect(parsed).toEqual({
      ok: true,
      items: [{ name: "A", description: "d", graphJson: { nodes: 1 } }],
      failed: [{ name: "(unknown)", reason: "缺少名称" }],
    });
  });

  it("非 bundle（null/数组/缺 kind/kind 不符/workflows 非数组）→ ok:false", () => {
    for (const bad of [
      null,
      [],
      { kind: "tianshu-workflow" },
      { kind: "tianshu-workflow-bundle" },
      { kind: "tianshu-workflow-bundle", workflows: "x" },
    ]) {
      expect(parseWorkflowBundle(bad).ok).toBe(false);
    }
  });

  it("workflows 项里 graphJson 缺失/非对象 → 该项进 failed（名字可取得时）", () => {
    const parsed = parseWorkflowBundle({
      kind: "tianshu-workflow-bundle",
      version: 1,
      workflows: [
        { name: "good", graphJson: { a: 1 } },
        { name: "bad1", graphJson: "str" },
        { graphJson: { a: 1 } },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.items).toEqual([
        { name: "good", description: "", graphJson: { a: 1 } },
      ]);
      expect(parsed.failed).toEqual([
        { name: "bad1", reason: "graphJson 缺失或不是对象" },
        { name: "(unknown)", reason: "缺少名称" },
      ]);
    }
  });
});

describe("dedupeName", () => {
  it("不冲突原名直出；冲突追加 (2)/(3) 递增", () => {
    const used = new Set<string>();
    expect(dedupeName("A", used)).toBe("A");
    used.add("A");
    expect(dedupeName("A", used)).toBe("A (2)");
    used.add("A (2)");
    expect(dedupeName("A", used)).toBe("A (3)");
    expect(dedupeName("B", used)).toBe("B");
  });

  it("原名已带 (2) 形态仍按独立名处理（简单后缀策略）", () => {
    const used = new Set(["A (2)"]);
    expect(dedupeName("A (2)", used)).toBe("A (2) (2)");
  });
});
