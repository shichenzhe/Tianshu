// 图 AI 上下文构建与回复解析单测
import { describe, expect, it } from "vitest";
import {
  buildGraphAiInstruction,
  buildGraphContextPrefix,
  extractGraphEdit,
} from "@/domains/ai/orchestration/lib/graph-ai-context";
import {
  emptyGraph,
  serializeGraph,
  newCodeNode,
} from "@/domains/ai/orchestration/lib/graph-editor-model";

// 仿 i18next 插值的最小 t：返回 key + opts JSON（断言内容在 opts 中）
const stubT = (key: string, opts?: Record<string, unknown>): string =>
  key + "\n" + JSON.stringify(opts ?? {});

const MODELS = [
  { id: 1, name: "GPT-4o" },
  { id: 2, name: "Claude 4.5" },
];

const validNode = { ...newCodeNode("code-1"), name: "代码", script: "echo hi" };

// emptyGraph 的 node-1 是占位节点（name/modelId/prompt 空），不满足
// graphJsonSchema——补齐为合法全量图
function validGraph() {
  const g = emptyGraph();
  return {
    ...g,
    nodes: g.nodes.map((n) =>
      n.id === "node-1"
        ? { ...n, name: "首节点", modelId: 1, prompt: "你好" }
        : n,
    ),
  };
}

const opsBlock = "```json\n" +
  JSON.stringify({ ops: [{ op: "addNode", node: validNode }] }) +
  "\n```";

describe("extractGraphEdit", () => {
  it("解析变更单块为 ops 形态", () => {
    const r = extractGraphEdit(`好的，已加节点。\n${opsBlock}`);
    expect(r?.kind).toBe("ops");
    if (r?.kind === "ops") expect(r.changeSet.ops).toHaveLength(1);
  });

  it("解析全量图块为 full 形态", () => {
    const block = "```json\n" + serializeGraph(validGraph()) + "\n```";
    const r = extractGraphEdit(block);
    expect(r?.kind).toBe("full");
    if (r?.kind === "full") expect(r.json.nodes.length).toBeGreaterThan(0);
  });

  it("同时存在时优先变更单", () => {
    const fullBlock = "```json\n" + serializeGraph(validGraph()) + "\n```";
    const r = extractGraphEdit(`${opsBlock}\n${fullBlock}`);
    expect(r?.kind).toBe("ops");
  });

  it("跳过非法块取后续合法块", () => {
    const bad = "```json\n{not json}\n```";
    const fullBlock = "```json\n" + serializeGraph(validGraph()) + "\n```";
    const r = extractGraphEdit(`${bad}\n${fullBlock}`);
    expect(r?.kind).toBe("full");
  });

  it("无可解析块返回 null", () => {
    expect(extractGraphEdit("普通回答")).toBeNull();
    expect(extractGraphEdit("```text\n{}\n```")).toBeNull();
  });
});

describe("buildGraphAiInstruction", () => {
  it("包含全部模型目录条目（#id name 形态）", () => {
    const text = buildGraphAiInstruction(stubT, MODELS);
    expect(text).toContain("#1 GPT-4o");
    expect(text).toContain("#2 Claude 4.5");
  });

  it("包含指令模板与 modelId 约束文案", () => {
    const text = buildGraphAiInstruction(stubT, MODELS);
    expect(text).toContain("ai.instruction");
  });
});

describe("buildGraphContextPrefix", () => {
  it("全量注入含图名/描述/图 JSON/选中节点/模型目录", () => {
    const graph = emptyGraph();
    const raw = buildGraphContextPrefix(stubT, {
      graphName: "每日简报",
      description: "抓取并发送",
      graphJson: serializeGraph(graph),
      models: MODELS,
      selectedNodeIds: ["node-1"],
    });
    // stub 输出 key + opts JSON，解析 opts 逐项断言
    const opts = JSON.parse(raw.slice(raw.indexOf("\n") + 1));
    expect(opts.name).toBe("每日简报");
    expect(opts.description).toBe("抓取并发送");
    expect(opts.graph).toBe(serializeGraph(graph));
    expect(opts.selected).toBe("node-1");
    expect(opts.models).toContain("#1 GPT-4o");
    expect(opts.models).toContain("#2 Claude 4.5");
  });

  it("图 JSON 超 60k 降级为结构摘要不含完整 JSON", () => {
    const huge = JSON.stringify({
      ...emptyGraph(),
      nodes: emptyGraph().nodes.map((n) => ({
        ...n,
        script: "x".repeat(70_000),
      })),
    });
    expect(huge.length).toBeGreaterThan(60_000);
    const raw = buildGraphContextPrefix(stubT, {
      graphName: "大图",
      graphJson: huge,
      models: MODELS,
    });
    const opts = JSON.parse(raw.slice(raw.indexOf("\n") + 1));
    expect(raw).not.toContain("x".repeat(70_000));
    expect(raw).toContain("ai.prefixSummary");
    // 摘要含节点 id 行
    expect(opts.summary).toContain("start");
    expect(opts.summary).toContain("node-1");
    expect(opts.summary).toContain("start -> node-1");
    expect(opts.nodeCount).toBe(2);
    expect(opts.edgeCount).toBe(1);
    // 未选中时回退文案
    expect(opts.selected).toContain("ai.prefixSelectedNodes");
  });
});
