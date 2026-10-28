// tests/ai/graph-editor-model.test.ts
/**
 * 图编辑器双模式纯函数测试（Task 13）：parseOrKeep（合法/非法 JSON/空串/
 * 非图形状）、serialize↔parse 往返一致、canonicalJson 规范化、validateRaw
 * 双模式校验出口、renameNode 边引用同步与非法拒绝、removeNode 级联删边、
 * nextNodeId 避让、newEdge 默认、draftChanged 基线比对、templateGraph 预填。
 */
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  dedupeUniqueEntry,
  draftChanged,
  emptyGraph,
  FACTORY,
  localizeGraphIssue,
  newCodeNode,
  newEdge,
  newImageGenNode,
  newNode,
  nextNodeId,
  patchStartVariables,
  readTemplatePrefill,
  suggestHttpBodyType,
  switchNodeKind,
  parseOrKeep,
  removeNode,
  renameNode,
  serializeGraph,
  templateGraph,
  timeoutSecToMs,
  validateRaw,
  type DraftSnapshot,
  type EditorMode,
} from "@/domains/ai/orchestration/lib/graph-editor-model";
import { validateGraph } from "@/domains/ai/orchestration/api/graph.schema";
import type {
  GraphJson,
  GraphNode,
} from "@/domains/ai/orchestration/api/graph.schema";

const validJson: GraphJson = {
  version: 1,
  inputSchema: { topic: "string" },
  nodes: [
    {
      id: "collect",
      name: "收集",
      kind: "llm",
      modelId: 3,
      prompt: "收集 {{input.topic}}",
      tools: false,
      outputMode: "text",
      // 异常处理默认与 schema 同口径（draftChanged 比对串，缺字段会被
      // zod default 补齐导致往返不一致）
      timeoutMs: 180_000,
      retries: 0,
      onError: "abort",
    },
    {
      id: "report",
      name: "成文",
      kind: "llm",
      modelId: 3,
      prompt: "基于 {{nodes.collect.output}} 成文",
      tools: false,
      outputMode: "text",
      timeoutMs: 180_000,
      retries: 0,
      onError: "abort",
    },
  ],
  edges: [
    { from: "collect", to: "report" },
    { from: "report", to: "END" },
  ],
};

describe("EditorMode（编辑模式取值）", () => {
  it("画布 ⇄ JSON 源码双模式（画布为默认主模式）", () => {
    // 画布改造（Task 3）：结构化模式退役，取值收窄 canvas/json
    const modes: EditorMode[] = ["canvas", "json"];
    expect(modes).toEqual(["canvas", "json"]);
  });
});

describe("parseOrKeep（JSON 容错解析）", () => {
  it("合法 GraphJson 串 → parsed 非空", () => {
    const { parsed } = parseOrKeep(JSON.stringify(validJson));
    expect(parsed?.nodes).toHaveLength(2);
  });

  it("非法 JSON（花括号残缺）→ parsed null", () => {
    expect(parseOrKeep("{not json").parsed).toBeNull();
  });

  it("空串/纯空白 → parsed null", () => {
    expect(parseOrKeep("").parsed).toBeNull();
    expect(parseOrKeep("   ").parsed).toBeNull();
  });

  it("合法 JSON 但非图形状（version 2 / 缺 nodes）→ parsed null", () => {
    expect(parseOrKeep('{"version":2,"nodes":[]}').parsed).toBeNull();
    expect(parseOrKeep('{"version":1}').parsed).toBeNull();
  });

  it("zod 默认值补全：缺 tools/outputMode 的节点解析后带默认", () => {
    const raw = JSON.stringify({
      version: 1,
      nodes: [{ id: "solo", name: "N", kind: "llm", modelId: 1, prompt: "p" }],
      edges: [],
    });
    const node = parseOrKeep(raw).parsed?.nodes[0];
    expect(node?.tools).toBe(false);
    expect(node?.outputMode).toBe("text");
  });
});

