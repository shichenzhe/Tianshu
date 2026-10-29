// tests/ai/graph-webhook-async.test.ts
/**
 * webhook 触发安全与异步语义（mock executor）：异步模式 runId 就绪即
 * 202（不等图完成）；runGraphToResult 收到 disabledTools/codeAuthorized
 * （外部触发对齐 default 任务）；完成发布 taskFinished；stopWebhookServer
 * 中止在途运行。
 */
import { describe, expect, it, vi, beforeAll, afterEach } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`) },
  Notification: vi.fn(),
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock("../../electron/commons/prisma-client", () => {
  // option 行内存仓库：registerWebhook 后 ensureWebhookServer 会
  // reloadRegistrations（clear + findMany 重载）——upsert/findMany 须真写
  // 读，否则新注册 token 被清掉（生产语义：option 表持久）
  const options: Array<{
    id: number;
    type: string;
    name: string;
    value: string;
    userId: number;
  }> = [];
  let seq = 1;
  const filterOf = (where: Record<string, unknown>) =>
    options.filter(
      (row) =>
        (where.type === undefined || row.type === where.type) &&
        (where.name === undefined || row.name === where.name) &&
        (where.userId === undefined || row.userId === where.userId),
    );
  return {
    default: {
      option: {
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
          filterOf(where),
        ),
        upsert: vi.fn(
          async (args: {
            where: { type: string; name: string; userId: number };
            create: {
              type: string;
              name: string;
              value: string;
              userId: number;
            };
            update: { value: string };
          }) => {
            const hit = filterOf(args.where)[0];
            if (hit) {
              hit.value = args.update.value;
              return hit;
            }
            const row = { id: seq++, ...args.create };
            options.push(row);
            return row;
          },
        ),
        deleteMany: vi.fn(),
      },
      graphDefinition: {
        findFirst: vi.fn(async () => ({
          id: 5,
          name: "hook-demo",
          graphJson: "{}",
          version: 1,
          enabled: true,
          userId: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      },
      workspace: {
        findFirst: vi.fn(async () => ({ id: 9, directoryPath: null })),
      },
    },
  };
});
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const runGraphCalls: Array<Record<string, unknown>> = [];
let runGraphImpl: (
  params: Record<string, unknown>,
) => Promise<unknown> = async () => ({
  status: "success",
  output: "",
  nodeOutputs: {},
  runId: 0,
});

vi.mock("../../electron/domains/ai/orchestration/graph-executor", () => ({
  runGraphToResult: vi.fn(async (params: Record<string, unknown>) => {
    runGraphCalls.push(params);
    return runGraphImpl(params);
  }),
  executeGraphRun: vi.fn(),
}));

const published: Array<Record<string, unknown>> = [];
vi.mock("../../electron/domains/ai/automation/automation-event-bus", () => ({
  publishAutomationEvent: vi.fn(async (event: Record<string, unknown>) => {
    published.push(event);
  }),
  matchEventTasks: vi.fn(() => []),
}));

import {
  registerWebhook,
  unregisterWebhook,
  stopWebhookServer,
  setWebhookDisabledTools,
} from "../../electron/domains/ai/orchestration/webhook-server";
import prisma from "../../electron/commons/prisma-client";

// 随机端口（option webhook.port）：避开真实应用占用的默认 27400
// （先例 graph-webhook.test.ts）
const testPort = 20_000 + Math.floor(Math.random() * 20_000);
vi.mocked(prisma.option.findFirst).mockImplementation(
  async ({ where }: { where: { name?: string } }) =>
    where?.name === "webhook.port" ? { value: String(testPort) } : null,
);

/** 最近一次 runGraphToResult 调用参数 */
const lastRunGraphCall = () => runGraphCalls.at(-1)!;

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  setWebhookDisabledTools(() => ["bash"]);
});

afterEach(async () => {
  await stopWebhookServer();
  runGraphCalls.length = 0;
  published.length = 0;
  runGraphImpl = async () => ({
    status: "success",
    output: "",
    nodeOutputs: {},
    runId: 0,
  });
});

describe("webhook 触发安全装配", () => {
  it("runGraphToResult 收到 disabledTools 闭包与 codeAuthorized:false", async () => {
    const url = await registerWebhook(5, 1);
    const response = await post(url, { word: "sync" });
    expect(response.status).toBe(200);
    const call = lastRunGraphCall();
    expect(call.triggerType).toBe("webhook");
    expect((call.disabledTools as () => string[])()).toEqual(["bash"]);
    // 外部触发（token 泄漏即可达）对齐 default 任务：无代码/写节点全权
    expect(call.codeAuthorized).toBe(false);
    await unregisterWebhook(5, 1);
  });

  it("运行完成发布 taskFinished（targetType=graph）", async () => {
    const url = await registerWebhook(5, 1);
    await post(url, {});
    await vi.waitFor(() => expect(published.length).toBe(1));
    expect(published[0]).toEqual({
      source: "taskFinished",
      targetType: "graph",
      targetId: 5,
      outcome: "success",
    });
    await unregisterWebhook(5, 1);
  });
});

describe("webhook 异步模式（fire-and-forget）", () => {
  it("runId 就绪即回 202，不等图完成", async () => {
    // run 行先落库（onRunId 立即触发），图再跑 300ms——202 必须在此前返回
    runGraphImpl = async (params) => {
      (params.onRunId as (id: number) => void)(33);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return {
        status: "success",
        output: "slow-done",
        nodeOutputs: {},
        runId: 33,
      };
    };
    const url = await registerWebhook(5, 1, { async: true });
    const startedAt = Date.now();
    const response = await post(url, { word: "async" });
    expect(response.status).toBe(202);
    expect(Date.now() - startedAt).toBeLessThan(300);
    expect(((await response.json()) as { jobId: number }).jobId).toBe(33);
    await unregisterWebhook(5, 1);
  });

  it("前置失败（图不可用）无 runId → 500", async () => {
    const { graphDefinition } = (
      await import("../../electron/commons/prisma-client")
    ).default as unknown as {
      graphDefinition: { findFirst: ReturnType<typeof vi.fn> };
    };
    graphDefinition.findFirst.mockResolvedValueOnce(null);
    const url = await registerWebhook(5, 1, { async: true });
    const response = await post(url, {});
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).toBe(
      "graph_not_available",
    );
    await unregisterWebhook(5, 1);
  });

  it("异步运行完成写 job 结果并发布 taskFinished", async () => {
    runGraphImpl = async (params) => {
      (params.onRunId as (id: number) => void)(34);
      return {
        status: "success",
        output: "job-out",
        nodeOutputs: {},
        runId: 34,
      };
    };
    const url = await registerWebhook(5, 1, { async: true });
    const response = await post(url, {});
    const { jobId, statusUrl } = (await response.json()) as {
      jobId: number;
      statusUrl: string;
    };
    expect(jobId).toBe(34);
    await vi.waitFor(() => expect(published.length).toBe(1));
    const poll = (await (await fetch(statusUrl)).json()) as {
      status: string;
      output: string;
    };
    expect(poll.status).toBe("success");
    expect(poll.output).toContain("job-out");
    await unregisterWebhook(5, 1);
  });

  it("stopWebhookServer 中止在途异步运行", async () => {
    let release: () => void = () => {};
    runGraphImpl = (params) => {
      const signal = params.abort as AbortSignal;
      const settle = {
        status: "failed",
        output: "",
        nodeOutputs: {},
        runId: 35,
      };
      (params.onRunId as (id: number) => void)(35);
      return new Promise((resolve) => {
        release = () => resolve(settle);
        signal.addEventListener("abort", () => resolve(settle));
      });
    };
    const url = await registerWebhook(5, 1, { async: true });
    // 上一测试 afterEach 的 closeAllConnections 会使 undici 连接池中的
    // keep-alive 连接失效，偶发 ECONNRESET——重试一次兜底
    let response: Response;
    try {
      response = await post(url, {});
    } catch {
      response = await post(url, {});
    }
    expect(response.status).toBe(202);
    const signal = lastRunGraphCall().abort as AbortSignal;
    expect(signal.aborted).toBe(false);
    await stopWebhookServer();
    expect(signal.aborted).toBe(true);
    release();
  });
});
