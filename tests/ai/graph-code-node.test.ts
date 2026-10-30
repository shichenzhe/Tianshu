// tests/ai/graph-code-node.test.ts
/**
 * 代码节点（kind:code）执行测试：bash/node 真跑（CI 必有 node，bash 于
 * macOS/Linux 存在，Windows 下 bash 用例 skip）；错误分类纯函数全覆盖
 * （interpreter_missing/timeout/abort/非零退出）；commandGate 门禁拒路径。
 */
import { describe, expect, it, vi, beforeAll } from "vitest";
import { execSync } from "node:child_process";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`) },
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    // 去会话化：节点详情落 graphRunNode（session/message 两键已删）
    graphRunNode: { upsert: vi.fn(async () => ({ id: 1 })) },
    automationRun: { create: vi.fn(async () => ({ id: 9 })), update: vi.fn() },
    automationTask: { update: vi.fn() },
    model: { findUnique: vi.fn() },
    provider: { findUnique: vi.fn() },
  },
}));
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../electron/domains/ai/agent/skill-loader", () => ({
  loadSkills: vi.fn(() => []),
}));
vi.mock("../../electron/domains/security/command-gate", () => ({
  commandGate: vi.fn(() => "default" as const),
}));
vi.mock(
  "../../electron/domains/ai/orchestration/langchain-model-factory",
  () => ({
    createChatModel: vi.fn(),
  }),
);

import prisma from "../../electron/commons/prisma-client";
import { commandGate } from "../../electron/domains/security/command-gate";
import { createChatModel } from "../../electron/domains/ai/orchestration/langchain-model-factory";
import {
  executeGraphRun,
  classifyCodeFailure,
  codeBranchOutcome,
  polishNodePrompt,
} from "../../electron/domains/ai/orchestration/graph-executor";
import { validateGraph } from "../../src-react/domains/ai/orchestration/api/graph.schema";

const hasBash = (() => {
  try {
    execSync("bash -c 'echo ok'", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();
const bashIt = hasBash ? it : it.skip;

const codeGraph = (
  nodes: object[],
  edges: object[],
  inputs: Record<string, string> = {},
) => ({
  graph: {
    id: 5,
    name: "code-demo",
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
  workspace: { id: 9, directoryPath: null },
});

const bashNode = (id: string, script: string, extra: object = {}) => ({
  id,
  name: id,
  kind: "code",
  language: "bash",
  script,
  ...extra,
});

const lastRunUpdate = () =>
  vi.mocked(prisma.automationRun.update).mock.calls.at(-1)![0];

describe("classifyCodeFailure（错误分类纯函数）", () => {
  it("超时 → code_timeout", () => {
    expect(classifyCodeFailure({ timedOut: true })).toBe("code_timeout");
  });
  it("解释器缺失（ENOENT）→ interpreter_missing", () => {
    expect(classifyCodeFailure({ spawnErrorCode: "ENOENT" })).toBe(
      "interpreter_missing",
    );
  });
  it("中止 → aborted", () => {
    expect(classifyCodeFailure({ aborted: true })).toBe("aborted");
  });
  it("非零退出 → code_exit_nonzero；零退出 → null", () => {
    expect(classifyCodeFailure({ exitCode: 3 })).toBe("code_exit_nonzero");
    expect(classifyCodeFailure({ exitCode: 0 })).toBeNull();
  });
});

describe("codeBranchOutcome（分支标签解析纯函数）", () => {
  it("多行 stdout 取末个非空行；命中 → output=route=标签", () => {
    expect(
      codeBranchOutcome(
        { id: "r", branchOptions: ["go", "stop"] },
        "log...\n\ngo\n",
      ),
    ).toEqual({ output: "go", route: "go" });
  });
  it("空 stdout / 未命中 → 抛 branch_parse_error", () => {
    expect(() =>
      codeBranchOutcome({ id: "r", branchOptions: ["go"] }, "\n \n"),
    ).toThrow(/不在分支选项内/);
    expect(() =>
      codeBranchOutcome({ id: "r", branchOptions: ["go"] }, "gox"),
    ).toThrow(/不在分支选项内/);
  });
});

describe("runCodeNode 集成", () => {
  beforeAll(() => {
    vi.mocked(prisma.graphRunNode.upsert).mockClear();
    vi.mocked(prisma.automationRun.update).mockClear();
  });

  it("nodejs 脚本成功：stdout 进节点 output 与详情行落库", async () => {
    const out = await executeGraphRun(
      codeGraph(
        [
          {
            id: "calc",
            name: "计算",
            kind: "code",
            language: "nodejs",
            script: "console.log(21 * 2)",
          },
        ],
        [{ from: "calc", to: "END" }],
      ),
    );
    expect(out).toBe("success");
    const update = lastRunUpdate();
    expect(update.data.status).toBe("success");
    const trace = JSON.parse(update.data.graphTrace as string);
    expect(trace[0]).toMatchObject({ id: "calc", status: "success" });
    expect(trace[0].outputPreview).toContain("42");
    const row = vi.mocked(prisma.graphRunNode.upsert).mock.calls.at(-1)![0];
    expect(row.create.output).toContain("42");
  });

  it("nodejs stdin 注入 {inputs, nodes} JSON", async () => {
    const out = await executeGraphRun(
      codeGraph(
        [
          {
            id: "read",
            name: "读入",
            kind: "code",
            language: "nodejs",
            script:
              "import fs from 'node:fs';const d=JSON.parse(fs.readFileSync(0,'utf8'));console.log('name='+d.inputs.who)",
          },
        ],
        [{ from: "read", to: "END" }],
        { who: "tianshu" },
      ),
    );
    expect(out).toBe("success");
    const trace = JSON.parse(lastRunUpdate().data.graphTrace as string);
    expect(trace[0].outputPreview).toContain("name=tianshu");
  });

  bashIt("bash 脚本模板替换 {{input.x}}", async () => {
    const out = await executeGraphRun(
      codeGraph(
        [bashNode("greet", "echo hello {{input.who}}")],
        [{ from: "greet", to: "END" }],
        { who: "tianshu" },
      ),
    );
    expect(out).toBe("success");
    const trace = JSON.parse(lastRunUpdate().data.graphTrace as string);
    expect(trace[0].outputPreview).toContain("hello tianshu");
  });

  bashIt(
    "code 分支节点：stdout 末行作路由标签，命中分支执行、其余 skipped",
    async () => {
      const out = await executeGraphRun(
        codeGraph(
          [
            bashNode("gate", "echo working; echo go", {
              outputMode: "branch",
              branchOptions: ["go", "stop"],
            }),
            bashNode("go-node", "echo passed-go"),
            bashNode("stop-node", "echo passed-stop"),
          ],
          [
            {
              from: "gate",
              to: "go-node",
              condition: { type: "branch", value: "go" },
            },
            {
              from: "gate",
              to: "stop-node",
              condition: { type: "branch", value: "stop" },
            },
            { from: "go-node", to: "END" },
            { from: "stop-node", to: "END" },
          ],
        ),
      );
      expect(out).toBe("success");
      const trace = JSON.parse(lastRunUpdate().data.graphTrace as string);
      const byId = Object.fromEntries(
        trace.map((entry: { id: string }) => [entry.id, entry]),
      );
      // branch 语义与 llm 一致：output=标签本身
      expect(byId.gate.outputPreview).toBe("go");
      expect(byId["go-node"].status).toBe("success");
      expect(byId["stop-node"].status).toBe("skipped");
    },
  );

  bashIt("code 分支节点末行不命中 → branch_parse_error 节点失败", async () => {
    const out = await executeGraphRun(
      codeGraph(
        [
          bashNode("gate", "echo nope", {
            outputMode: "branch",
            branchOptions: ["go"],
          }),
        ],
        [
          {
            from: "gate",
            to: "END",
            condition: { type: "branch", value: "go" },
          },
        ],
      ),
    );
    expect(out).toBe("failed");
    expect(lastRunUpdate().data.error).toMatch(/node:gate branch_parse_error/);
  });

  bashIt(
    "非零退出 → run failed(code_exit_nonzero) 且 stderr 进错误",
    async () => {
      const out = await executeGraphRun(
        codeGraph(
          [bashNode("boom", "echo boom-detail >&2; exit 3")],
          [{ from: "boom", to: "END" }],
        ),
      );
      expect(out).toBe("failed");
      const update = lastRunUpdate();
      expect(update.data.error).toMatch(/node:boom code_exit_nonzero/);
      // stderr 全貌进 trace error.detail（message 保持短摘要）
      const trace = JSON.parse(update.data.graphTrace as string);
      expect(trace[0].status).toBe("failed");
      expect(trace[0].error.detail).toContain("boom-detail");
    },
  );

  bashIt("超时 → code_timeout（timeoutMs 可调，节点级）", async () => {
    const out = await executeGraphRun(
      codeGraph(
        [bashNode("slow", "sleep 5", { timeoutMs: 1_500 })],
        [{ from: "slow", to: "END" }],
      ),
    );
    expect(out).toBe("failed");
    expect(lastRunUpdate().data.error).toMatch(/node:slow code_timeout/);
  });

  it("解释器被命令门禁拦截 → code_command_blocked", async () => {
    vi.mocked(commandGate).mockReturnValueOnce("block");
    const out = await executeGraphRun(
      codeGraph([bashNode("gated", "echo hi")], [{ from: "gated", to: "END" }]),
    );
    expect(out).toBe("failed");
    expect(lastRunUpdate().data.error).toMatch(
      /node:gated code_command_blocked/,
    );
  });
});

describe("代码节点权限与模板错误（评审 I-1/I-2）", () => {
  it("default 任务：代码节点拒执行（code_permission_denied）", async () => {
    const out = await executeGraphRun({
      ...codeGraph(
        [bashNode("gated", "echo hi")],
        [{ from: "gated", to: "END" }],
      ),
      task: { id: 3, accessMode: "default" } as never,
    });
    expect(out).toBe("failed");
    expect(lastRunUpdate().data.error).toMatch(
      /node:gated code_permission_denied/,
    );
  });

  it("full 任务：代码节点放行", async () => {
    const out = await executeGraphRun({
      ...codeGraph(
        [bashNode("free", "echo ok")],
        [{ from: "free", to: "END" }],
      ),
      task: { id: 3, accessMode: "full" } as never,
    });
    expect(out).toBe("success");
    const trace = JSON.parse(lastRunUpdate().data.graphTrace as string);
    expect(trace[0].outputPreview).toContain("ok");
  });

  bashIt(
    "模板引用未定义变量 → node 归属 template_ref_missing + trace failed",
    async () => {
      const out = await executeGraphRun(
        codeGraph(
          [bashNode("badtpl", "echo {{input.nope}}")],
          [{ from: "badtpl", to: "END" }],
        ),
      );
      expect(out).toBe("failed");
      expect(lastRunUpdate().data.error).toMatch(
        /node:badtpl template_ref_missing/,
      );
      const trace = JSON.parse(lastRunUpdate().data.graphTrace as string);
      expect(trace[0].status).toBe("failed");
    },
  );
});

describe("polishNodePrompt（提示词 AI 润色）", () => {
  it("用指定模型改写并返回文本；系统指令含 {{}} 占位逐字保留约束", async () => {
    vi.mocked(prisma.model.findUnique).mockResolvedValue({
      id: 3,
      providerId: 1,
      modelId: "gpt-x",
    } as never);
    vi.mocked(prisma.provider.findUnique).mockResolvedValue({
      id: 1,
      type: "openai",
      baseUrl: "https://api.test",
      apiKey: "k",
      extraHeaders: null,
    } as never);
    const invoke = vi.fn(async () => ({ content: "润色后 {{input.topic}}" }));
    vi.mocked(createChatModel).mockReturnValue({ invoke } as never);

    const text = await polishNodePrompt(3, "写 {{input.topic}}");

    expect(text).toBe("润色后 {{input.topic}}");
    expect(invoke).toHaveBeenCalledTimes(1);
    const messages = invoke.mock.calls[0][0] as Array<{
      content: string;
    }>;
    // 系统指令约束占位符保留；用户消息透传原文
    expect(String(messages[0].content)).toContain("{{...}}");
    expect(String(messages[1].content)).toBe("写 {{input.topic}}");
  });

  it("模型不存在 → 抛错（model_missing 语义，message 含模型 id）", async () => {
    vi.mocked(prisma.model.findUnique).mockResolvedValue(null);
    await expect(polishNodePrompt(99, "x")).rejects.toThrow(/99/);
  });
});

describe("触发方授权与 runId 回调（webhook 外部触发语义）", () => {
  it("codeAuthorized:false 覆盖 → code 节点拒执行（对齐 default 任务）", async () => {
    const out = await executeGraphRun({
      ...codeGraph(
        [bashNode("nope", "echo secret")],
        [{ from: "nope", to: "END" }],
      ),
      codeAuthorized: false,
    } as never);
    expect(out).toBe("failed");
    const update = lastRunUpdate();
    expect(update.data.error).toContain("code_permission_denied");
    // 门禁拒绝发生在 spawn 之前：无 stdout 产出
    const trace = JSON.parse(update.data.graphTrace as string);
    expect(trace[0].status).toBe("failed");
    expect(trace[0].outputPreview).toBeUndefined();
  });

  it("缺省（不传 codeAuthorized）维持试运行全权语义", async () => {
    const out = await executeGraphRun(
      codeGraph([bashNode("yes", "echo ok")], [{ from: "yes", to: "END" }]),
    );
    expect(out).toBe("success");
  });

  it("onRunId 在 run 行创建后即回调（webhook 异步响应用）", async () => {
    const seen: number[] = [];
    const out = await executeGraphRun({
      ...codeGraph([bashNode("cb", "echo ok")], [{ from: "cb", to: "END" }]),
      onRunId: (runId) => seen.push(runId),
    } as never);
    expect(out).toBe("success");
    expect(seen).toEqual([9]);
  });
});

describe("python 解释器命令（pythonCommand 节点级配置）", () => {
  const pyNode = (id: string, extra: object = {}) => ({
    id,
    name: id,
    kind: "code",
    language: "python",
    script: "print(1)",
    ...extra,
  });

  it("schema：pythonCommand 缺省回填 python，显式 python3 保留，非法值拒绝", () => {
    const base = {
      version: 1,
      inputSchema: {},
      edges: [{ from: "p", to: "END" }],
    };
    const def = validateGraph({ ...base, nodes: [pyNode("p")] });
    expect(def.ok).toBe(true);
    if (def.ok) {
      expect(def.value.nodes[0]).toMatchObject({
        kind: "code",
        pythonCommand: "python",
      });
    }
    const explicit = validateGraph({
      ...base,
      nodes: [pyNode("p", { pythonCommand: "python3" })],
    });
    expect(explicit.ok).toBe(true);
    if (explicit.ok) {
      expect(explicit.value.nodes[0]).toMatchObject({
        pythonCommand: "python3",
      });
    }
    const bad = validateGraph({
      ...base,
      nodes: [pyNode("p", { pythonCommand: "python2" })],
    });
    expect(bad.ok).toBe(false);
  });

  it("门禁入参：缺省 python，pythonCommand=python3 时为 python3（block 拦截，无需本机解释器）", async () => {
    vi.mocked(commandGate).mockReturnValueOnce("block");
    await executeGraphRun(
      codeGraph([pyNode("d1")], [{ from: "d1", to: "END" }]),
    );
    expect(vi.mocked(commandGate).mock.calls.at(-1)![0]).toBe("python");
    expect(lastRunUpdate().data.error).toMatch(/node:d1 code_command_blocked/);

    vi.mocked(commandGate).mockReturnValueOnce("block");
    await executeGraphRun(
      codeGraph(
        [pyNode("d2", { pythonCommand: "python3" })],
        [{ from: "d2", to: "END" }],
      ),
    );
    expect(vi.mocked(commandGate).mock.calls.at(-1)![0]).toBe("python3");
    expect(lastRunUpdate().data.error).toMatch(/node:d2 code_command_blocked/);
  });

  it("pythonCommand 不影响非 python 语言：nodejs 门禁仍收到 node", async () => {
    vi.mocked(commandGate).mockReturnValueOnce("block");
    await executeGraphRun(
      codeGraph(
        [
          {
            id: "n1",
            name: "n1",
            kind: "code",
            language: "nodejs",
            script: "console.log(1)",
            pythonCommand: "python3",
          },
        ],
        [{ from: "n1", to: "END" }],
      ),
    );
    expect(vi.mocked(commandGate).mock.calls.at(-1)![0]).toBe("node");
  });
});

describe("llm 节点 onError=defaultValue 与图中止", () => {
  const llmGraph = (extra: object, abort: AbortSignal) => ({
    graph: {
      id: 5,
      name: "llm-demo",
      graphJson: JSON.stringify({
        version: 1,
        inputSchema: {},
        nodes: [
          {
            id: "ask",
            name: "问答",
            kind: "llm",
            modelId: 1,
            prompt: "hi",
            ...extra,
          },
        ],
        edges: [{ from: "ask", to: "END" }],
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
    abort,
    workspace: { id: 9, directoryPath: null },
  });

  it("调用失败 + onError=default → 以 errorOutput 降级继续（回归）", async () => {
    vi.mocked(prisma.model.findUnique).mockResolvedValue({
      id: 1,
      providerId: 2,
      modelId: "gpt-x",
    } as never);
    vi.mocked(prisma.provider.findUnique).mockResolvedValue({
      id: 2,
      type: "openai",
      baseUrl: "https://api.test",
      apiKey: "k",
      extraHeaders: null,
    } as never);
    vi.mocked(createChatModel).mockReturnValue({
      invoke: vi.fn(async () => {
        throw new Error("boom");
      }),
    } as never);
    const out = await executeGraphRun(
      llmGraph(
        { onError: "defaultValue", errorOutput: "兜底文案" },
        new AbortController().signal,
      ),
    );
    expect(out).toBe("success");
    const trace = JSON.parse(lastRunUpdate().data.graphTrace as string);
    expect(trace[0].status).toBe("success");
    expect(trace[0].fallback).toBeDefined();
  });

  it("图中止（abort 已触发）+ onError=default → 不降级，节点失败", async () => {
    vi.mocked(prisma.model.findUnique).mockResolvedValue({
      id: 1,
      providerId: 2,
      modelId: "gpt-x",
    } as never);
    vi.mocked(prisma.provider.findUnique).mockResolvedValue({
      id: 2,
      type: "openai",
      baseUrl: "https://api.test",
      apiKey: "k",
      extraHeaders: null,
    } as never);
    vi.mocked(createChatModel).mockReturnValue({
      invoke: vi.fn(async () => {
        throw new DOMException("This operation was aborted", "AbortError");
      }),
    } as never);
    const controller = new AbortController();
    controller.abort();
    const out = await executeGraphRun(
      llmGraph(
        { onError: "defaultValue", errorOutput: "不应出现" },
        controller.signal,
      ),
    );
    expect(out).toBe("failed");
    const trace = JSON.parse(lastRunUpdate().data.graphTrace as string);
    expect(trace[0].status).toBe("failed");
    expect(trace[0].fallback).toBeUndefined();
  });
});

describe("finishRun 容错", () => {
  it("run 行已被删除（在途删图）→ update 抛错不外传，执行仍返回状态", async () => {
    vi.mocked(prisma.automationRun.update).mockRejectedValueOnce(
      new Error("P2025: Record to update not found") as never,
    );
    const out = await executeGraphRun(
      codeGraph([bashNode("quick", "echo ok")], [{ from: "quick", to: "END" }]),
    );
    expect(out).toBe("success");
  });
});

describe("节点失败详情（error.detail）", () => {
  it("code 节点失败 → trace error.detail 携带完整 stderr（超出 200 字摘要部分可见）", async () => {
    const longStderr = "ERR".repeat(150); // 450 字，超出 message 200 字截断
    const out = await executeGraphRun(
      codeGraph(
        [bashNode("boom", `echo "${longStderr}" >&2; exit 1`)],
        [{ from: "boom", to: "END" }],
      ),
    );
    expect(out).toBe("failed");
    const update = lastRunUpdate();
    const trace = JSON.parse(update.data.graphTrace as string);
    expect(trace[0].error.detail).toContain(longStderr.slice(100));
  });

  it("节点失败日志带 runId 定位（Log.error 调用参数含 run= 前缀）", async () => {
    const { default: Log } = await import("../../electron/commons/Log");
    vi.mocked(Log.error).mockClear();
    await executeGraphRun(
      codeGraph([bashNode("oops", "exit 3")], [{ from: "oops", to: "END" }]),
    );
    const logged = vi
      .mocked(Log.error)
      .mock.calls.some((call) =>
        call.some((arg) => String(arg).includes("run=9")),
      );
    expect(logged).toBe(true);
  });

  it("普通异常兜底 → error.detail 含堆栈（at 帧）", async () => {
    vi.mocked(prisma.model.findUnique).mockResolvedValue({
      id: 1,
      providerId: 2,
      modelId: "gpt-x",
    } as never);
    vi.mocked(prisma.provider.findUnique).mockResolvedValue({
      id: 2,
      type: "openai",
      baseUrl: "https://api.test",
      apiKey: "k",
      extraHeaders: null,
    } as never);
    vi.mocked(createChatModel).mockReturnValue({
      invoke: vi.fn(async () => {
        throw new Error("network broken");
      }),
    } as never);
    const out = await executeGraphRun(
      codeGraph(
        [
          {
            id: "ask",
            name: "问答",
            kind: "llm",
            modelId: 1,
            prompt: "hi",
          },
        ],
        [{ from: "ask", to: "END" }],
      ) as never,
    );
    expect(out).toBe("failed");
    const trace = JSON.parse(lastRunUpdate().data.graphTrace as string);
    expect(trace[0].error.detail).toMatch(/\n\s*at\s/);
  });
});