describe("序列化与规范化", () => {
  it("往返一致：serialize→parse→serialize 稳定", () => {
    const once = serializeGraph(parseOrKeep(JSON.stringify(validJson)).parsed!);
    const twice = serializeGraph(parseOrKeep(once).parsed!);
    expect(twice).toBe(once);
  });

  it("canonicalJson 把紧凑串规范为与 serializeGraph 相同形态", () => {
    const compact = JSON.stringify(validJson);
    expect(canonicalJson(compact)).toBe(
      serializeGraph(parseOrKeep(compact).parsed!),
    );
  });

  it("canonicalJson 解析失败原样返回（保守视为有变更）", () => {
    expect(canonicalJson("not-json")).toBe("not-json");
  });
});

describe("validateRaw（JSON 模式共用校验出口）", () => {
  it("语法失败 → ok:false 且 issues 空（调用方补解析失败文案）", () => {
    expect(validateRaw("{")).toEqual({ ok: false, issues: [] });
  });

  it("结构非法（重复节点 id）→ ok:false 且给出错误码 issues", () => {
    const result = validateRaw(
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "a", name: "A", kind: "llm", modelId: 1, prompt: "p" },
          { id: "a", name: "A2", kind: "llm", modelId: 1, prompt: "p" },
        ],
        edges: [],
      }),
    );
    expect(result.ok).toBe(false);
    expect(
      result.issues.some((issue) => issue.code === "duplicateNodeId"),
    ).toBe(true);
  });

  it("合法 → ok:true", () => {
    expect(validateRaw(JSON.stringify(validJson))).toEqual({
      ok: true,
      issues: [],
    });
  });
});

describe("localizeGraphIssue（校验问题本地化）", () => {
  /** 恒等 t：键与参数原样回显，便于断言透传 */
  const identityT = (key: string, params?: Record<string, unknown>) =>
    params ? `${key}|${JSON.stringify(params)}` : key;

  it("code → validation.<code> 键并透传插值参数", () => {
    expect(
      localizeGraphIssue(
        { code: "uniqueEntry", params: { count: 2 } },
        identityT,
      ),
    ).toBe('chat:orchestration.validation.uniqueEntry|{"count":2}');
  });

  it("无参数 issue 不带插值段", () => {
    expect(localizeGraphIssue({ code: "duplicateNodeId" }, identityT)).toBe(
      "chat:orchestration.validation.duplicateNodeId",
    );
  });
});

describe("节点结构化编辑", () => {
  it("renameNode 同步改边引用", () => {
    const renamed = renameNode(validJson, "collect", "gather");
    expect(renamed.nodes.map((n) => n.id)).toEqual(["gather", "report"]);
    expect(renamed.edges[0]).toEqual({ from: "gather", to: "report" });
    expect(renamed.edges[1].to).toBe("END");
  });

  it("renameNode 非法 id（大写/下划线/重复）原样返回", () => {
    expect(renameNode(validJson, "collect", "Bad_Id")).toBe(validJson);
    expect(renameNode(validJson, "collect", "report")).toBe(validJson);
  });

  it("removeNode 级联删除其出/入边", () => {
    const removed = removeNode(validJson, "collect");
    expect(removed.nodes.map((n) => n.id)).toEqual(["report"]);
    expect(removed.edges).toEqual([{ from: "report", to: "END" }]);
  });

  it("nextNodeId 取最大序号 +1，避开自定义 id 场景从 1 起", () => {
    const nodes = [
      { id: "node-1" },
      { id: "node-3" },
      { id: "custom" },
    ] as GraphNode[];
    expect(nextNodeId(nodes)).toBe("node-4");
    expect(nextNodeId([{ id: "custom" }] as GraphNode[])).toBe("node-1");
  });

  it("newNode 默认 modelId 0 占位（保存被校验拦截，引导先选模型）", () => {
    const node = newNode("node-9");
    expect(node.modelId).toBe(0);
    expect(node.tools).toBe(false);
    expect(node.outputMode).toBe("text");
  });

  it("emptyGraph 默认带 start 节点并连线到首个 llm（骨架不可通过校验，llm 待填）", () => {
    const graph = emptyGraph();
    expect(graph.nodes[0].kind).toBe("start");
    expect(graph.nodes[0].id).toBe("start");
    expect(graph.edges).toEqual([{ from: "start", to: "node-1" }]);
    expect(validateGraph(graph).ok).toBe(false);
  });

  it("FACTORY.start 生成空变量开始节点", () => {
    expect(FACTORY.start("s1")).toEqual({
      id: "s1",
      name: "开始",
      kind: "start",
      variables: [],
    });
  });

  it("newEdge 默认首节点 → END", () => {
    expect(newEdge(validJson)).toEqual({ from: "collect", to: "END" });
  });

  it("suggestHttpBodyType：带体方法且未选类型时建议 json，其余保持原值", () => {
    // POST/PUT/PATCH + bodyType=none → json（请求体输入区随方法出现）
    expect(suggestHttpBodyType("POST", "none")).toBe("json");
    expect(suggestHttpBodyType("PUT", "none")).toBe("json");
    expect(suggestHttpBodyType("PATCH", "none")).toBe("json");
    // GET/DELETE 不建议（无体常见）；已显式选过类型不覆盖
    expect(suggestHttpBodyType("GET", "none")).toBe("none");
    expect(suggestHttpBodyType("DELETE", "none")).toBe("none");
    expect(suggestHttpBodyType("GET", "json")).toBe("json");
    expect(suggestHttpBodyType("POST", "binary")).toBe("binary");
  });
});

