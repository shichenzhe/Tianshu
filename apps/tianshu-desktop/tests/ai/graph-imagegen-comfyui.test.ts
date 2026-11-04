// tests/ai/graph-imagegen-comfyui.test.ts
// imageGen 双协议执行链：comfyui 提交/轮询/取图 + openai 回归 + trace outputImage
import { describe, expect, it, vi } from "vitest";

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
    provider: {
      findUnique: vi.fn(async () => ({
        id: 2,
        type: "comfyui",
        baseUrl: "http://localhost:8188",
        apiKey: "k",
        extraHeaders: null,
      })),
    },
  },
}));
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../electron/domains/ai/agent/skill-loader", () => ({
  loadSkills: vi.fn(() => []),
}));

import { executeGraphRun } from "../../electron/domains/ai/orchestration/graph-executor";
// prisma mock 句柄照抄 tests/ai/graph-executor.test.ts 的 import 方式
// （该文件经 vi.mock("../../electron/commons/prisma-client") 后直接
// import 同路径取 default，此处同款）：
import prisma from "../../electron/commons/prisma-client";

const workflowJson = JSON.stringify({
  "3": {
    class_type: "KSampler",
    inputs: { seed: 5, steps: 20, sampler_name: "euler" },
  },
  "6": {
    class_type: "CLIPTextEncode",
    inputs: { text: "masterpiece, {{prompt}}, best quality" },
  },
  "5": {
    class_type: "EmptyLatentImage",
    inputs: { width: "{{width}}", height: "{{height}}" },
  },
});

const comfyGraphJson = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    inputSchema: { topic: "string" },
    nodes: [
      {
        id: "gen",
        name: "生图",
        kind: "imageGen",
        protocol: "comfyui",
        providerId: 2,
        workflowJson,
        prompt: "a cat of {{input.topic}}",
        size: "768x512",
        ...extra,
      },
    ],
    edges: [{ from: "gen", to: "END" }],
  });

const graph = {
  id: 1,
  userId: 1,
  name: "g",
  graphJson: comfyGraphJson(),
};

const runParams = (inputs: Record<string, string> = { topic: "cats" }) => ({
  graph,
  task: null,
  inputs,
  triggerType: "manual" as const,
  attempt: 1,
  abort: new AbortController().signal,
  workspace: { id: 9, directoryPath: null },
});

type FetchCall = { url: string; init?: RequestInit };
/** 提交体 prompt 段断言形态（节点 id → class_type/inputs） */
type ComfyWorkflowShape = Record<
  string,
  { inputs: Record<string, number | string> }
>;
const pngBytes = () => Buffer.from("fake-png-bytes");

/** ComfyUI 三端点路由 stub；submitStatus/viewStatus/history 序列可编程 */
function stubComfyFetch(opts: {
  submitBody?: unknown;
  submitStatus?: number;
  viewStatus?: number;
  history: unknown[];
}) {
  const calls: FetchCall[] = [];
  const submitted: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });
      if (u.endsWith("/prompt")) {
        submitted.push(JSON.parse(String(init?.body)));
        return {
          ok: (opts.submitStatus ?? 200) < 400,
          status: opts.submitStatus ?? 200,
          json: async () =>
            opts.submitBody ?? { prompt_id: "p1", node_errors: {} },
        } as Response;
      }
      if (u.includes("/history/")) {
        return {
          ok: true,
          status: 200,
          json: async () => opts.history.shift() ?? {},
        } as Response;
      }
      if (u.includes("/view?")) {
        return {
          ok: (opts.viewStatus ?? 200) < 400,
          status: opts.viewStatus ?? 200,
          arrayBuffer: async () => pngBytes().buffer,
        } as Response;
      }
      if (u.endsWith("/images/generations")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ b64_json: pngBytes().toString("base64") }],
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
  return { calls, submitted };
}

const historyDone = {
  p1: {
    outputs: {
      "9": {
        images: [
          { filename: "ComfyUI_0001_.png", subfolder: "", type: "output" },
        ],
      },
    },
  },
};

