// tests/ai/graph-executor.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`) },
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    // 去会话化：session/message 两键已删——executor 不再触碰两表，
    // 残留调用会以 undefined 崩掉被用例捕获
    automationRun: { create: vi.fn(async () => ({ id: 9 })), update: vi.fn() },
    automationTask: { update: vi.fn() },
    // 节点模型解析（modelId → provider/baseUrl）；createChatModel 已 mock，
    // 这里只需行存在
    model: {
      findUnique: vi.fn(async () => ({
        id: 1,
        providerId: 2,
        modelId: "test-model",
      })),
    },
    provider: {
      findUnique: vi.fn(async () => ({
        id: 2,
        type: "openai-compatible",
        baseUrl: "http://localhost:9",
        apiKey: "k",
        extraHeaders: null,
      })),
    },
    // 节点详情行（去会话化：writeNodeRecord/writeNodeFailureRecord 落此；
    // 环图重入 upsert 聚合一行，mock 只需 upsert 键）
    graphRunNode: { upsert: vi.fn(async () => ({ id: 1 })) },
  },
}));
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../electron/domains/ai/agent/skill-loader", () => ({
  loadSkills: vi.fn(() => []),
}));

const modelMock = { invoke: vi.fn() };
vi.mock(
  "../../electron/domains/ai/orchestration/langchain-model-factory",
  () => ({
    createChatModel: vi.fn(() => modelMock),
  }),
);
// tools 节点走 prebuilt react agent（本组用例无 tools 节点，mock 防真实依赖）。
// ToolNode 同模块导出须一并 mock（run-chat-stream 的 AliasToolNode 引用）
vi.mock("@langchain/langgraph/prebuilt", () => ({
  createReactAgent: vi.fn(() => ({
    invoke: async () => ({
      content: "agent-done",
      usage_metadata: { input_tokens: 3, output_tokens: 5 },
    }),
  })),
  ToolNode: class MockToolNode {
    tools: unknown[] = [];
  },
}));

import prisma from "../../electron/commons/prisma-client";
import {
  executeGraphRun,
  runGraphToResult,
} from "../../electron/domains/ai/orchestration/graph-executor";
import { createChatModel } from "../../electron/domains/ai/orchestration/langchain-model-factory";
import { compileStateGraph } from "../../electron/domains/ai/orchestration/graph-compiler";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

const graph = {
  id: 5,
  name: "demo",
  graphJson: JSON.stringify({
    version: 1,
    inputSchema: { topic: "string" },
    nodes: [
      {
        id: "research",
        name: "调研",
        kind: "llm",
        modelId: 1,
        prompt: "调研 {{input.topic}}",
        temperature: 0.7,
        tools: false,
        outputMode: "branch",
        branchOptions: ["go", "stop"],
      },
      {
        id: "report",
        name: "成文",
        kind: "llm",
        modelId: 1,
        prompt: "基于 {{nodes.research.output}} 成文",
        tools: false,
        outputMode: "text",
      },
    ],
    edges: [
      {
        from: "research",
        to: "report",
        condition: { type: "branch", value: "go" },
      },
      {
        from: "research",
        to: "END",
        condition: { type: "branch", value: "stop" },
      },
      { from: "report", to: "END" },
    ],
  }),
  version: 1,
  enabled: true,
  userId: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
} as never;

const runParams = (inputs: Record<string, string>) => ({
  graph,
  task: null,
  inputs,
  triggerType: "manual" as const,
  attempt: 1,
  abort: new AbortController().signal,
  workspace: { id: 9, directoryPath: null },
});

/** graphRunNode.upsert 调用参数视图（去会话化后的节点详情行——create
 * 载荷即行数据；环图重入聚合一行）；from 截取本用例新增段（mock.calls
 * 跨用例累积） */
const nodeRows = (from = 0) =>
  vi
    .mocked(prisma.graphRunNode.upsert)
    .mock.calls.slice(from)
    .map(
      (c) => c[0].create as { nodeId: string; input: string; output: string },
    );

/** tools+branch 组合图（内置模板 daily-brief-branch 的 collect 节点即此形态） */
const toolsGraph = {
  ...graph,
  graphJson: JSON.stringify({
    version: 1,
    inputSchema: { topic: "string" },
    nodes: [
      {
        id: "collect",
        name: "收集",
        kind: "llm",
        modelId: 1,
        prompt: "汇总 {{input.topic}} 要点",
        tools: true,
        outputMode: "branch",
        branchOptions: ["go", "stop"],
      },
      {
        id: "report",
        name: "成文",
        kind: "llm",
        modelId: 1,
        prompt: "基于 {{nodes.collect.output}} 成文",
        tools: false,
        outputMode: "text",
      },
    ],
    edges: [
      {
        from: "collect",
        to: "report",
        condition: { type: "branch", value: "go" },
      },
      {
        from: "collect",
        to: "END",
        condition: { type: "branch", value: "stop" },
      },
      { from: "report", to: "END" },
    ],
  }),
} as never;