describe("draftChanged（保存可用性）", () => {
  const base: DraftSnapshot = {
    name: "日报",
    description: "每日",
    graphJson: serializeGraph(validJson),
  };

  it("完全一致 → false", () => {
    expect(
      draftChanged(
        { ...base, graphJson: canonicalJson(serializeGraph(validJson)) },
        base,
      ),
    ).toBe(false);
  });

  it("仅格式不同的 graphJson（紧凑 vs 规范）→ false", () => {
    expect(
      draftChanged(
        { ...base, graphJson: canonicalJson(JSON.stringify(validJson)) },
        base,
      ),
    ).toBe(false);
  });

  it("名称/描述/图任一变化 → true；描述空白差异忽略", () => {
    expect(draftChanged({ ...base, name: "周报" }, base)).toBe(true);
    expect(draftChanged({ ...base, graphJson: "{}" }, base)).toBe(true);
    expect(draftChanged({ ...base, description: "  每日  " }, base)).toBe(
      false,
    );
  });
});

describe("templateGraph（模板预填）", () => {
  it("合法模板对象直通", () => {
    const template = templateGraph(validJson as unknown as object);
    expect(template.nodes).toHaveLength(2);
  });

  it("非法模板兜底空图骨架（防御，理论不达）", () => {
    const template = templateGraph({ version: 9 });
    expect(template.nodes).toHaveLength(2); // start + node-1（emptyGraph 骨架）
  });

  it("llm 模板 modelId 0 占位装载不回退空图，且 0 还原保留", () => {
    const template = templateGraph({
      version: 1,
      inputSchema: {},
      nodes: [{ id: "a", name: "A", kind: "llm", modelId: 0, prompt: "p" }],
      edges: [],
    });
    // 修复前：modelId 0 过不了 positive 校验 → 整图回退 emptyGraph 骨架
    expect(template.nodes).toHaveLength(1);
    expect(template.nodes[0]).toMatchObject({ id: "a", modelId: 0 });
  });

  it("modelId 0 还原不影响真实模型 id 节点", () => {
    const template = templateGraph({
      version: 1,
      inputSchema: {},
      nodes: [
        { id: "a", name: "A", kind: "llm", modelId: 7, prompt: "p" },
        { id: "b", name: "B", kind: "llm", modelId: 0, prompt: "p" },
      ],
      edges: [],
    });
    expect(
      template.nodes.map((n) => (n.kind === "llm" ? n.modelId : -1)),
    ).toEqual([7, 0]);
  });
});

