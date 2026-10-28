import { describe, expect, it } from "vitest";
import {
  validateGraph,
  graphJsonSchema,
  ensureStartNode,
  ensureEndEdges,
  normalizeGraph,
  imageGenNodeSchema,
  isComfyUIImageGen,
} from "../../src-react/domains/ai/orchestration/api/graph.schema";

const llmNode = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  kind: "llm",
  modelId: 1,
  prompt: "p",
  outputMode: "text",
  ...extra,
});
const base = (nodes: object[], edges: object[]) => ({
  version: 1,
  inputSchema: {},
  nodes,
  edges,
});
const iterateNode = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  kind: "iterate",
  itemsSource: "a\nb",
  graphId: 7,
  itemVariable: "item",
  maxItems: 100,
  ...extra,
});
const intentNode = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  kind: "intent",
  modelId: 1,
  querySource: "{{input.q}}",
  intents: [{ name: "a", description: "A 类" }],
  ...extra,
});
const vectorizeNode = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  kind: "vectorize",
  collection: "c",
  sourceName: "s",
  text: "t",
  modelId: 2,
  ...extra,
});
const vectorSearchNode = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  kind: "vectorSearch",
  collection: "",
  searchQuery: "q",
  modelId: 2,
  topK: 5,
  ...extra,
});

describe("graphJsonSchema", () => {
  it("合法最小图通过", () => {
    expect(
      graphJsonSchema.parse(base([llmNode("a")], [{ from: "a", to: "END" }])),
    ).toBeTruthy();
  });
  it("非 llm kind 拒绝（v1 仅 llm）", () => {
    expect(() =>
      graphJsonSchema.parse(base([llmNode("a", { kind: "tool" })], [])),
    ).toThrow();
  });
});