const runToolsParams = (inputs: Record<string, string>) => ({
  ...runParams(inputs),
  graph: toolsGraph,
});

/** start 节点图（T6 schema 新形态）：start 为唯一入口 + 下游 llm 直连 END */
const startGraph = {
  ...graph,
  graphJson: JSON.stringify({
    version: 1,
    inputSchema: { topic: "string" },
    nodes: [
      { id: "start", name: "开始", kind: "start", variables: ["topic"] },
      {
        id: "report",
        name: "成文",
        kind: "llm",
        modelId: 1,
        prompt: "汇总 {{input.topic}} 要点",
        tools: false,
        outputMode: "text",
      },
    ],
    edges: [
      { from: "start", to: "report" },
      { from: "report", to: "END" },
    ],
  }),
} as never;

/** 环图（回边设计内形态：validateGraph 不查回边，recursionLimit 兜底）：
 * intro 入口 → loop（branch：go 走回边、stop 收口）→ back 条件回边回
 * loop——loop 两轮执行，同 (runId, nodeId) 节点详情行聚合 */
const cyclicGraph = {
  ...graph,
  graphJson: JSON.stringify({
    version: 1,
    inputSchema: { topic: "string" },
    nodes: [
      {
        id: "intro",
        name: "开场",
        kind: "llm",
        modelId: 1,
        prompt: "开场 {{input.topic}}",
        tools: false,
        outputMode: "text",
      },
      {
        id: "loop",
        name: "循环判定",
        kind: "llm",
        modelId: 1,
        prompt: "判定 {{nodes.intro.output}}",
        tools: false,
        outputMode: "branch",
        branchOptions: ["go", "stop"],
      },
      {
        id: "back",
        name: "回边",
        kind: "llm",
        modelId: 1,
        prompt: "补充 {{nodes.loop.output}}",
        tools: false,
        outputMode: "text",
      },
    ],
    edges: [
      { from: "intro", to: "loop" },
      { from: "loop", to: "back", condition: { type: "branch", value: "go" } },
      { from: "loop", to: "END", condition: { type: "branch", value: "stop" } },
      { from: "back", to: "loop" },
    ],
  }),
} as never;