describe("代码节点编辑模型", () => {
  it("newCodeNode 默认 bash/空脚本/30s 超时", () => {
    expect(newCodeNode("run")).toMatchObject({
      id: "run",
      kind: "code",
      language: "bash",
      script: "",
      timeoutMs: 30000,
    });
  });
  it("switchNodeKind llm→code：丢 llm 字段保留 id/name，边引用不动", () => {
    const graph = {
      version: 1 as const,
      inputSchema: {},
      nodes: [
        {
          id: "a",
          name: "甲",
          kind: "llm" as const,
          modelId: 3,
          prompt: "p",
          tools: false,
          outputMode: "text" as const,
        },
        {
          id: "b",
          name: "乙",
          kind: "code" as const,
          language: "nodejs" as const,
          script: "s",
          timeoutMs: 30000,
        },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "END" },
      ],
    };
    const next = switchNodeKind(graph, "a", "code");
    expect(next.nodes[0]).toMatchObject({ id: "a", name: "甲", kind: "code" });
    expect(next.nodes[0]).not.toHaveProperty("modelId");
    expect(next.edges).toEqual(graph.edges);
  });
  it("switchNodeKind code→llm：重建 llm 默认字段；同 kind 原样返回", () => {
    const graph = {
      version: 1 as const,
      inputSchema: {},
      nodes: [
        {
          id: "b",
          name: "乙",
          kind: "code" as const,
          language: "bash" as const,
          script: "echo",
          timeoutMs: 30000,
        },
      ],
      edges: [{ from: "b", to: "END" }],
    };
    const next = switchNodeKind(graph, "b", "llm");
    expect(next.nodes[0]).toMatchObject({
      id: "b",
      name: "乙",
      kind: "llm",
      modelId: 0,
      prompt: "",
    });
    expect(switchNodeKind(graph, "b", "code")).toBe(graph);
  });

  it("分支配置跨 kind 切换保留（llm/code 均支持 branch 路由）", () => {
    const graph = {
      version: 1 as const,
      inputSchema: {},
      nodes: [
        {
          id: "r",
          name: "路由",
          kind: "code" as const,
          language: "bash" as const,
          script: "echo go",
          timeoutMs: 30000,
          outputMode: "branch" as const,
          branchOptions: ["go", "stop"],
        },
      ],
      edges: [],
    };
    const asLlm = switchNodeKind(graph, "r", "llm");
    expect(asLlm.nodes[0]).toMatchObject({
      kind: "llm",
      outputMode: "branch",
      branchOptions: ["go", "stop"],
    });
    const backToCode = switchNodeKind(asLlm, "r", "code");
    expect(backToCode.nodes[0]).toMatchObject({
      kind: "code",
      outputMode: "branch",
      branchOptions: ["go", "stop"],
    });
  });
});

describe("readTemplatePrefill（StrictMode 双挂载快照兜底）", () => {
  const tpl = {
    slug: "tpl",
    icon: "workflow",
    titleI18nKey: "tpl.title",
    descI18nKey: "tpl.desc",
    graphJson: {
      version: 1,
      inputSchema: {},
      nodes: [{ id: "a", name: "a", kind: "llm", modelId: 1, prompt: "p" }],
      edges: [],
    },
  };

  function makeStorage() {
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
      map,
    };
  }

  it("路由 state 命中：返回模板并写快照", () => {
    const storage = makeStorage();
    expect(readTemplatePrefill({ graphTemplate: tpl }, storage)).toEqual(tpl);
    expect(storage.map.size).toBe(1);
  });

  it("state 空时快照兜底：返回模板且快照命中即删（仅一次有效）", () => {
    const storage = makeStorage();
    readTemplatePrefill({ graphTemplate: tpl }, storage);
    expect(readTemplatePrefill(null, storage)).toEqual(tpl);
    expect(storage.map.size).toBe(0);
    expect(readTemplatePrefill(null, storage)).toBeUndefined();
  });

  it("快照损坏/非模板形态不炸：undefined", () => {
    const storage = makeStorage();
    storage.setItem("tianshu:graph-template-prefill", "not json");
    expect(readTemplatePrefill(null, storage)).toBeUndefined();
    storage.setItem("tianshu:graph-template-prefill", '{"graphJson": 1}');
    expect(readTemplatePrefill(null, storage)).toBeUndefined();
  });

  it("state 非 graphTemplate 形态不写快照", () => {
    const storage = makeStorage();
    readTemplatePrefill({ other: 1 }, storage);
    expect(storage.map.size).toBe(0);
  });
});

describe("timeoutSecToMs", () => {
  it("空串回退默认；合法秒转毫秒；非法回退默认", () => {
    expect(timeoutSecToMs("", 120_000)).toBe(120_000);
    expect(timeoutSecToMs("30", 120_000)).toBe(30_000);
    expect(timeoutSecToMs("abc", 120_000)).toBe(120_000);
    expect(timeoutSecToMs("-5", 120_000)).toBe(120_000);
  });
  it("小数秒四舍五入到毫秒；带空白容错", () => {
    expect(timeoutSecToMs("1.5", 0)).toBe(1_500);
    expect(timeoutSecToMs("  8 ", 0)).toBe(8_000);
  });
});