describe("validateGraph 跨节点校验（结构化错误码）", () => {
  it("重 id 报 duplicateNodeId", () => {
    const r = validateGraph(base([llmNode("a"), llmNode("a")], []));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toContainEqual({ code: "duplicateNodeId" });
    }
  });
  it("多入口报 uniqueEntry 并带无入边节点数", () => {
    const r = validateGraph(base([llmNode("a"), llmNode("b")], []));
    expect(r).toEqual({
      ok: false,
      issues: [{ code: "uniqueEntry", params: { count: 2 } }],
    });
  });
  it("悬空边报 danglingEdge（side=to + 缺失节点 id）", () => {
    const r = validateGraph(base([llmNode("a")], [{ from: "a", to: "ghost" }]));
    expect(r).toEqual({
      ok: false,
      issues: [
        { code: "danglingEdge", params: { side: "to", nodeId: "ghost" } },
      ],
    });
  });
  it("from 悬空同样报 danglingEdge（side=from）", () => {
    const r = validateGraph(
      base(
        [llmNode("a")],
        [
          { from: "a", to: "END" },
          { from: "ghost", to: "a" },
        ],
      ),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toContainEqual({
        code: "danglingEdge",
        params: { side: "from", nodeId: "ghost" },
      });
    }
  });
  it("branch 节点条件边取值超 branchOptions 报 conditionValueOutOfRange", () => {
    const g = base(
      [
        llmNode("a", { outputMode: "branch", branchOptions: ["x", "y"] }),
        llmNode("b"),
        llmNode("c"),
      ],
      [
        { from: "a", to: "b", condition: { type: "branch", value: "x" } },
        { from: "a", to: "c", condition: { type: "branch", value: "z" } },
      ],
    );
    const r = validateGraph(g);
    expect(r).toEqual({
      ok: false,
      issues: [
        {
          code: "conditionValueOutOfRange",
          params: { value: "z", nodeId: "a" },
        },
      ],
    });
  });
  it("条件边挂非 branch 节点报 conditionNotBranchable", () => {
    const g = base(
      [llmNode("a"), llmNode("b")],
      [{ from: "a", to: "b", condition: { type: "branch", value: "x" } }],
    );
    const r = validateGraph(g);
    expect(r).toEqual({
      ok: false,
      issues: [{ code: "conditionNotBranchable", params: { nodeId: "a" } }],
    });
  });
  it("branch 节点缺 branchOptions 报 branchOptionsRequired（含空数组）", () => {
    for (const extra of [
      { outputMode: "branch" },
      { outputMode: "branch", branchOptions: [] },
    ]) {
      const r = validateGraph(
        base([llmNode("a", extra)], [{ from: "a", to: "END" }]),
      );
      expect(r).toEqual({
        ok: false,
        issues: [{ code: "branchOptionsRequired", params: { nodeId: "a" } }],
      });
    }
  });
  it("branchOptionsRequired 同时在 zod 层拒绝（JSON 模式解析门禁）", () => {
    expect(() =>
      graphJsonSchema.parse(
        base(
          [llmNode("a", { outputMode: "branch" })],
          [{ from: "a", to: "END" }],
        ),
      ),
    ).toThrow();
  });
  it("节点 id 撞执行状态通道保留名（inputs/nodes/route）报 reservedNodeId", () => {
    for (const id of ["inputs", "nodes", "route"]) {
      const r = validateGraph(base([llmNode(id)], [{ from: id, to: "END" }]));
      expect(r.ok, `id=${id} 应被拦截`).toBe(false);
      if (!r.ok) {
        expect(r.issues).toContainEqual({
          code: "reservedNodeId",
          params: { nodeId: id },
        });
      }
    }
  });
  it("zod 层错误包装为 code:schema（path + message 原样保留）", () => {
    const r = validateGraph({ version: 2, nodes: [], edges: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues[0].code).toBe("schema");
      expect(r.issues[0].params).toMatchObject({ path: "version" });
      expect(typeof r.issues[0].params?.message).toBe("string");
    }
  });
  it("节点字段错误 path 的数组下标还原为节点 id 并带 nodeId（多节点定位）", () => {
    const r = validateGraph(
      base(
        [llmNode("first"), llmNode("second", { prompt: "" })],
        [
          { from: "first", to: "second" },
          { from: "second", to: "END" },
        ],
      ),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const promptIssue = r.issues.find((issue) =>
        String(issue.params?.path).endsWith("prompt"),
      );
      expect(promptIssue?.params).toMatchObject({
        path: "nodes.second.prompt",
        nodeId: "second",
      });
    }
  });
  it("循环 count 模式缺 countSource 报 iterateCountRequired（带 nodeId）", () => {
    const r = validateGraph(
      base(
        [
          iterateNode("loop", {
            loopMode: "count",
            itemsSource: "",
            countSource: "",
          }),
        ],
        [{ from: "loop", to: "END" }],
      ),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toContainEqual({
        code: "iterateCountRequired",
        params: { nodeId: "loop" },
      });
    }
  });
  it("循环 while 模式缺 breakCondition 报 iterateBreakRequired（带 nodeId）", () => {
    const r = validateGraph(
      base(
        [
          iterateNode("loop", {
            loopMode: "while",
            itemsSource: "",
            breakCondition: undefined,
          }),
        ],
        [{ from: "loop", to: "END" }],
      ),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toContainEqual({
        code: "iterateBreakRequired",
        params: { nodeId: "loop" },
      });
    }
  });
  it("循环 array 模式缺 itemsSource 报 iterateItemsRequired；count 模式带 itemsSource 不误报", () => {
    const arrayMissing = validateGraph(
      base(
        [iterateNode("loop", { itemsSource: "" })],
        [{ from: "loop", to: "END" }],
      ),
    );
    expect(arrayMissing.ok).toBe(false);
    if (!arrayMissing.ok) {
      expect(arrayMissing.issues).toContainEqual({
        code: "iterateItemsRequired",
        params: { nodeId: "loop" },
      });
    }
    const countFull = validateGraph(
      base(
        [iterateNode("loop", { loopMode: "count", countSource: "5" })],
        [{ from: "loop", to: "END" }],
      ),
    );
    expect(countFull.ok).toBe(true);
  });
  it("分支图合法", () => {
    const g = base(
      [
        llmNode("a", { outputMode: "branch", branchOptions: ["x", "y"] }),
        llmNode("b"),
        llmNode("c"),
      ],
      [
        { from: "a", to: "b", condition: { type: "branch", value: "x" } },
        { from: "a", to: "c", condition: { type: "branch", value: "y" } },
        { from: "b", to: "END" },
        { from: "c", to: "END" },
      ],
    );
    expect(validateGraph(g)).toEqual({ ok: true, value: expect.anything() });
  });
});