describe("executeGraphRun", () => {
  it("分支 go：两节点执行，graphTrace 落 success，模板引用上游输出", async () => {
    modelMock.invoke
      .mockResolvedValueOnce({ branch: "go" }) // research 结构化输出
      .mockResolvedValueOnce({ content: "最终报告" }); // report 文本
    const out = await executeGraphRun(runParams({ topic: "AI" }));
    expect(out).toBe("success");
    // 去会话化：全程零 session/message 写入（mock 已删两键，此处显式
    // 断言兜底防回归）
    expect(prisma.session?.create).toBeUndefined();
    expect(prisma.message?.create).toBeUndefined();
    const update = vi.mocked(prisma.automationRun.update).mock.calls[0][0];
    const trace = JSON.parse(update.data.graphTrace as string);
    expect(trace).toHaveLength(2);
    expect(trace[1].status).toBe("success");
    // 节点详情落 graphRunNode：research 行 output=路由标签；report 行
    // input 引用了 research 输出（渲染后 prompt「基于 go 成文」）
    const rows = nodeRows();
    expect(rows.find((r) => r.nodeId === "research")?.output).toBe("go");
    expect(rows.find((r) => r.nodeId === "report")?.input).toContain(
      "基于 go 成文",
    );
  });
  it("节点 LLM 失败：run failed，error 含 node:<id> 与分类码，后续节点 skipped", async () => {
    modelMock.invoke.mockRejectedValueOnce(new Error("network down"));
    const out = await executeGraphRun(runParams({ topic: "AI" }));
    expect(out).toBe("failed");
    const update = vi.mocked(prisma.automationRun.update).mock.calls.at(-1)![0];
    expect(update.data.error).toMatch(/^node:research /);
    const trace = JSON.parse(update.data.graphTrace as string);
    expect(trace.find((t: { id?: string }) => t.id === "research").status).toBe(
      "failed",
    );
  });
  it("节点 temperature 端到端透传到 createChatModel 第三参", async () => {
    vi.mocked(createChatModel).mockClear();
    modelMock.invoke
      .mockResolvedValueOnce({ branch: "go" })
      .mockResolvedValueOnce({ content: "最终报告" });
    const out = await executeGraphRun(runParams({ topic: "AI" }));
    expect(out).toBe("success");
    const calls = vi.mocked(createChatModel).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][2]).toEqual({ temperature: 0.7 }); // research 节点显式 temperature
    expect(calls[1][2]).toEqual({ temperature: undefined }); // report 节点未设置走默认
  });
  it("非法 graphJson：run failed(graph_invalid)", async () => {
    const bad = { ...graph, graphJson: "{oops" } as never;
    const out = await executeGraphRun({ ...runParams({}), graph: bad });
    expect(out).toBe("failed");
    expect(
      vi.mocked(prisma.automationRun.update).mock.calls.at(-1)![0].data.error,
    ).toContain("graph_invalid");
  });
  it("tools+branch 组合：agent 终局消息解出标签写 route，走命中分支", async () => {
    // agent 终局 content 为 JSON 串（真实模型形态）；捕获入参消息断言
    // branch 提示词已追加（tools 节点此前完全忽略 branch——静默走 fallback）
    let agentPrompt = "";
    vi.mocked(createReactAgent).mockImplementationOnce((() => ({
      invoke: async (input: { messages: Array<{ content: string }> }) => {
        agentPrompt = input.messages.at(-1)?.content ?? "";
        return { messages: [{ content: '{"branch":"go"}' }] };
      },
    })) as never);
    modelMock.invoke.mockResolvedValueOnce({ content: "最终报告" }); // report
    const out = await executeGraphRun(runToolsParams({ topic: "AI" }), {
      createChatModel,
      toLangChainTools: vi.fn(() => []),
      compileStateGraph,
    });
    expect(out).toBe("success");
    expect(agentPrompt).toContain('请只输出一个 JSON 对象 {"branch"');
    const update = vi.mocked(prisma.automationRun.update).mock.calls.at(-1)![0];
    const trace = JSON.parse(update.data.graphTrace as string);
    expect(trace).toHaveLength(2); // collect + report，route=go 命中 collect→report
    expect(trace[0]).toMatchObject({ id: "collect", status: "success" });
    expect(trace[0].outputPreview).toBe("go"); // output=route=标签
    expect(trace[1]).toMatchObject({ id: "report", status: "success" });
    // report 渲染时引用了 collect 输出（report 行 input 含「基于 go 成文」）
    expect(nodeRows().find((r) => r.nodeId === "report")?.input).toContain(
      "基于 go 成文",
    );
  });
  it("start 节点执行直通：不写 output、不产生失败，下游照常执行", async () => {
    modelMock.invoke.mockResolvedValueOnce({ content: "最终报告" }); // report
    const result = await runGraphToResult({
      ...runParams({ topic: "AI" }),
      graph: startGraph,
    });
    expect(result.status).toBe("success");
    expect(result.nodeOutputs?.start).toBeUndefined();
    expect(result.nodeOutputs?.report).toBe("最终报告");
    // start 是参数载体非执行节点：trace 不补 skipped 条目（恒显噪音）
    const update = vi.mocked(prisma.automationRun.update).mock.calls.at(-1)![0];
    const trace = JSON.parse(update.data.graphTrace as string);
    expect(trace.map((t: { id: string }) => t.id)).toEqual(["report"]);
  });
});

