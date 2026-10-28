// tests/ai/graph-templates.test.ts
/**
 * 内置图模板守护：模板 graphJson 结构必须合法。llm 模板的 modelId 是
 * 0 占位（预填后引导用户选模型，保存期校验拦截是设计内），故先换成 1
 * 再校验——排除占位后仍不合法的模板在此拦截（坏模板经 templateGraph
 * 防御性兜底会静默变空图）。code-pipeline 另断言三语言流水线结构；
 * 另有节点清单对账（schema 联合 ⇄ workflow-creator 技能速查表）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listGraphTemplates } from "../../electron/domains/ai/orchestration/graph-templates";
import {
  graphNodeSchema,
  validateGraph,
} from "../../src-react/domains/ai/orchestration/api/graph.schema";
import { templateGraph } from "../../src-react/domains/ai/orchestration/lib/graph-editor-model";

/** 模板 JSON 的 modelId 占位 0 → 1、iterate 子图占位 graphId 0 → 7（结构
 * 校验用；两个占位都是保存期校验引导用户选真实值的设计内行为） */
function withModelSelected(json: object): object {
  return JSON.parse(
    JSON.stringify(json, (_key, value) =>
      typeof value === "number" && value === 0
        ? _key === "modelId"
          ? 1
          : _key === "graphId"
            ? 7
            : value
        : value,
    ),
  );
}