describe("code 节点（kind:code）", () => {
  const codeNode = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: id,
    kind: "code",
    language: "bash",
    script: "echo hi",
    ...extra,
  });
  it("合法 code 节点通过，timeoutMs 缺省补 30000", () => {
    const r = validateGraph(
      base([codeNode("run")], [{ from: "run", to: "END" }]),
    );
    expect(r).toEqual({ ok: true, value: expect.anything() });
    if (r.ok) {
      expect(r.value.nodes[0]).toMatchObject({
        kind: "code",
        timeoutMs: 30000,
      });
    }
  });
  it("缺 script 拒绝", () => {
    expect(validateGraph(base([codeNode("run", { script: "" })], [])).ok).toBe(
      false,
    );
  });
  it("language 非法值拒绝", () => {
    expect(
      validateGraph(base([codeNode("run", { language: "ruby" })], [])).ok,
    ).toBe(false);
  });
  it("timeoutMs 低于 1s 或高于 24h 拒绝；上限内可调（用户裁定）", () => {
    expect(
      validateGraph(base([codeNode("run", { timeoutMs: 500 })], [])).ok,
    ).toBe(false);
    expect(
      validateGraph(base([codeNode("run", { timeoutMs: 86_400_001 })], [])).ok,
    ).toBe(false);
    expect(
      validateGraph(base([codeNode("run", { timeoutMs: 3_600_000 })], [])).ok,
    ).toBe(true);
  });
  it("code 节点混入 llm 专属字段（modelId）被剥离；outputMode/branchOptions 为 code 自有字段", () => {
    const r = validateGraph(
      base(
        [
          codeNode("run", {
            modelId: 5,
            outputMode: "branch",
            branchOptions: ["x"],
          }),
        ],
        [],
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.nodes[0]).not.toHaveProperty("modelId");
    }
  });
  it("code 分支节点合法：branchOptions + 条件边不报 conditionNotBranchable", () => {
    const g = base(
      [
        codeNode("gate", {
          outputMode: "branch",
          branchOptions: ["go", "stop"],
        }),
        codeNode("go-node", {}),
      ],
      [
        {
          from: "gate",
          to: "go-node",
          condition: { type: "branch", value: "go" },
        },
        {
          from: "gate",
          to: "END",
          condition: { type: "branch", value: "stop" },
        },
        { from: "go-node", to: "END" },
      ],
    );
    expect(validateGraph(g).ok).toBe(true);
  });
  it("code 分支节点缺 branchOptions 拒绝（branchOptionsRequired）", () => {
    for (const extra of [
      { outputMode: "branch" },
      { outputMode: "branch", branchOptions: [] },
    ]) {
      const r = validateGraph(
        base([codeNode("gate", extra)], [{ from: "gate", to: "END" }]),
      );
      expect(r).toEqual({
        ok: false,
        issues: [{ code: "branchOptionsRequired", params: { nodeId: "gate" } }],
      });
    }
  });
  it("条件边挂 code text 节点仍报 conditionNotBranchable", () => {
    const r = validateGraph(
      base(
        [codeNode("plain", {}), codeNode("next", {})],
        [
          {
            from: "plain",
            to: "next",
            condition: { type: "branch", value: "x" },
          },
          { from: "next", to: "END" },
        ],
      ),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toContainEqual({
        code: "conditionNotBranchable",
        params: { nodeId: "plain" },
      });
    }
  });
  it("旧图兼容：无 kind 字段的节点推断为 llm（零迁移）", () => {
    const legacy = {
      version: 1,
      inputSchema: {},
      nodes: [
        { id: "a", name: "a", modelId: 1, prompt: "p", outputMode: "text" },
      ],
      edges: [{ from: "a", to: "END" }],
    };
    const r = validateGraph(legacy);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.nodes[0]).toMatchObject({ kind: "llm" });
    }
  });
});