describe("patchStartVariables（start 变量编辑回写）", () => {
  it("节点 variables 与 inputSchema 同步写（单一提交）", () => {
    const g = emptyGraph();
    const next = patchStartVariables(g, ["topic", "lang"]);
    expect(next.nodes[0].variables).toEqual(["topic", "lang"]);
    expect(next.inputSchema).toEqual({ topic: "string", lang: "string" });
  });

  it("清空变量 → inputSchema 置空", () => {
    const g = patchStartVariables(emptyGraph(), ["a"]);
    const next = patchStartVariables(g, []);
    expect(next.inputSchema).toEqual({});
  });

  it("重复变量兜底去重（节点与 inputSchema 键一致）", () => {
    const next = patchStartVariables(emptyGraph(), ["a", "a", "b"]);
    expect(next.nodes[0].variables).toEqual(["a", "b"]);
    expect(Object.keys(next.inputSchema)).toEqual(["a", "b"]);
  });
});

describe("dedupeUniqueEntry（校验清单去噪）", () => {
  it(">1 start 的 uniqueEntry/duplicateStartNode 双报去重：保留后者", () => {
    const deduped = dedupeUniqueEntry([
      { code: "uniqueEntry", params: { count: 2 } },
      { code: "duplicateStartNode", params: { nodeId: "start-2" } },
    ]);
    expect(deduped.map((issue) => issue.code)).toEqual(["duplicateStartNode"]);
  });

  it("无 duplicateStartNode 时原样透传（uniqueEntry 仍须报）", () => {
    const issues = [
      { code: "uniqueEntry", params: { count: 0 } },
      { code: "danglingEdge" },
    ];
    expect(dedupeUniqueEntry(issues)).toEqual(issues);
  });
});

describe("branchOptionsOf（条件边源选项统一出口）", () => {
  it("condition：分支名 + 兜底；intent：意图名 + 兜底", async () => {
    const { branchOptionsOf } =
      await import("@/domains/ai/orchestration/api/graph.schema");
    expect(
      branchOptionsOf({
        id: "c1",
        name: "条件",
        kind: "condition",
        branches: [
          { name: "go", conditions: [] },
          { name: "stop", conditions: [] },
        ],
        fallback: "else",
      }),
    ).toEqual(["go", "stop", "else"]);
    expect(
      branchOptionsOf({
        id: "i1",
        name: "意图",
        kind: "intent",
        modelId: 1,
        querySource: "{{input.q}}",
        intents: [
          { name: "问天气", description: "" },
          { name: "闲聊", description: "" },
        ],
        fallback: "其它",
      }),
    ).toEqual(["问天气", "闲聊", "其它"]);
  });

  it("llm/code 仅 branch 模式有选项；text 模式与其余节点为 null", async () => {
    const { branchOptionsOf } =
      await import("@/domains/ai/orchestration/api/graph.schema");
    expect(
      branchOptionsOf({
        id: "b1",
        name: "分支",
        kind: "llm",
        modelId: 1,
        prompt: "p",
        outputMode: "branch",
        branchOptions: ["a", "b"],
      }),
    ).toEqual(["a", "b"]);
    expect(
      branchOptionsOf({
        id: "t1",
        name: "文本",
        kind: "llm",
        modelId: 1,
        prompt: "p",
        outputMode: "text",
      }),
    ).toBeNull();
    expect(
      branchOptionsOf({
        id: "d1",
        name: "延时",
        kind: "delay",
        seconds: 5,
      }),
    ).toBeNull();
  });
});

describe("newImageGenNode", () => {
  it("默认 openai 协议 + 显式默认值（与 schema 同口径）", () => {
    const node = newImageGenNode("gen");
    expect(node.protocol).toBe("openai");
    expect(node.modelId).toBe(0);
    expect(node.randomizeSeed).toBe(true);
    expect(node.timeoutMs).toBe(300_000);
    expect(node.size).toBe("1024x1024");
  });
});