const lastTrace = () => {
  const update = vi.mocked(prisma.automationRun.update).mock.calls.at(-1)![0];
  return JSON.parse(update.data.graphTrace as string);
};

describe("imageGen comfyui 执行链", () => {
  it("成功链路：占位注入+seed 随机+落盘+trace outputImage", async () => {
    const { submitted } = stubComfyFetch({ history: [{}, historyDone] });
    const out = await executeGraphRun(runParams());
    expect(out).toBe("success");
    const wf = submitted[0].prompt as ComfyWorkflowShape;
    expect(wf["6"].inputs.text).toBe(
      "masterpiece, a cat of cats, best quality",
    );
    expect(wf["5"].inputs.width).toBe(768);
    expect(wf["5"].inputs.height).toBe(512);
    const seed = wf["3"].inputs.seed;
    expect(seed).not.toBe(5); // 随机化生效
    expect(Number.isInteger(seed)).toBe(true);
    expect(lastTrace()[0].outputImage).toMatch(
      /^workflow-assets\/image-\d+\.png$/,
    );
  });

  it("randomizeSeed=false 保留静态 seed", async () => {
    graph.graphJson = comfyGraphJson({ randomizeSeed: false });
    const { submitted } = stubComfyFetch({ history: [historyDone] });
    await executeGraphRun(runParams());
    expect((submitted[0].prompt as ComfyWorkflowShape)["3"].inputs.seed).toBe(
      5,
    );
  });

  it("node_errors 非空 → comfyui_api_error", async () => {
    stubComfyFetch({
      submitStatus: 400,
      submitBody: {
        error: { type: "prompt_outputs_failed_validation" },
        node_errors: { "3": { errors: [{ type: "value_overflow" }] } },
      },
      history: [],
    });
    const out = await executeGraphRun(runParams());
    expect(out).toBe("failed");
    const trace = lastTrace();
    expect(trace[0].error.code).toBe("comfyui_api_error");
  });

  it("workflowJson 渲染后非法 JSON → comfyui_workflow_invalid", async () => {
    graph.graphJson = comfyGraphJson({ workflowJson: "{oops" });
    stubComfyFetch({ history: [] });
    const out = await executeGraphRun(runParams());
    expect(out).toBe("failed");
    expect(lastTrace()[0].error.code).toBe("comfyui_workflow_invalid");
  });

  it("轮询超时 → comfyui_timeout", async () => {
    graph.graphJson = comfyGraphJson({ timeoutMs: 5_000 });
    stubComfyFetch({ history: [] }); // history 永远空
    const out = await executeGraphRun(runParams());
    expect(out).toBe("failed");
    expect(lastTrace()[0].error.code).toBe("comfyui_timeout");
  }, 20_000);

  it("/view 非 2xx → comfyui_download_failed", async () => {
    graph.graphJson = comfyGraphJson();
    stubComfyFetch({ history: [historyDone], viewStatus: 500 });
    const out = await executeGraphRun(runParams());
    expect(out).toBe("failed");
    expect(lastTrace()[0].error.code).toBe("comfyui_download_failed");
  });

  it("openai 回归：默认协议 + trace outputImage 同样填充", async () => {
    graph.graphJson = JSON.stringify({
      version: 1,
      inputSchema: { topic: "string" },
      nodes: [
        {
          id: "gen",
          name: "生图",
          kind: "imageGen",
          modelId: 1,
          prompt: "p",
          size: "1024x1024",
        },
      ],
      edges: [{ from: "gen", to: "END" }],
    });
    vi.mocked(prisma.model.findUnique).mockResolvedValueOnce({
      id: 1,
      providerId: 2,
      modelId: "dall-e-3",
    } as never);
    stubComfyFetch({ history: [] }); // fetch 路由含 /images/generations
    const out = await executeGraphRun(runParams());
    expect(out).toBe("success");
    expect(lastTrace()[0].outputImage).toMatch(
      /^workflow-assets\/image-\d+\.png$/,
    );
  });
});