describe("节点坐标 position（画布编辑器）", () => {
  it("llm/code 节点均可携带合法坐标", () => {
    const r = validateGraph(
      base(
        [
          llmNode("a", { position: { x: 10, y: -5 } }),
          {
            id: "b",
            name: "b",
            kind: "code",
            language: "bash",
            script: "echo",
            position: { x: 340, y: 0 },
          },
        ],
        [
          { from: "a", to: "b" },
          { from: "b", to: "END" },
        ],
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.nodes[0]).toMatchObject({ position: { x: 10, y: -5 } });
    }
  });
  it("NaN/Infinity 坐标拒绝", () => {
    expect(
      validateGraph(
        base(
          [llmNode("a", { position: { x: NaN, y: 0 } })],
          [{ from: "a", to: "END" }],
        ),
      ).ok,
    ).toBe(false);
    expect(
      validateGraph(
        base(
          [llmNode("a", { position: { x: Infinity, y: 0 } })],
          [{ from: "a", to: "END" }],
        ),
      ).ok,
    ).toBe(false);
  });
  it("旧图无坐标照常通过（零迁移）", () => {
    expect(
      validateGraph(base([llmNode("a")], [{ from: "a", to: "END" }])).ok,
    ).toBe(true);
  });
  it("intent 节点：条件边可挂（与 condition 同构路由）；intents 空 zod 拒绝", () => {
    const ok = validateGraph(
      base(
        [intentNode("r")],
        [{ from: "r", to: "END", condition: { type: "branch", value: "a" } }],
      ),
    );
    expect(ok.ok).toBe(true);
    const empty = validateGraph(
      base([intentNode("r", { intents: [] })], [{ from: "r", to: "END" }]),
    );
    expect(empty.ok).toBe(false);
  });
});

describe("向量节点 timeoutMs（超时通道）", () => {
  it("vectorize/vectorSearch 节点 timeoutMs 默认 120s、下限 1s", () => {
    const ok1 = validateGraph(base([vectorizeNode("v1")], []));
    expect(ok1.ok).toBe(true);
    if (ok1.ok) {
      expect(ok1.value.nodes[0].timeoutMs).toBe(120_000);
    }
    const ok2 = validateGraph(base([vectorSearchNode("s1")], []));
    expect(ok2.ok).toBe(true);
    if (ok2.ok) {
      expect(ok2.value.nodes[0].timeoutMs).toBe(120_000);
    }
    const bad = validateGraph(
      base([vectorizeNode("v1", { timeoutMs: 500 })], []),
    );
    expect(bad.ok).toBe(false);
  });
});