describe("内置图模板", () => {
  it("全部模板结构合法（llm 模板 modelId 占位换 1 后校验）", () => {
    const templates = listGraphTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(3);
    for (const template of templates) {
      const result = validateGraph(withModelSelected(template.graphJson));
      expect(
        result.ok,
        `${template.slug} 应合法: ${
          result.ok ? "" : JSON.stringify(result.issues)
        }`,
      ).toBe(true);
    }
  });

  it("全部模板经 templateGraph 装载不回退空图（真实预填链路）", () => {
    for (const template of listGraphTemplates()) {
      const loaded = templateGraph(template.graphJson);
      expect(
        loaded.nodes.length,
        `${template.slug} 装载后不应是 emptyGraph 单节点骨架`,
      ).toBeGreaterThan(1);
      // 预填内容非空：llm 节点有 prompt、code 节点有 script、condition/intent 有清单
      for (const node of loaded.nodes) {
        if (node.kind === "start") {
          // start 是参数载体：预填仅为 variables 数组（结构对账见下节用例）
          continue;
        }
        if (node.kind === "llm") {
          expect(
            node.prompt.length,
            `${template.slug}/${node.id} prompt 空`,
          ).toBeGreaterThan(0);
        } else if (node.kind === "condition") {
          expect(
            node.branches.length,
            `${template.slug}/${node.id} branches 空`,
          ).toBeGreaterThan(0);
        } else if (node.kind === "intent") {
          expect(
            node.intents.length,
            `${template.slug}/${node.id} intents 空`,
          ).toBeGreaterThan(0);
        } else if (node.kind === "iterate") {
          expect(
            node.loopMode,
            `${template.slug}/${node.id} loopMode 空`,
          ).toBeTruthy();
        } else if (node.kind === "database") {
          expect(
            node.sql.length,
            `${template.slug}/${node.id} sql 空`,
          ).toBeGreaterThan(0);
        } else if (node.kind === "csvRead") {
          expect(
            node.path.length,
            `${template.slug}/${node.id} path 空`,
          ).toBeGreaterThan(0);
        } else if (node.kind === "csvWrite") {
          expect(
            node.rowsSource.length,
            `${template.slug}/${node.id} rowsSource 空`,
          ).toBeGreaterThan(0);
        } else if (node.kind === "variable") {
          expect(
            node.assignments.length,
            `${template.slug}/${node.id} assignments 空`,
          ).toBeGreaterThan(0);
        } else if (node.kind === "aggregate") {
          expect(
            node.ops.length,
            `${template.slug}/${node.id} ops 空`,
          ).toBeGreaterThan(0);
        } else if (node.kind === "email") {
          expect(
            node.host.length,
            `${template.slug}/${node.id} host 空`,
          ).toBeGreaterThan(0);
        } else {
          expect(
            node.script.length,
            `${template.slug}/${node.id} script 空`,
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  it("daily-brief-branch：分支走 condition 节点（非 llm branch 模式），分支名与条件边 label 对应", () => {
    const template = listGraphTemplates().find(
      (item) => item.slug === "daily-brief-branch",
    );
    expect(template).toBeTruthy();
    const graph = validateGraph(withModelSelected(template!.graphJson));
    expect(graph.ok).toBe(true);
    if (!graph.ok) {
      return;
    }
    const nodes = graph.value.nodes as Array<Record<string, unknown>>;
    const judge = nodes.find((node) => node.id === "judge");
    expect(judge?.kind).toBe("condition");
    expect(judge?.fallback).toBe("skip");
    const branches = judge?.branches as Array<{
      name: string;
      conditions: Array<{ operator: string }>;
    }>;
    expect(branches.map((branch) => branch.name)).toEqual(["brief"]);
    expect(branches[0].conditions[0].operator).toBe("contains");
    // 无 llm 节点再使用 outputMode:branch（旧模式遗留在此拦截）
    for (const node of nodes) {
      if (node.kind === "llm") {
        expect(node.outputMode).not.toBe("branch");
      }
    }
  });

  it("intent-router：语义路由走 intent 节点，意图名/兜底与条件边 label 对应", () => {
    const template = listGraphTemplates().find(
      (item) => item.slug === "intent-router",
    );
    expect(template).toBeTruthy();
    const graph = validateGraph(withModelSelected(template!.graphJson));
    expect(graph.ok).toBe(true);
    if (!graph.ok) {
      return;
    }
    const nodes = graph.value.nodes as Array<Record<string, unknown>>;
    const classify = nodes.find((node) => node.id === "classify");
    expect(classify?.kind).toBe("intent");
    const intents = classify?.intents as Array<{ name: string }>;
    expect(intents.map((intent) => intent.name)).toEqual(["pre", "after"]);
    expect(classify?.fallback).toBe("other");
    // 三路条件边（两意图 + 兜底）齐备
    const edges = graph.value.edges as Array<{
      condition?: { value: string };
    }>;
    expect(
      edges
        .filter((edge) => edge.condition)
        .map((edge) => edge.condition!.value)
        .sort(),
    ).toEqual(["after", "other", "pre"]);
  });

  it("code-pipeline：纯 code 节点原样合法；start→bash→python→node 串行链 + word 输入变量", () => {
    const template = listGraphTemplates().find(
      (item) => item.slug === "code-pipeline",
    );
    expect(template).toBeTruthy();
    expect(validateGraph(template!.graphJson).ok).toBe(true);
    const graph = template!.graphJson as {
      inputSchema: Record<string, string>;
      nodes: Array<{ id: string; language?: string }>;
      edges: Array<{ from: string; to: string }>;
    };
    expect(graph.inputSchema).toEqual({ word: "string" });
    expect(graph.nodes.map((node) => node.id)).toEqual([
      "start",
      "step1-bash",
      "step2-python",
      "step3-node",
    ]);
    expect(graph.nodes.map((node) => node.language)).toEqual([
      undefined,
      "bash",
      "python",
      "nodejs",
    ]);
    expect(graph.edges).toEqual([
      { from: "start", to: "step1-bash" },
      { from: "step1-bash", to: "step2-python" },
      { from: "step2-python", to: "step3-node" },
      { from: "step3-node", to: "END" },
    ]);
  });

  it("全部模板恰一个 start 且 variables 与 inputSchema 键一致（start 直连原入口）", () => {
    for (const template of listGraphTemplates()) {
      const graph = template.graphJson as {
        inputSchema: Record<string, string>;
        nodes: Array<{ id: string; kind: string; variables?: string[] }>;
        edges: Array<{ from: string; to: string }>;
      };
      const starts = graph.nodes.filter((n) => n.kind === "start");
      expect(starts.length, template.slug).toBe(1);
      expect(Object.keys(graph.inputSchema).sort(), template.slug).toEqual(
        [...(starts[0].variables ?? [])].sort(),
      );
      // start 无入边且直连原入口：其余节点入边集与改造前一致（唯一入口=start）
      const startIncoming = graph.edges.filter((e) => e.to === "start");
      expect(startIncoming, template.slug).toEqual([]);
      const startOutgoing = graph.edges.filter((e) => e.from === "start");
      expect(startOutgoing, template.slug).toHaveLength(1);
    }
  });
});

describe("节点清单对账（schema ⇄ workflow-creator 技能）", () => {
  it("graphNodeSchema 联合的 kind 全集 = SKILL.md 速查表提及的 kind 全集", () => {
    // union 各支的 kind（zod literal；llm 支带 default 补 "llm"；http 支
    // 被 z.preprocess 包裹（bodyType 推断）无 shape，先经 out/innerType 解包）
    const schemaKinds = new Set(
      graphNodeSchema.options.map((member) => {
        let schema = member as unknown as {
          shape?: Record<string, unknown>;
          out?: unknown;
          innerType?: unknown;
        };
        while (!schema.shape && (schema.out ?? schema.innerType)) {
          schema = (schema.out ?? schema.innerType) as typeof schema;
        }
        const kind = (
          schema.shape as {
            kind: {
              _def: { defaultValue?: () => string; value?: string };
            };
          }
        ).kind;
        // zod4 def：ZodLiteral 值在 def.values 数组；llm 支 ZodDefault 包裹
        const raw = kind as unknown as {
          def?: { defaultValue?: unknown | (() => string); values?: string[] };
          _def?: { defaultValue?: unknown | (() => string); values?: string[] };
        };
        const def = raw.def ?? raw._def ?? {};
        if (typeof def.defaultValue === "function") {
          return def.defaultValue();
        }
        if (def.defaultValue !== undefined) {
          return def.defaultValue as string;
        }
        return def.values?.[0];
      }),
    );
    // SKILL.md「节点速查」节内行形如 "- `llm`：调大模型…"（限节提取，
    // 防结构说明段的 `inputSchema` 等混入）
    const skillMd = readFileSync(
      path.resolve(
        __dirname,
        "../../electron/resources/builtin-skills/workflow-creator/SKILL.md",
      ),
      "utf8",
    );
    const quickRef = skillMd.slice(
      skillMd.indexOf("## 节点速查"),
      skillMd.indexOf("##", skillMd.indexOf("## 节点速查") + 3),
    );
    const skillKinds = new Set(
      [...quickRef.matchAll(/^- `([a-z][a-zA-Z]+)`/gm)].map((m) => m[1]),
    );

    expect(schemaKinds.size).toBeGreaterThan(20);
    expect([...skillKinds].sort()).toEqual([...schemaKinds].sort());
    // 标题「节点速查（N 种）」计数与两侧集合一致——新增节点后忘改
    // 标题数字在此拦截（标题缺失时 match 为 null，Number(undefined)=NaN 同样失败）
    const headerCount = skillMd.match(/## 节点速查（(\d+) 种）/);
    expect(Number(headerCount?.[1])).toBe(schemaKinds.size);
  });
});