describe("llm 节点异常处理（超时/重试/降级）", () => {
  const llmGraph = (extra: Record<string, unknown>) => ({
    graph: {
      id: 5,
      name: "retry-demo",
      graphJson: JSON.stringify({
        version: 1,
        inputSchema: {},
        nodes: [
          {
            id: "think",
            name: "思考",
            kind: "llm",
            modelId: 1,
            prompt: "p",
            tools: false,
            outputMode: "text",
            ...extra,
          },
        ],
        edges: [{ from: "think", to: "END" }],
      }),
      version: 1,
      enabled: true,
      userId: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never,
    task: null,
    inputs: {},
    triggerType: "manual" as const,
    attempt: 1,
    abort: new AbortController().signal,
    workspace: { id: 9, directoryPath: null },
  });

  const runUpdate = () =>
    vi.mocked(prisma.automationRun.update).mock.calls.at(-1)![0];

  it("重试后成功：首调失败次调成功 → run success 且模型调用 2 次", async () => {
    modelMock.invoke.mockReset();
    modelMock.invoke
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ content: "ok-after-retry" });
    const out = await executeGraphRun(llmGraph({ retries: 1 }));
    expect(out).toBe("success");
    expect(modelMock.invoke).toHaveBeenCalledTimes(2);
    const trace = JSON.parse(runUpdate().data.graphTrace as string);
    expect(trace[0]).toMatchObject({ id: "think", status: "success" });
    expect(trace[0].outputPreview).toContain("ok-after-retry");
  });

  it("onError=defaultValue：重试耗尽仍失败 → 以默认输出继续，trace 带 fallback", async () => {
    modelMock.invoke.mockReset();
    modelMock.invoke.mockRejectedValue(new Error("always down"));
    const out = await executeGraphRun(
      llmGraph({
        retries: 1,
        onError: "defaultValue",
        errorOutput: "兜底文案",
      }),
    );
    expect(out).toBe("success");
    expect(modelMock.invoke).toHaveBeenCalledTimes(2);
    const trace = JSON.parse(runUpdate().data.graphTrace as string);
    expect(trace[0]).toMatchObject({ id: "think", status: "success" });
    expect(trace[0].outputPreview).toBe("兜底文案");
    expect(typeof trace[0].fallback.code).toBe("string");
  });

  it("onError=abort（默认）：重试耗尽 → run failed，错误码归因节点", async () => {
    modelMock.invoke.mockReset();
    modelMock.invoke.mockRejectedValue(new Error("always down"));
    const out = await executeGraphRun(llmGraph({ retries: 1 }));
    expect(out).toBe("failed");
    expect(modelMock.invoke).toHaveBeenCalledTimes(2);
    expect(runUpdate().data.error).toMatch(/node:think/);
  });

  it("整体执行超时：invoke 随 abort 信号中断 → llm_timeout 失败", async () => {
    modelMock.invoke.mockReset();
    // 模拟真实模型调用对 signal 的响应：挂起直至 abort
    modelMock.invoke.mockImplementation(
      (_messages: unknown, opts?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener(
            "abort",
            () => reject(new Error("This operation was aborted")),
            { once: true },
          );
        }) as never,
    );
    const out = await executeGraphRun(llmGraph({ timeoutMs: 1_000 }));
    expect(out).toBe("failed");
    expect(runUpdate().data.error).toMatch(/node:think llm_timeout/);
  }, 10_000);

  /** 模型挂起直至信号中止（AbortError 形态对齐真实运行时） */
  const hangUntilAbort = () => {
    modelMock.invoke.mockImplementation(
      (_messages: unknown, opts?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("This operation was aborted"), {
                  name: "AbortError",
                }),
              ),
            { once: true },
          );
        }) as never,
    );
  };

  it("图中止（cancelTestRun 触发 params.abort，reason=USER_CANCELLED）→ run failed 且 error 归一 user_aborted", async () => {
    modelMock.invoke.mockReset();
    const ctrl = new AbortController();
    // 模型挂起直至图中止：cancelTestRun abort 的是 params.abort（区别于
    // 节点超时的内部 timeout 信号——那条路径归一 llm_timeout 不受影响）
    hangUntilAbort();
    const pending = executeGraphRun({ ...llmGraph({}), abort: ctrl.signal });
    await new Promise((r) => setTimeout(r, 20));
    ctrl.abort(new Error("USER_CANCELLED"));
    const out = await pending;
    expect(out).toBe("failed");
    // finishRun 落库：error 归一 user_aborted（无 node 前缀）
    expect(runUpdate().data.error).toBe("user_aborted: 已被用户中断");
  }, 10_000);

  it("无 reason 的普通 abort（webhook 同步超时/调度 stop）→ 不归一 user_aborted，走原 toRunError", async () => {
    modelMock.invoke.mockReset();
    const ctrl = new AbortController();
    hangUntilAbort();
    const pending = executeGraphRun({ ...llmGraph({}), abort: ctrl.signal });
    await new Promise((r) => setTimeout(r, 20));
    ctrl.abort(); // 无 reason —— webhook SYNC_TIMEOUT / scheduler stop 的形态
    const out = await pending;
    expect(out).toBe("failed");
    // 不落 user_aborted，错误归因节点（原 toRunError 路径）
    expect(runUpdate().data.error).not.toContain("user_aborted");
    expect(runUpdate().data.error).toMatch(/node:think/);
  }, 10_000);

  it("agent 工具步的 abortSignal 含节点超时（timeoutMs 到即中断工具）", async () => {
    modelMock.invoke.mockReset();
    let toolSignal: AbortSignal | undefined;
    const deps = {
      createChatModel,
      // 捕获注入工具步的 abortSignal：工具执行应随节点超时信号一并中断
      toLangChainTools: vi.fn(
        (
          _defs: unknown,
          _agent: unknown,
          opts: { abortSignal?: AbortSignal },
        ) => {
          toolSignal = opts.abortSignal;
          return [];
        },
      ) as never,
      compileStateGraph,
    };
    // agent 挂起直至超时信号（工具节点不走 modelMock.invoke，挂起锚点
    // 在 agent.invoke 的 signal——节点超时归一 llm_timeout 的既有路径）
    vi.mocked(createReactAgent).mockImplementationOnce((() => ({
      invoke: (_input: unknown, opts?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener(
            "abort",
            () => reject(new Error("This operation was aborted")),
            { once: true },
          );
        }),
    })) as never);
    const pending = executeGraphRun(
      llmGraph({ tools: true, timeoutMs: 1_000 }),
      deps,
    );
    await new Promise((r) => setTimeout(r, 1_500));
    expect(toolSignal?.aborted).toBe(true);
    const out = await pending;
    expect(out).toBe("failed");
    expect(runUpdate().data.error).toMatch(/node:think llm_timeout/);
  }, 10_000);
});