describe("start 节点（kind:start）", () => {
  const startNode = (id = "start", extra: Record<string, unknown> = {}) => ({
    id,
    name: "开始",
    kind: "start",
    ...extra,
  });
  it("合法：variables 变量列表通过（inputSchema 同步由编辑器维护）", () => {
    const r = validateGraph({
      ...base(
        [startNode("start", { variables: ["topic"] }), llmNode("node-1")],
        [{ from: "start", to: "node-1" }],
      ),
      inputSchema: { topic: "string" },
    });
    expect(r).toEqual({ ok: true, value: expect.anything() });
  });
  it("缺 variables 补默认 []", () => {
    const r = validateGraph(
      base([startNode(), llmNode("node-1")], [{ from: "start", to: "node-1" }]),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.nodes[0]).toMatchObject({ kind: "start", variables: [] });
    }
  });
  it("variables 含空串拒绝（变量名必填）", () => {
    const r = validateGraph(
      base(
        [startNode("start", { variables: [""] }), llmNode("node-1")],
        [{ from: "start", to: "node-1" }],
      ),
    );
    expect(r.ok).toBe(false);
  });
  it("两个 start 报 duplicateStartNode（带首个多余 start 的 nodeId）", () => {
    const r = validateGraph(
      base(
        [startNode("start"), startNode("start-2"), llmNode("node-1")],
        [{ from: "start", to: "node-1" }],
      ),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toContainEqual({
        code: "duplicateStartNode",
        params: { nodeId: "start-2" },
      });
    }
  });
  it("start 有入边报 startIncomingEdge（带 start 的 nodeId）", () => {
    const r = validateGraph(
      base(
        [startNode("start"), llmNode("node-1"), llmNode("node-2")],
        [
          { from: "start", to: "node-1" },
          { from: "node-1", to: "start" },
        ],
      ),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toContainEqual({
        code: "startIncomingEdge",
        params: { nodeId: "start" },
      });
    }
  });
});

describe("ensureStartNode（无 start 图自动补齐：AI 技能落库与存量图自愈）", () => {
  it("无 start 时注入 start 节点与 start→唯一入口边（再校验通过）", () => {
    const json = base(
      [llmNode("git-batch"), llmNode("notify")],
      [
        { from: "git-batch", to: "notify" },
        { from: "notify", to: "END" },
      ],
    );
    const next = ensureStartNode(json as Parameters<typeof ensureStartNode>[0]);
    expect(next.nodes).toContainEqual({
      id: "start",
      name: "开始",
      kind: "start",
      variables: [],
    });
    expect(next.edges).toContainEqual({ from: "start", to: "git-batch" });
    expect(validateGraph(next).ok).toBe(true);
  });
  it("已有 start 时原样返回（不重复注入）", () => {
    const json = base(
      [
        { id: "start", name: "开始", kind: "start", variables: [] },
        llmNode("node-1"),
      ],
      [
        { from: "start", to: "node-1" },
        { from: "node-1", to: "END" },
      ],
    );
    expect(
      ensureStartNode(json as Parameters<typeof ensureStartNode>[0]),
    ).toEqual(json);
  });
  it("id start 被非 start 节点占用时不注入（避免撞 duplicateNodeId）", () => {
    const json = base(
      [llmNode("start", { kind: "code", language: "bash", script: "echo hi" })],
      [{ from: "start", to: "END" }],
    );
    const next = ensureStartNode(json as Parameters<typeof ensureStartNode>[0]);
    expect(next.nodes.filter((n) => n.id === "start")).toHaveLength(1);
    expect(next.edges).toEqual([{ from: "start", to: "END" }]);
  });
  it("无入边节点非唯一（未过校验的图）原样返回不猜测", () => {
    const json = base([llmNode("a"), llmNode("b")], []);
    expect(
      ensureStartNode(json as Parameters<typeof ensureStartNode>[0]),
    ).toEqual(json);
  });
});

