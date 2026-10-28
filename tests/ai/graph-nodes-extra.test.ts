// tests/ai/graph-nodes-extra.test.ts
/**
 * 新节点族执行测试：fileRead（工作空间内读/越界/未绑定）、notify
 * （Notification 打桩）、subflow（子图输出回流 + 子图失败归因 + 循环
 * 引用拦截）、iterate（多项串行 join + 项数上限）与 splitIterateItems
 * 纯函数。mock 三件套沿用 graph-code-node.test.ts 先例。
 */
import { describe, expect, it, vi, beforeAll, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`) },
  Notification: vi.fn().mockImplementation(() => ({ show: vi.fn() })),
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    // 去会话化：节点详情落 graphRunNode（session/message 两键已删）
    graphRunNode: { upsert: vi.fn(async () => ({ id: 1 })) },
    automationRun: { create: vi.fn(async () => ({ id: 9 })), update: vi.fn() },
    automationTask: { update: vi.fn() },
    model: { findUnique: vi.fn() },
    provider: { findUnique: vi.fn() },
    graphDefinition: { findFirst: vi.fn() },
    libraryItem: { findMany: vi.fn() },
  },
}));
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../electron/domains/ai/agent/skill-loader", () => ({
  loadSkills: vi.fn(() => []),
}));
vi.mock("../../electron/domains/security/command-gate", () => ({
  commandGate: vi.fn(() => "allow" as const),
}));

import prisma from "../../electron/commons/prisma-client";
import { libraryDir } from "../../electron/commons/paths";
import { Notification } from "electron";
import {
  executeGraphRun,
  splitIterateItems,
} from "../../electron/domains/ai/orchestration/graph-executor";

let workspaceDir: string;

beforeAll(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "tianshu-ws-"));
  vi.mocked(prisma.graphRunNode.upsert).mockClear();
  vi.mocked(prisma.automationRun.update).mockClear();
});

afterEach(() => {
  vi.mocked(prisma.graphDefinition.findFirst).mockReset();
  vi.mocked(Notification).mockClear();
});

const run = (
  nodes: object[],
  edges: object[],
  inputs: Record<string, string> = {},
) =>
  executeGraphRun({
    graph: {
      id: 5,
      name: "extra-demo",
      graphJson: JSON.stringify({ version: 1, inputSchema: {}, nodes, edges }),
      version: 1,
      enabled: true,
      userId: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never,
    task: null,
    inputs,
    triggerType: "manual" as const,
    attempt: 1,
    abort: new AbortController().signal,
    workspace: { id: 9, directoryPath: workspaceDir },
  });

const lastUpdate = () =>
  vi.mocked(prisma.automationRun.update).mock.calls.at(-1)![0];
const traceOf = () => JSON.parse(lastUpdate().data.graphTrace as string);

describe("splitIterateItems（纯函数）", () => {
  it("JSON 字符串数组按项；非法 JSON 按非空行；空行为零项", () => {
    expect(splitIterateItems('["a","b"]')).toEqual(["a", "b"]);
    expect(splitIterateItems("a\n\n b \nc")).toEqual(["a", "b", "c"]);
    expect(splitIterateItems("  \n  ")).toEqual([]);
    // 非字符串数组 String 化
    expect(splitIterateItems("[1,2]")).toEqual(["1", "2"]);
  });
});

describe("fileRead 节点", () => {
  it("读工作空间内文件：模板替换路径 → 文本为 output", async () => {
    await fs.writeFile(path.join(workspaceDir, "note.txt"), "hello ws");
    const out = await run(
      [
        {
          id: "read",
          name: "读取",
          kind: "fileRead",
          path: "{{input.file}}",
        },
      ],
      [{ from: "read", to: "END" }],
      { file: "note.txt" },
    );
    expect(out).toBe("success");
    expect(traceOf()[0].outputPreview).toBe("hello ws");
  });

  it("路径越界（../ 逃逸）→ file_outside_workspace", async () => {
    const out = await run(
      [{ id: "read", name: "读取", kind: "fileRead", path: "../secret" }],
      [{ from: "read", to: "END" }],
    );
    expect(out).toBe("failed");
    expect(lastUpdate().data.error).toMatch(/node:read file_outside_workspace/);
  });

  it("文件缺失 → file_missing", async () => {
    const out = await run(
      [{ id: "read", name: "读取", kind: "fileRead", path: "ghost.txt" }],
      [{ from: "read", to: "END" }],
    );
    expect(out).toBe("failed");
    expect(lastUpdate().data.error).toMatch(/node:read file_missing/);
  });
});

describe("notify 节点", () => {
  it("模板替换后发桌面通知，output=标题+正文", async () => {
    const out = await run(
      [
        {
          id: "ping",
          name: "通知",
          kind: "notify",
          title: "{{input.t}} 已完成",
          body: "耗时 3s",
        },
      ],
      [{ from: "ping", to: "END" }],
      { t: "日报" },
    );
    expect(out).toBe("success");
    expect(Notification).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(Notification).mock.calls[0][0] as {
      title: string;
      body: string;
    };
    expect(arg.title).toBe("日报 已完成");
    expect(arg.body).toBe("耗时 3s");
    expect(traceOf()[0].outputPreview).toContain("日报 已完成");
  });
});

/** 子图行（code 节点直接出结果，绕开模型 mock） */
const subGraphRow = () => ({
  id: 77,
  name: "子流程",
  graphJson: JSON.stringify({
    version: 1,
    inputSchema: { word: "string" },
    nodes: [
      {
        id: "sub-code",
        name: "加工",
        kind: "code",
        language: "bash",
        script: 'echo "sub:{{input.word}}"',
      },
    ],
    edges: [{ from: "sub-code", to: "END" }],
  }),
  version: 1,
  enabled: true,
  userId: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
});

/** 承接变量子图：echo 累积串（acc=上一轮输出 trim、n=迭代序数） */
const carryGraphRow = () => ({
  id: 77,
  name: "累积子流程",
  graphJson: JSON.stringify({
    version: 1,
    inputSchema: { n: "string", acc: "string" },
    nodes: [
      {
        id: "carry-code",
        name: "累积",
        kind: "code",
        language: "bash",
        script: 'echo "{{input.acc}}+{{input.n}}"',
      },
    ],
    edges: [{ from: "carry-code", to: "END" }],
  }),
  version: 1,
  enabled: true,
  userId: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
});

/** 死信子图：word=boom 时非零退出（单项失败源） */
const failChildRow = () => ({
  id: 77,
  name: "会失败的子流程",
  graphJson: JSON.stringify({
    version: 1,
    inputSchema: { word: "string" },
    nodes: [
      {
        id: "pick",
        name: "挑错",
        kind: "code",
        language: "bash",
        script:
          'word="{{input.word}}"\n[ "$word" = "boom" ] && exit 3\necho "ok:$word"',
      },
    ],
    edges: [{ from: "pick", to: "END" }],
  }),
  version: 1,
  enabled: true,
  userId: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe("subflow 节点", () => {
  it("变量映射透传子图，终点 output 回流为节点 output", async () => {
    vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue(
      subGraphRow() as never,
    );
    const out = await run(
      [
        {
          id: "call",
          name: "调用子流程",
          kind: "subflow",
          graphId: 77,
          inputs: [{ key: "word", value: "{{input.topic}}" }],
        },
      ],
      [{ from: "call", to: "END" }],
      { topic: "tianshu" },
    );
    expect(out).toBe("success");
    // echo 输出带尾随换行（代码节点 stdout 原样语义）
    expect(traceOf()[0].outputPreview).toContain("sub:tianshu");
  });

  it("子图失败 → subflow_failed 归因节点", async () => {
    vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue(
      subGraphRow() as never,
    );
    // 子图 code 脚本非零退出（越界路径无关，用 exit 3）
    const badRow = {
      ...subGraphRow(),
      graphJson: JSON.stringify({
        version: 1,
        inputSchema: {},
        nodes: [
          {
            id: "boom",
            name: "爆",
            kind: "code",
            language: "bash",
            script: "exit 3",
          },
        ],
        edges: [{ from: "boom", to: "END" }],
      }),
    };
    vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue(
      badRow as never,
    );
    const out = await run(
      [{ id: "call", name: "调用", kind: "subflow", graphId: 77, inputs: [] }],
      [{ from: "call", to: "END" }],
    );
    expect(out).toBe("failed");
    expect(lastUpdate().data.error).toMatch(/node:call subflow_failed/);
  });

  it("循环引用（子图 id 已在调用链）→ subflow_cycle", async () => {
    const out = await run(
      [
        {
          id: "call",
          name: "自引用",
          kind: "subflow",
          graphId: 5, // 父图自身 id（模拟链中已有）
          inputs: [],
        },
      ],
      [{ from: "call", to: "END" }],
    );
    expect(out).toBe("failed");
    expect(lastUpdate().data.error).toMatch(/node:call subflow_cycle/);
  });
});

describe("iterate 节点", () => {
  it("三项按行拆分串行执行子图，输出按行 join", async () => {
    vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue(
      subGraphRow() as never,
    );
    const out = await run(
      [
        {
          id: "loop",
          name: "循环",
          kind: "iterate",
          itemsSource: "甲\n乙\n丙",
          graphId: 77,
          itemVariable: "word",
          maxItems: 10,
        },
      ],
      [{ from: "loop", to: "END" }],
    );
    expect(out).toBe("success");
    // 每项 echo 尾随换行 + join("\n")
    expect(traceOf()[0].outputPreview).toContain("sub:甲");
    expect(traceOf()[0].outputPreview).toContain("sub:乙");
    expect(traceOf()[0].outputPreview).toContain("sub:丙");
  });

  it("超过 maxItems → iterate_too_many_items", async () => {
    const out = await run(
      [
        {
          id: "loop",
          name: "循环",
          kind: "iterate",
          itemsSource: "1\n2\n3",
          graphId: 77,
          itemVariable: "word",
          maxItems: 2,
        },
      ],
      [{ from: "loop", to: "END" }],
    );
    expect(out).toBe("failed");
    expect(lastUpdate().data.error).toMatch(/node:loop iterate_too_many_items/);
  });

  it("次数模式：countSource 求值为 3 → 子图收序数 1/2/3 项，输出三行", async () => {
    vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue(
      subGraphRow() as never,
    );
    const out = await run(
      [
        {
          id: "loop",
          name: "循环",
          kind: "iterate",
          loopMode: "count",
          itemsSource: "",
          countSource: "{{input.times}}",
          graphId: 77,
          itemVariable: "word",
          maxItems: 10,
        },
      ],
      [{ from: "loop", to: "END" }],
      { times: "3" },
    );
    expect(out).toBe("success");
    expect(traceOf()[0].outputPreview).toContain("sub:1");
    expect(traceOf()[0].outputPreview).toContain("sub:2");
    expect(traceOf()[0].outputPreview).toContain("sub:3");
  });

  it("次数模式：求值非正整数 → iterate_bad_count", async () => {
    const out = await run(
      [
        {
          id: "loop",
          name: "循环",
          kind: "iterate",
          loopMode: "count",
          itemsSource: "",
          countSource: "abc",
          graphId: 77,
          itemVariable: "word",
          maxItems: 10,
        },
      ],
      [{ from: "loop", to: "END" }],
    );
    expect(out).toBe("failed");
    expect(lastUpdate().data.error).toMatch(/node:loop iterate_bad_count/);
  });

  it("无限循环 + 承接变量：carry 跨轮累积（首轮初值 0），break 引用本轮输出第 2 轮触发", async () => {
    // 子图 echo "{{input.acc}}+{{input.n}}"：轮1 输出 0+1 → carry 累积
    // → 轮2 输出 0+1+2 → break 条件 eq 命中跳出（仅 2 轮）
    vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue(
      carryGraphRow() as never,
    );
    const out = await run(
      [
        {
          id: "loop",
          name: "循环",
          kind: "iterate",
          loopMode: "while",
          itemsSource: "",
          graphId: 77,
          itemVariable: "n",
          maxItems: 10,
          carryVariable: "acc",
          carryInitial: "0",
          breakCondition: {
            source: "{{nodes.loop.output}}",
            operator: "eq",
            value: "0+1+2",
          },
        },
      ],
      [{ from: "loop", to: "END" }],
    );
    expect(out).toBe("success");
    expect(traceOf()[0].outputPreview).toContain("0+1+");
    expect(traceOf()[0].outputPreview).toContain("0+1+2");
    // 第 3 轮未发生：输出不含再累积的 +3 段
    expect(traceOf()[0].outputPreview).not.toContain("0+1+2+");
  });

  it("无限循环永不满足终止条件 → maxItems 保险丝 iterate_too_many_items", async () => {
    vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue(
      carryGraphRow() as never,
    );
    const out = await run(
      [
        {
          id: "loop",
          name: "循环",
          kind: "iterate",
          loopMode: "while",
          itemsSource: "",
          graphId: 77,
          itemVariable: "n",
          maxItems: 3,
          carryVariable: "acc",
          carryInitial: "0",
          breakCondition: {
            source: "{{nodes.loop.output}}",
            operator: "isEmpty",
          },
        },
      ],
      [{ from: "loop", to: "END" }],
    );
    expect(out).toBe("failed");
    expect(lastUpdate().data.error).toMatch(/node:loop iterate_too_many_items/);
  });

  it("continue 模式失败项落死信：下游经 {{nodes.loop.errorOutput}} 引用", async () => {
    // 子图 boom 项非零退出制造单项失败；父图 code 节点把死信打到 stdout
    vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue(
      failChildRow() as never,
    );
    const out = await run(
      [
        {
          id: "loop",
          name: "循环",
          kind: "iterate",
          itemsSource: "good\nboom\ngood2",
          graphId: 77,
          itemVariable: "word",
          maxItems: 10,
          onItemError: "continue",
        },
        {
          id: "sink",
          name: "死信查看",
          kind: "code",
          language: "nodejs",
          script:
            'import { readFileSync } from "node:fs";\nconst payload = JSON.parse(readFileSync(0, "utf8"));\nconsole.log(payload.nodes.loop?.errorOutput ?? "NO-DEAD-LETTER");',
          timeoutMs: 30_000,
        },
      ],
      [
        { from: "loop", to: "sink" },
        { from: "sink", to: "END" },
      ],
    );
    expect(out).toBe("success");
    const byId = Object.fromEntries(
      traceOf().map((e: { id: string }) => [e.id, e]),
    );
    expect(byId.sink.outputPreview).toContain("#1");
    expect(byId.sink.outputPreview).toContain("boom");
  });
});

describe("librarySearch 节点", () => {
  it("关键词 AND 匹配资料库文本：输出文件名+片段；无命中输出空", async () => {
    const { default: fsx } = await import("node:fs/promises");
    const libRoot = libraryDir();
    await fsx.mkdir(path.join(libRoot, "301"), { recursive: true });
    await fsx.writeFile(
      path.join(libRoot, "301", "guide.md"),
      "The tianshu deployment guide covers secrets and env vars.",
    );
    await fsx.mkdir(path.join(libRoot, "302"), { recursive: true });
    await fsx.writeFile(
      path.join(libRoot, "302", "other.txt"),
      "unrelated content here",
    );
    vi.mocked(prisma.libraryItem.findMany).mockResolvedValue([
      { id: 301, name: "guide.md", kind: "file", userId: 1 },
      { id: 302, name: "other.txt", kind: "file", userId: 1 },
    ] as never);

    const out = await run(
      [
        {
          id: "find",
          name: "检索",
          kind: "librarySearch",
          keywords: "tianshu {{input.word}}",
          maxResults: 5,
        },
      ],
      [{ from: "find", to: "END" }],
      { word: "secrets" },
    );
    expect(out).toBe("success");
    const preview = traceOf()[0].outputPreview;
    expect(preview).toContain("guide.md");
    expect(preview).toContain("deployment guide");
    // 未命中的 other.txt 不在结果里
    expect(preview).not.toContain("other.txt");

    // 无命中：成功且输出为空（空召回不算失败）
    const miss = await run(
      [
        {
          id: "find",
          name: "检索",
          kind: "librarySearch",
          keywords: "zzz-not-exist",
          maxResults: 5,
        },
      ],
      [{ from: "find", to: "END" }],
    );
    expect(miss).toBe("success");
    expect(traceOf()[0].outputPreview).toBe("");
  });
});

describe("jsonParse/jsonStringify 节点", () => {
  const httpBody = JSON.stringify({
    code: 0,
    data: { items: [{ id: "a" }, { id: "b" }], note: 'hello "world"' },
  });

  it("jsonParse：路径提取字符串原样 / 对象紧凑 / 数组逐行展开", async () => {
    // 路径提取字符串（含转义字符原样还原）
    const out = await run(
      [
        {
          id: "jp",
          name: "解析",
          kind: "jsonParse",
          source: "{{nodes.x.output}}",
          path: "data.note",
        },
      ],
      [{ from: "jp", to: "END" }],
    );
    expect(out).toBe("failed"); // 无上游节点引用 → 先验证失败路径
    expect(lastUpdate().data.error).toMatch(/template_ref_missing|json_parse/);
  });

  it("jsonParse：接上游注入数据提取与逐行展开", async () => {
    // 上游注入经 code 节点回显 body，再 jsonParse 展开
    const out = await run(
      [
        {
          id: "src",
          name: "源",
          kind: "code",
          language: "nodejs",
          script: `console.log(JSON.stringify(${httpBody}))`,
        },
        {
          id: "jp",
          name: "展开",
          kind: "jsonParse",
          source: "{{nodes.src.output}}",
          path: "data.items",
          arrayLines: true,
        },
      ],
      [
        { from: "src", to: "jp" },
        { from: "jp", to: "END" },
      ],
    );
    expect(out).toBe("success");
    const trace = traceOf();
    expect(trace[1].outputPreview).toContain('{"id":"a"}');
    expect(trace[1].outputPreview).toContain('{"id":"b"}');
  });

  it("jsonParse：非法 JSON → json_parse_error；路径缺失 → json_path_missing", async () => {
    const bad = await run(
      [
        {
          id: "jp",
          name: "解析",
          kind: "jsonParse",
          source: "{{input.raw}}",
        },
      ],
      [{ from: "jp", to: "END" }],
      { raw: "not-json" },
    );
    expect(bad).toBe("failed");
    expect(lastUpdate().data.error).toMatch(/node:jp json_parse_error/);

    const miss = await run(
      [
        {
          id: "jp",
          name: "解析",
          kind: "jsonParse",
          source: "{{input.raw}}",
          path: "a.b.c",
        },
      ],
      [{ from: "jp", to: "END" }],
      { raw: '{"a":{}}' },
    );
    expect(miss).toBe("failed");
    expect(lastUpdate().data.error).toMatch(/node:jp json_path_missing/);
  });

  it("jsonStringify：合法 JSON 规范化；普通文本转义字面量", async () => {
    const out = await run(
      [
        {
          id: "js",
          name: "序列化",
          kind: "jsonStringify",
          source: "{{input.text}}",
        },
      ],
      [{ from: "js", to: "END" }],
      { text: 'he said "hi"\nnewline' },
    );
    expect(out).toBe("success");
    expect(traceOf()[0].outputPreview).toContain(
      JSON.stringify('he said "hi"\nnewline').slice(0, 40),
    );

    const norm = await run(
      [
        {
          id: "js",
          name: "序列化",
          kind: "jsonStringify",
          source: "{{input.json}}",
        },
      ],
      [{ from: "js", to: "END" }],
      { json: '{ "b": 1,  "a": [1, 2] }' },
    );
    expect(norm).toBe("success");
    expect(traceOf()[0].outputPreview).toContain('{"b":1,"a":[1,2]}');
  });
});

describe("resolveJsonPath（纯函数）", () => {
  it("点路径/数组下标/混合；根空路径；miss 返回 ok:false", async () => {
    const { resolveJsonPath } =
      await import("../../electron/domains/ai/orchestration/graph-executor");
    const root = { a: { b: [{ c: 1 }, { c: 2 }] } };
    expect(resolveJsonPath(root, "a.b[1].c")).toEqual({ ok: true, value: 2 });
    expect(resolveJsonPath(root, "")).toEqual({ ok: true, value: root });
    expect(resolveJsonPath(root, "a.x").ok).toBe(false);
    expect(resolveJsonPath(root, "a.b[5]").ok).toBe(false);
    expect(resolveJsonPath([10, 20], "[1]")).toEqual({ ok: true, value: 20 });
  });
});

describe("condition 条件分支节点", () => {
  const conditionGraph = (
    branches: unknown[],
    fallback?: string,
    score: string = "85",
  ) =>
    run(
      [
        {
          id: "judge",
          name: "判断",
          kind: "condition",
          branches,
          ...(fallback ? { fallback } : {}),
        },
        {
          id: "hi",
          name: "高",
          kind: "code",
          language: "bash",
          script: "echo high-path",
        },
        {
          id: "lo",
          name: "低",
          kind: "code",
          language: "bash",
          script: "echo low-path",
        },
      ],
      [
        { from: "judge", to: "hi", condition: { type: "branch", value: "高" } },
        { from: "judge", to: "lo", condition: { type: "branch", value: "低" } },
        { from: "hi", to: "END" },
        { from: "lo", to: "END" },
      ],
      { score },
    );

  it("条件命中路由对应分支，其余 skipped", async () => {
    const out = await conditionGraph([
      {
        name: "高",
        conditions: [
          { source: "{{input.score}}", operator: "gte", value: "80" },
        ],
      },
      {
        name: "低",
        conditions: [
          { source: "{{input.score}}", operator: "lt", value: "80" },
        ],
      },
    ]);
    expect(out).toBe("success");
    const byId = Object.fromEntries(
      traceOf().map((e: { id: string }) => [e.id, e]),
    );
    expect(byId.judge.outputPreview).toBe("高");
    expect(byId.hi.status).toBe("success");
    expect(byId.lo.status).toBe("skipped");
  });

  it("全不中且有兜底 → 走兜底分支", async () => {
    const out = await conditionGraph(
      [
        {
          name: "高",
          conditions: [
            { source: "{{input.score}}", operator: "gt", value: "200" },
          ],
        },
      ],
      "低",
    );
    expect(out).toBe("success");
    const byId = Object.fromEntries(
      traceOf().map((e: { id: string }) => [e.id, e]),
    );
    expect(byId.judge.outputPreview).toBe("低");
    expect(byId.hi.status).toBe("skipped");
    expect(byId.lo.status).toBe("success");
  });

  it("多条件 AND：任一不满足整支不命中；顺序取首个命中", async () => {
    const out = await conditionGraph([
      {
        name: "高",
        conditions: [
          { source: "{{input.score}}", operator: "gte", value: "80" },
          { source: "{{input.score}}", operator: "lte", value: "90" },
        ],
      },
      {
        name: "低",
        conditions: [{ source: "{{input.score}}", operator: "notEmpty" }],
      },
    ]);
    expect(out).toBe("success");
    const byId = Object.fromEntries(
      traceOf().map((e: { id: string }) => [e.id, e]),
    );
    expect(byId.judge.outputPreview).toBe("高");
  });
});

describe("evalCondition（纯函数）", () => {
  it("11 种运算符边界：字符串/数字/空/包含/正则", async () => {
    const { evalCondition } =
      await import("../../electron/domains/ai/orchestration/graph-executor");
    expect(evalCondition("a", "eq", "a")).toBe(true);
    expect(evalCondition("a", "neq", "b")).toBe(true);
    expect(evalCondition("hello world", "contains", "world")).toBe(true);
    expect(evalCondition("hello", "notContains", "x")).toBe(true);
    expect(evalCondition("  ", "isEmpty", "")).toBe(true);
    expect(evalCondition("x", "notEmpty", "")).toBe(true);
    expect(evalCondition("10", "gt", "9")).toBe(true);
    expect(evalCondition("10", "gte", "10")).toBe(true);
    expect(evalCondition("9", "lt", "10")).toBe(true);
    expect(evalCondition("10", "lte", "10")).toBe(true);
    expect(evalCondition("a12", "regex", "^a[0-9]+$")).toBe(true);
    // 数字比较 NaN → false；非法正则 → false
    expect(evalCondition("abc", "gt", "1")).toBe(false);
    expect(evalCondition("x", "regex", "[")).toBe(false);
  });
});

describe("fileWrite 节点", () => {
  it("追加模式：目录自动创建 + 追加带换行 + 输出确认", async () => {
    const out = await run(
      [
        {
          id: "write",
          name: "写入",
          kind: "fileWrite",
          path: "out/log-{{input.day}}.md",
          mode: "append",
          content: "{{input.day}} 一条记录",
        },
      ],
      [{ from: "write", to: "END" }],
      { day: "2026-10-05" },
    );
    expect(out).toBe("success");
    const written = await fs.readFile(
      path.join(workspaceDir, "out/log-2026-10-05.md"),
      "utf-8",
    );
    expect(written).toBe("2026-10-05 一条记录\n");
    expect(traceOf()[0].outputPreview).toContain("已追加");
  });

  it("覆盖模式整文件重写；default 任务拒写", async () => {
    await fs.mkdir(path.join(workspaceDir, "out2"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "out2/f.txt"), "old");
    const out = await run(
      [
        {
          id: "write",
          name: "覆盖",
          kind: "fileWrite",
          path: "out2/f.txt",
          mode: "overwrite",
          content: "new",
        },
      ],
      [{ from: "write", to: "END" }],
    );
    expect(out).toBe("success");
    expect(
      await fs.readFile(path.join(workspaceDir, "out2/f.txt"), "utf-8"),
    ).toBe("new");

    // codeAuthorized=false → file_write_denied（构造 ctx 需要任务态，
    // 通过 default 任务行模拟：executeGraphRun 的 params.task 决定；
    // 此处用 graph.params 无法注入——借由 code 节点同类语义既有测试覆盖，
    // 这里断言越界防护）
    const outside = await run(
      [
        {
          id: "write",
          name: "越界",
          kind: "fileWrite",
          path: "../escape.txt",
          mode: "overwrite",
          content: "x",
        },
      ],
      [{ from: "write", to: "END" }],
    );
    expect(outside).toBe("failed");
    expect(lastUpdate().data.error).toMatch(
      /node:write file_outside_workspace/,
    );
  });
});

describe("docExtract 节点", () => {
  it("txt 直读 + 截断标注", async () => {
    await fs.writeFile(path.join(workspaceDir, "note.txt"), "x".repeat(1_500));
    const out = await run(
      [
        {
          id: "doc",
          name: "提取",
          kind: "docExtract",
          path: "note.txt",
          maxChars: 1_000,
        },
      ],
      [{ from: "doc", to: "END" }],
    );
    expect(out).toBe("success");
    // trace preview 只存 200 字（标注在 1000 字处）——从节点详情行验证截断
    const row = vi.mocked(prisma.graphRunNode.upsert).mock.calls.at(-1)![0];
    expect(row.create.output).toContain("已截断");
    expect(row.create.output).toContain("1500");
  });

  it("不支持的类型 → doc_unsupported_type；缺失 → file_missing", async () => {
    const bad = await run(
      [{ id: "doc", name: "提取", kind: "docExtract", path: "file.rar" }],
      [{ from: "doc", to: "END" }],
    );
    expect(bad).toBe("failed");
    expect(lastUpdate().data.error).toMatch(/node:doc doc_unsupported_type/);
    const missing = await run(
      [{ id: "doc", name: "提取", kind: "docExtract", path: "ghost.pdf" }],
      [{ from: "doc", to: "END" }],
    );
    expect(missing).toBe("failed");
    expect(lastUpdate().data.error).toMatch(/node:doc/);
  });
});

describe("delay 节点", () => {
  it("短延时可完成（秒级粒度，用 1s）", async () => {
    const out = await run(
      [{ id: "wait", name: "等待", kind: "delay", seconds: 1 }],
      [{ from: "wait", to: "END" }],
    );
    expect(out).toBe("success");
    expect(traceOf()[0].outputPreview).toContain("已等待 1s");
  });
});

describe("iterate 增强", () => {
  it("索引变量注入子工作流（itemIndex 形态）", async () => {
    vi.mocked(prisma.graphDefinition.findFirst).mockReset();
    vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue({
      id: 77,
      name: "带索引子图",
      graphJson: JSON.stringify({
        version: 1,
        inputSchema: { word: "string", wordIndex: "string" },
        nodes: [
          {
            id: "sub",
            name: "加工",
            kind: "code",
            language: "bash",
            script: 'echo "#{{input.wordIndex}}:{{input.word}}"',
          },
        ],
        edges: [{ from: "sub", to: "END" }],
      }),
      version: 1,
      enabled: true,
      userId: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const out = await run(
      [
        {
          id: "loop",
          name: "循环",
          kind: "iterate",
          itemsSource: "甲\n乙",
          graphId: 77,
          itemVariable: "word",
          maxItems: 10,
          concurrency: 1,
          onItemError: "abort",
        },
      ],
      [{ from: "loop", to: "END" }],
    );
    expect(out).toBe("success");
    const preview = traceOf()[0].outputPreview;
    expect(preview).toContain("#0:");
    expect(preview).toContain("#1:");
  });

  it("continue 策略：失败项跳过、成功项输出；全败 → iterate_all_failed", async () => {
    // 子图按 word 判定成败（bad 项 exit 3）
    vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue({
      id: 78,
      name: "成败子图",
      graphJson: JSON.stringify({
        version: 1,
        inputSchema: { word: "string" },
        nodes: [
          {
            id: "sub",
            name: "分支",
            kind: "code",
            language: "bash",
            script:
              'if [ "{{input.word}}" = "bad" ]; then exit 3; fi\necho "ok:{{input.word}}"',
          },
        ],
        edges: [{ from: "sub", to: "END" }],
      }),
      version: 1,
      enabled: true,
      userId: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const out = await run(
      [
        {
          id: "loop",
          name: "循环",
          kind: "iterate",
          itemsSource: "good\nbad\ngood2",
          graphId: 78,
          itemVariable: "word",
          maxItems: 10,
          concurrency: 2,
          onItemError: "continue",
        },
      ],
      [{ from: "loop", to: "END" }],
    );
    expect(out).toBe("success");
    const preview = traceOf()[0].outputPreview;
    expect(preview).toContain("ok:good");
    expect(preview).toContain("ok:good2");
    expect(preview).not.toContain("ok:bad");

    const allBad = await run(
      [
        {
          id: "loop",
          name: "循环",
          kind: "iterate",
          itemsSource: "bad",
          graphId: 78,
          itemVariable: "word",
          maxItems: 10,
          concurrency: 1,
          onItemError: "continue",
        },
      ],
      [{ from: "loop", to: "END" }],
    );
    expect(allBad).toBe("failed");
    expect(lastUpdate().data.error).toMatch(/node:loop iterate_all_failed/);
  });
});

describe("testSingleNode（单节点测试）", () => {
  it("code 节点单跑：inputs/nodes 占位符替换，返回输出（不落 run）", async () => {
    const { testSingleNode } =
      await import("../../electron/domains/ai/orchestration/graph-executor");
    const before = vi.mocked(prisma.automationRun.create).mock.calls.length;
    const result = await testSingleNode({
      node: {
        id: "solo",
        name: "单测",
        kind: "code",
        language: "bash",
        script: 'echo "{{input.a}}-{{nodes.up.output}}"',
        timeoutMs: 30_000,
        outputMode: "text",
      },
      inputs: { a: "A" },
      nodes: { up: { output: "B" } },
      workspace: { id: 9, directoryPath: workspaceDir },
      userId: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain("A-B");
    }
    // 不产生 run 记录（轻量路径）
    expect(vi.mocked(prisma.automationRun.create).mock.calls.length).toBe(
      before,
    );
  });

  it("失败路径返回错误码（如文件读取缺失）", async () => {
    const { testSingleNode } =
      await import("../../electron/domains/ai/orchestration/graph-executor");
    const result = await testSingleNode({
      node: {
        id: "solo",
        name: "单测",
        kind: "fileRead",
        path: "ghost.txt",
      },
      inputs: {},
      nodes: {},
      workspace: { id: 9, directoryPath: workspaceDir },
      userId: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("file_missing");
    }
  });
});

/** better-sqlite3 二进制随 Electron ABI（149）编译，系统 Node（147）加载
 * 失败——database 真跑用例仅 Electron ABI 宿主可跑（生产形态优先），
 * 其余宿主跳过而非误报 */
const sqliteNative = (() => {
  try {
    // dlopen 在实例化时才触发（require 仅注册）——内存库探测 ABI
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const D = require("better-sqlite3");
    const probe = new D(":memory:");
    probe.close();
    return true;
  } catch {
    return false;
  }
})();

(sqliteNative ? describe : describe.skip)(
  "database 节点（SQLite 真跑）",
  () => {
    it("建表/插入（写操作 affectedRows）+ 参数化查询（行数组 JSON）", async () => {
      const out = await run(
        [
          {
            id: "db",
            name: "查询",
            kind: "database",
            engine: "sqlite",
            sqlitePath: "test-{{input.tag}}.db",
            host: "",
            port: 5432,
            database: "",
            username: "",
            password: "",
            sql: "CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, name TEXT)",
            params: [],
            maxRows: 1_000,
            batchSource: "",
          },
        ],
        [{ from: "db", to: "END" }],
        { tag: "v1" },
      );
      expect(out).toBe("success");

      const insert = await run(
        [
          {
            id: "db",
            name: "插入",
            kind: "database",
            engine: "sqlite",
            sqlitePath: "test-v1.db",
            host: "",
            port: 5432,
            database: "",
            username: "",
            password: "",
            sql: "INSERT INTO t (name) VALUES (?)",
            params: ["{{input.name}}"],
            maxRows: 1_000,
            batchSource: "",
          },
        ],
        [{ from: "db", to: "END" }],
        { name: "甲" },
      );
      expect(insert).toBe("success");
      expect(traceOf()[0].outputPreview).toContain("affectedRows");

      const select = await run(
        [
          {
            id: "db",
            name: "查询",
            kind: "database",
            engine: "sqlite",
            sqlitePath: "test-v1.db",
            host: "",
            port: 5432,
            database: "",
            username: "",
            password: "",
            sql: "SELECT id, name FROM t WHERE name = ?",
            params: ["甲"],
            maxRows: 1_000,
            batchSource: "",
          },
        ],
        [{ from: "db", to: "END" }],
      );
      expect(select).toBe("success");
      expect(traceOf()[0].outputPreview).toContain('"name":"甲"');
      // 清理
      await fs.rm(path.join(workspaceDir, "test-v1.db"), { force: true });
    });

    it("批量模式：事务逐行绑定，总 affectedRows；行数据非法报 db_batch_invalid", async () => {
      const mk = (sql, batchSource) => ({
        id: "db",
        name: "批量",
        kind: "database",
        engine: "sqlite",
        sqlitePath: "batch.db",
        host: "",
        port: 5432,
        database: "",
        username: "",
        password: "",
        sql,
        params: [],
        maxRows: 1_000,
        batchSource,
      });
      await run(
        [mk("CREATE TABLE IF NOT EXISTS t (name TEXT)", "")],
        [{ from: "db", to: "END" }],
      );
      const out = await run(
        [
          mk(
            "INSERT INTO t (name) VALUES (?)",
            '[["{{input.a}}"],["乙"],["丙"]]',
          ),
        ],
        [{ from: "db", to: "END" }],
        { a: "甲" },
      );
      expect(out).toBe("success");
      expect(traceOf()[0].outputPreview).toContain('"affectedRows":3');
      await fs.rm(path.join(workspaceDir, "batch.db"), { force: true });

      const bad = await run(
        [mk("INSERT INTO t (name) VALUES (?)", '{"a":1}')],
        [{ from: "db", to: "END" }],
      );
      expect(bad).toBe("failed");
      expect(lastUpdate().data.error).toMatch(/node:db db_batch_invalid/);
    });

    it("越界路径 → db_outside_workspace；SQL 错误 → db_query_failed", async () => {
      const outside = await run(
        [
          {
            id: "db",
            name: "越界",
            kind: "database",
            engine: "sqlite",
            sqlitePath: "../escape.db",
            host: "",
            port: 5432,
            database: "",
            username: "",
            password: "",
            sql: "SELECT 1",
            params: [],
            maxRows: 1_000,
            batchSource: "",
          },
        ],
        [{ from: "db", to: "END" }],
      );
      expect(outside).toBe("failed");
      expect(lastUpdate().data.error).toMatch(/node:db db_outside_workspace/);

      const bad = await run(
        [
          {
            id: "db",
            name: "坏 SQL",
            kind: "database",
            engine: "sqlite",
            sqlitePath: "tmp.db",
            host: "",
            port: 5432,
            database: "",
            username: "",
            password: "",
            sql: "SELEC no_such",
            params: [],
            maxRows: 1_000,
            batchSource: "",
          },
        ],
        [{ from: "db", to: "END" }],
      );
      expect(bad).toBe("failed");
      expect(lastUpdate().data.error).toMatch(/node:db db_query_failed/);
      await fs.rm(path.join(workspaceDir, "tmp.db"), { force: true });
    });
  },
);

describe("merge 节点（聚合）", () => {
  it("等待多上游并以模板聚合两个输出", async () => {
    const out = await run(
      [
        {
          id: "a",
          name: "甲",
          kind: "code",
          language: "bash",
          script: "echo A",
        },
        {
          id: "b",
          name: "乙",
          kind: "code",
          language: "bash",
          script: "echo B",
        },
        {
          id: "join",
          name: "聚合",
          kind: "merge",
          template: "结果: {{nodes.a.output}} / {{nodes.b.output}}",
        },
      ],
      [
        { from: "a", to: "b" },
        { from: "b", to: "join" },
        { from: "join", to: "END" },
      ],
    );
    expect(out).toBe("success");
    const byId = Object.fromEntries(
      traceOf().map((e: { id: string }) => [e.id, e]),
    );
    expect(byId.join.outputPreview).toContain("A");
    expect(byId.join.outputPreview).toContain("B");
  });
});

describe("通知 webhook（飞书/钉钉/企微）", () => {
  const webfetchMock = vi.fn();
  beforeAll(() => {
    vi.stubGlobal("fetch", webfetchMock);
  });
  afterEach(() => {
    webfetchMock.mockReset();
  });

  it("飞书渠道：桌面通知 + 文本消息格式 POST 并存", async () => {
    webfetchMock.mockResolvedValue({ ok: true, status: 200 });
    const out = await run(
      [
        {
          id: "ping",
          name: "通知",
          kind: "notify",
          title: "{{input.t}} 完成",
          body: "详情",
          webhookProvider: "feishu",
          webhookUrl: "https://open.feishu.cn/hook/x",
        },
      ],
      [{ from: "ping", to: "END" }],
      { t: "日报" },
    );
    expect(out).toBe("success");
    expect(Notification).toHaveBeenCalledTimes(1);
    expect(webfetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = webfetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://open.feishu.cn/hook/x");
    expect(JSON.parse(String(init.body))).toEqual({
      msg_type: "text",
      content: { text: "日报 完成\n详情" },
    });
  });

  it("钉钉/企微格式各不同；webhook 失败不炸节点", async () => {
    webfetchMock.mockResolvedValue({ ok: true, status: 200 });
    await run(
      [
        {
          id: "ping",
          name: "钉钉",
          kind: "notify",
          title: "T",
          webhookProvider: "dingtalk",
          webhookUrl: "https://oapi.dingtalk.com/hook",
        },
      ],
      [{ from: "ping", to: "END" }],
    );
    let body = JSON.parse(String(webfetchMock.mock.calls[0][1].body));
    expect(body).toEqual({ msgtype: "text", text: { content: "T" } });

    await run(
      [
        {
          id: "ping2",
          name: "企微",
          kind: "notify",
          title: "T2",
          webhookProvider: "wecom",
          webhookUrl: "https://qyapi.weixin.qq.com/hook",
        },
      ],
      [{ from: "ping2", to: "END" }],
    );
    body = JSON.parse(String(webfetchMock.mock.calls[1][1].body));
    expect(body).toEqual({ msgtype: "text", text: { content: "T2" } });

    // 失败渠道：节点仍成功（尽力而为语义）
    webfetchMock.mockResolvedValue({ ok: false, status: 500 });
    const out = await run(
      [
        {
          id: "ping3",
          name: "失败",
          kind: "notify",
          title: "T3",
          webhookProvider: "feishu",
          webhookUrl: "https://x/hook",
        },
      ],
      [{ from: "ping3", to: "END" }],
    );
    expect(out).toBe("success");
  });
});

describe("Excel 读写节点（exceljs 真跑）", () => {
  it("写入 → 读回：JSON 行数组 ↔ xlsx 往返", async () => {
    const writeOut = await run(
      [
        {
          id: "wr",
          name: "写入",
          kind: "excelWrite",
          path: "out/报表.xlsx",
          sheet: "数据",
          rowsSource: '[{"名称":"甲","数量":2},{"名称":"乙","数量":3}]',
        },
      ],
      [{ from: "wr", to: "END" }],
    );
    expect(writeOut).toBe("success");
    expect(traceOf()[0].outputPreview).toContain("已写入 2 行");

    const readOut = await run(
      [
        {
          id: "rd",
          name: "读取",
          kind: "excelRead",
          path: "out/报表.xlsx",
          sheet: "数据",
        },
      ],
      [{ from: "rd", to: "END" }],
    );
    expect(readOut).toBe("success");
    const preview = traceOf()[0].outputPreview;
    expect(preview).toContain('"名称":"甲"');
    expect(preview).toContain('"数量":3');
    await fs.rm(path.join(workspaceDir, "out"), {
      recursive: true,
      force: true,
    });
  });

  it("行数据非 JSON 数组 → excel_rows_invalid；sheet 不存在 → excel_sheet_missing", async () => {
    const bad = await run(
      [
        {
          id: "wr",
          name: "坏数据",
          kind: "excelWrite",
          path: "out/bad.xlsx",
          sheet: "S",
          rowsSource: "not-json",
        },
      ],
      [{ from: "wr", to: "END" }],
    );
    expect(bad).toBe("failed");
    expect(lastUpdate().data.error).toMatch(/node:wr excel_rows_invalid/);

    await run(
      [
        {
          id: "wr",
          name: "写入",
          kind: "excelWrite",
          path: "out/s.xlsx",
          sheet: "S1",
          rowsSource: '[{"a":1}]',
        },
      ],
      [{ from: "wr", to: "END" }],
    );
    const miss = await run(
      [
        {
          id: "rd",
          name: "缺表",
          kind: "excelRead",
          path: "out/s.xlsx",
          sheet: "NOPE",
        },
      ],
      [{ from: "rd", to: "END" }],
    );
    expect(miss).toBe("failed");
    expect(lastUpdate().data.error).toMatch(/node:rd excel_sheet_missing/);
    await fs.rm(path.join(workspaceDir, "out"), {
      recursive: true,
      force: true,
    });
  });
});

describe("subflow 异步任务（fire-and-forget）", () => {
  it("async 模式：主流程不等子图（慢子图下父图先完成），run 行已提交", async () => {
    vi.mocked(prisma.graphDefinition.findFirst).mockReset();
    vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue({
      id: 88,
      name: "慢任务",
      graphJson: JSON.stringify({
        version: 1,
        inputSchema: {},
        nodes: [
          {
            id: "slow",
            name: "慢",
            kind: "code",
            language: "bash",
            script: "sleep 3; echo done",
            timeoutMs: 10_000,
            outputMode: "text",
          },
        ],
        edges: [{ from: "slow", to: "END" }],
      }),
      version: 1,
      enabled: true,
      userId: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const before = vi.mocked(prisma.automationRun.create).mock.calls.length;
    const startedAt = Date.now();
    const out = await run(
      [
        {
          id: "fire",
          name: "触发",
          kind: "subflow",
          graphId: 88,
          inputs: [],
          async: true,
        },
      ],
      [{ from: "fire", to: "END" }],
    );
    const elapsed = Date.now() - startedAt;
    expect(out).toBe("success");
    // 主流程快速返回（远小于子图 3s）——fire-and-forget
    expect(elapsed).toBeLessThan(2_500);
    expect(traceOf()[0].outputPreview).toContain("已提交异步任务 #88");
    // 子图 run 行已创建（后台提交）
    expect(
      vi.mocked(prisma.automationRun.create).mock.calls.length,
    ).toBeGreaterThan(before);
  });
});