describe("图执行留痕去会话化", () => {
  it("全程零 session/message 写入，节点行落 graphRunNode", async () => {
    modelMock.invoke.mockReset();
    modelMock.invoke
      .mockResolvedValueOnce({ branch: "go" }) // research 结构化输出
      .mockResolvedValueOnce({ content: "最终报告" }); // report 文本
    const writesBefore = vi.mocked(prisma.graphRunNode.upsert).mock.calls
      .length;
    const result = await runGraphToResult(runParams({ topic: "x" }));
    expect(result.status).toBe("success");
    const prismaMock = vi.mocked(prisma);
    // 会话/消息零写入（mock 已删两键，此处断言兜底防回归）
    expect(prismaMock.session?.create).toBeUndefined();
    expect(prismaMock.message?.create).toBeUndefined();
    // 节点行：research 节点一条 success，input 为渲染后 prompt
    const research = nodeRows(writesBefore).find(
      (r) => r.nodeId === "research",
    );
    expect(research).toBeDefined();
    expect(research).toMatchObject({
      runId: 9,
      status: "success",
      input: "调研 x",
      output: "go",
    });
  });

  it("单节点测试不建会话：返回值照常", async () => {
    const { testSingleNode } =
      await import("../../electron/domains/ai/orchestration/graph-executor");
    const writesBefore = vi.mocked(prisma.graphRunNode.upsert).mock.calls
      .length;
    const res = await testSingleNode({
      node: {
        id: "n1",
        name: "代码",
        kind: "code",
        language: "nodejs",
        script: "console.log(1+1)",
      },
      inputs: {},
      nodes: {},
      workspace: { id: 1, directoryPath: null },
      userId: 1,
    });
    expect(res.ok).toBe(true);
    // 即席执行不留痕：零 session（键已删）且不落节点详情行
    expect(prisma.session?.create).toBeUndefined();
    expect(vi.mocked(prisma.graphRunNode.upsert).mock.calls.length).toBe(
      writesBefore,
    );
  });

  it("环图重入：同 nodeId 两轮执行 upsert 聚合一行（最后一轮为准），run 不因唯一约束失败", async () => {
    modelMock.invoke.mockReset();
    modelMock.invoke
      .mockResolvedValueOnce({ content: "开场白" }) // intro 入口
      .mockResolvedValueOnce({ branch: "go" }) // loop 第一轮 → 条件回边
      .mockResolvedValueOnce({ content: "补充材料" }) // back 回边节点
      .mockResolvedValueOnce({ branch: "stop" }); // loop 第二轮 → END
    const writesBefore = vi.mocked(prisma.graphRunNode.upsert).mock.calls
      .length;
    const out = await executeGraphRun({
      ...runParams({ topic: "AI" }),
      graph: cyclicGraph,
    });
    // 旧 create 实现第二轮 loop 落库撞 (runId, nodeId) UNIQUE 约束 →
    // 节点 handler catch 后失败行再撞，业务结果被吞以晦涩 sqlite 错误收场
    expect(out).toBe("success");
    const loopCalls = vi
      .mocked(prisma.graphRunNode.upsert)
      .mock.calls.slice(writesBefore)
      .filter((c) => c[0].create.nodeId === "loop");
    expect(loopCalls).toHaveLength(2);
    for (const c of loopCalls) {
      expect(c[0].where).toEqual({
        runId_nodeId: { runId: 9, nodeId: "loop" },
      });
      expect(c[0].update).toEqual(c[0].create); // 全量覆盖
    }
    expect(loopCalls[0][0].create.output).toBe("go");
    expect(loopCalls[1][0].create.output).toBe("stop"); // 最后一轮为准
  });
});