describe("ensureEndEdges（叶子节点补 END 边：末节点断头自愈）", () => {
  it("无出边的业务叶子补 to:END（再校验通过）", () => {
    const json = base(
      [llmNode("a"), llmNode("b")],
      [{ from: "a", to: "b" }], // b 是断头叶子
    );
    const next = ensureEndEdges(json as Parameters<typeof ensureEndEdges>[0]);
    expect(next.edges).toContainEqual({ from: "b", to: "END" });
    expect(validateGraph(next).ok).toBe(true);
  });
  it("已连 END 的叶子不重复补", () => {
    const json = base([llmNode("a")], [{ from: "a", to: "END" }]);
    expect(
      ensureEndEdges(json as Parameters<typeof ensureEndEdges>[0]).edges,
    ).toHaveLength(1);
  });
  it("branch 节点只有条件出边时不补（无条件 END 边会与路由双触发，语义破坏）", () => {
    const json = base(
      [
        llmNode("route", { outputMode: "branch", branchOptions: ["x"] }),
        llmNode("sink"),
      ],
      [
        {
          from: "route",
          to: "sink",
          condition: { type: "branch", value: "x" },
        },
      ],
    );
    const next = ensureEndEdges(json as Parameters<typeof ensureEndEdges>[0]);
    // route 本体不得新增无条件出边（sink 叶子补 END 是正确行为）
    expect(next.edges.some((e) => e.from === "route" && !e.condition)).toBe(
      false,
    );
  });
  it("start 空图（start 无出边）不补 start→END", () => {
    const json = base(
      [{ id: "start", name: "开始", kind: "start", variables: [] }],
      [],
    );
    expect(
      ensureEndEdges(json as Parameters<typeof ensureEndEdges>[0]).edges,
    ).toHaveLength(0);
  });
});

describe("normalizeGraph（start 补齐 + 叶子连 END 组合归一）", () => {
  it("start 缺失且末节点断头 → 一并补齐（AI 生成图完整形态）", () => {
    const json = base(
      [llmNode("gen"), llmNode("notify")],
      [{ from: "gen", to: "notify" }], // 无 start、notify 断头
    );
    const next = normalizeGraph(json as Parameters<typeof normalizeGraph>[0]);
    expect(next.edges).toContainEqual({ from: "start", to: "gen" });
    expect(next.edges).toContainEqual({ from: "notify", to: "END" });
    expect(validateGraph(next).ok).toBe(true);
  });
});

describe("imageGen 协议分流", () => {
  const comfyNode = {
    id: "gen",
    name: "生图",
    kind: "imageGen",
    protocol: "comfyui",
    providerId: 2,
    workflowJson:
      '{"6":{"class_type":"CLIPTextEncode","inputs":{"text":"{{prompt}}"}}}',
    prompt: "a cat",
    size: "1024x1024",
    randomizeSeed: true,
    timeoutMs: 300_000,
  };

  it("旧图无 protocol → 默认 openai + 默认值注入", () => {
    const node = imageGenNodeSchema.parse({
      id: "gen",
      name: "生图",
      kind: "imageGen",
      modelId: 1,
      prompt: "p",
    });
    expect(node.protocol).toBe("openai");
    expect(node.randomizeSeed).toBe(true);
    expect(node.timeoutMs).toBe(300_000);
  });

  it("openai 协议缺 modelId 拒绝", () => {
    const result = imageGenNodeSchema.safeParse({
      id: "g",
      name: "生图",
      kind: "imageGen",
      protocol: "openai",
      prompt: "p",
    });
    expect(result.success).toBe(false);
  });

  it("comfyui 协议缺 providerId/workflowJson 拒绝", () => {
    const result = imageGenNodeSchema.safeParse({
      id: "g",
      name: "生图",
      kind: "imageGen",
      protocol: "comfyui",
      prompt: "p",
    });
    expect(result.success).toBe(false);
  });

  it("comfyui 完整通过 + isComfyUIImageGen 判定", () => {
    const node = imageGenNodeSchema.parse(comfyNode);
    expect(isComfyUIImageGen(node)).toBe(true);
    expect(
      isComfyUIImageGen(
        imageGenNodeSchema.parse({
          id: "g",
          name: "生图",
          kind: "imageGen",
          modelId: 1,
          prompt: "p",
        }),
      ),
    ).toBe(false);
  });
});
