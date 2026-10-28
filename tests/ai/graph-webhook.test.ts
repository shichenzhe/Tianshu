// tests/ai/graph-webhook.test.ts
/**
 * 入站 webhook：注册（token 生成 + option 落库）→ 真 HTTP server
 * （随机端口防撞）→ POST 触发图运行（inputs 解析、同步结果）；注销后
 * 404；坏 token 404。
 */
import { describe, expect, it, vi, beforeAll, afterEach } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`) },
  Notification: vi.fn(),
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock("../../electron/commons/prisma-client", () => {
  // option 行仓库（内存）：type/name/userId 唯一
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
        findFirst: vi.fn(
          async ({ where }: { where: Record<string, unknown> }) =>
            filterOf(where)[0] ?? null,
        ),
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
        deleteMany: vi.fn(
          async ({ where }: { where: Record<string, unknown> }) => {
            const hits = filterOf(where);
            for (const hit of hits) {
              options.splice(options.indexOf(hit), 1);
            }
            return { count: hits.length };
          },
        ),
      },
      // 去会话化：节点详情落 graphRunNode（session/message 两键已删）
      graphRunNode: { upsert: vi.fn(async () => ({ id: 1 })) },
      automationRun: {
        create: vi.fn(async () => ({ id: 9 })),
        update: vi.fn(),
        findFirst: vi.fn(async () => null),
      },
      automationTask: { update: vi.fn() },
      graphDefinition: {
        findFirst: vi.fn(async () => ({
          id: 5,
          name: "hook-demo",
          graphJson: JSON.stringify({
            version: 1,
            inputSchema: { word: "string" },
            nodes: [
              {
                id: "echo",
                name: "回显",
                kind: "code",
                language: "bash",
                script: 'echo "hi {{input.word}}"',
              },
            ],
            edges: [{ from: "echo", to: "END" }],
          }),
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
vi.mock("../../electron/domains/ai/agent/skill-loader", () => ({
  loadSkills: vi.fn(() => []),
}));
vi.mock("../../electron/domains/security/command-gate", () => ({
  commandGate: vi.fn(() => "allow" as const),
}));

import prisma from "../../electron/commons/prisma-client";
import { commandGate } from "../../electron/domains/security/command-gate";
import {
  parseBody,
  registerWebhook,
  setWebhookPort,
  unregisterWebhook,
  stopWebhookServer,
} from "../../electron/domains/ai/orchestration/webhook-server";
import { EventEmitter } from "node:events";
import net from "node:net";
import type http from "node:http";

async function post(
  url: string,
  body: unknown,
): Promise<{
  status: number;
  json: Record<string, unknown>;
  bodyText: string;
}> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Connection: "close" },
    body: JSON.stringify(body),
  });
  const bodyText = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    // 非 JSON body（自定义模板原样文本）
  }
  return { status: response.status, json, bodyText };
}

beforeAll(async () => {
  // 随机端口（option webhook.port）——一次随机全程复用：同用例内多次
  // register 时 ensureWebhookServer 读到同值不重绑（重开换 token 用例
  // 二次 register 后旧连接仍可达）
  const webhookPort = 20_000 + Math.floor(Math.random() * 20_000);
  vi
    .mocked(prisma.option.findFirst)
    .mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) => {
        if (where.name === "webhook.port") {
          return { value: String(webhookPort) };
        }
        const rows = await Promise.resolve(null);
        return rows;
      },
    ) as never;
});

afterEach(async () => {
  await stopWebhookServer();
});

describe("webhook server", () => {
  it("注册 → POST 触发（inputs 解析 + 同步输出）→ 注销后 404", async () => {
    const url = await registerWebhook(5, 1);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/webhook\/[a-f0-9]+$/);

    const outcome = await post(url, { word: "webhook", extra: { n: 1 } });
    expect(outcome.status).toBe(200);
    expect(outcome.json.status).toBe("success");
    expect(String(outcome.json.output)).toContain("hi webhook");

    // 坏 token
    const bad = await post(url.replace(/\/[a-f0-9]+$/, "/deadbeef"), {});
    expect(bad.status).toBe(404);

    // 注销后 server 关停：复用旧连接 fetch 必然失败（RST/拒绝）——
    // 语义即「不可达」，与坏 token 的 404 区分
    await unregisterWebhook(5, 1);
    await expect(post(url, { word: "x" })).rejects.toThrow();
  });

  it("重开换 token：旧 token 立即失效（运行期不泄漏），新 token 可达", async () => {
    const first = await registerWebhook(5, 1);
    const second = await registerWebhook(5, 1);
    expect(second).not.toBe(first);
    // 旧 token 404（修复前：内存旧条目残留，重启装载前仍可达——轮换
    // 语义失效；tianshu-server webhook.service 同根修复随批）
    const stale = await post(first, { word: "stale" });
    expect(stale.status).toBe(404);
    const fresh = await post(second, { word: "fresh" });
    expect(fresh.status).toBe(200);
    expect(fresh.json.status).toBe("success");
    await unregisterWebhook(5, 1);
  });

  it("GET 返回 404（只收 POST）", async () => {
    const url = await registerWebhook(5, 1);
    // Connection: close：不留 keep-alive 连接（固定端口下停起服间
    // closeAllConnections 的 RST 会炸下个用例复用的池连接）
    const response = await fetch(url, { headers: { Connection: "close" } });
    expect(response.status).toBe(404);
    await unregisterWebhook(5, 1);
  });
});

describe("webhook 自定义响应与异步 job", () => {
  it("自定义模板 + 状态码：POST 返回渲染后的 body", async () => {
    const url = await registerWebhook(5, 1, {
      responseTemplate: "result={{nodes.echo.output}} word={{input.word}}",
      statusCode: 201,
    });
    const outcome = await post(url, { word: "hi" });
    expect(outcome.status).toBe(201);
    expect(outcome.bodyText).toContain("result=hi");
    expect(outcome.bodyText).toContain("word=hi");
    await unregisterWebhook(5, 1);
  });

  it("异步 job：POST 立返 202 + jobId/statusUrl，GET 轮询到结果", async () => {
    const url = await registerWebhook(5, 1, { async: true });
    const submitted = await post(url, { word: "async" });
    expect(submitted.status).toBe(202);
    const jobId = submitted.json.jobId as number;
    expect(jobId).toBeGreaterThan(0);
    expect(String(submitted.json.statusUrl)).toMatch(
      /\/webhook\/[a-f0-9]+\/jobs\/\d+$/,
    );
    // fire-and-forget：POST 返回时图仍在跑——轮询重试直至结果就绪
    // （run 表兜底 mock 恒 null，未就绪窗口内 404）
    const polled = await vi.waitFor(
      async () => {
        const poll = await fetch(String(submitted.json.statusUrl), {
          headers: { Connection: "close" },
        });
        if (poll.status === 404) {
          throw new Error("job 结果未就绪");
        }
        return (await poll.json()) as { status: string; output: string };
      },
      { timeout: 5_000 },
    );
    expect(polled.status).toBe("success");
    expect(polled.output).toContain("async");
    await unregisterWebhook(5, 1);
  });

  it("job 轮询：内存缺失时回落 run 表（未知 jobId → 404）", async () => {
    const url = await registerWebhook(5, 1, { async: true });
    const token = /\/webhook\/([a-f0-9]+)$/.exec(url)![1];
    const poll = await fetch(
      url.replace(/\/webhook\/[a-f0-9]+$/, `/webhook/${token}/jobs/99999`),
      { headers: { Connection: "close" } },
    );
    expect(poll.status).toBe(404);
    await unregisterWebhook(5, 1);
  });
});

describe("webhook 资源防泄漏", () => {
  /** EventEmitter 伪装 IncomingMessage（parseBody 只依赖 on/emit） */
  function fakeReq(): http.IncomingMessage {
    return new EventEmitter() as unknown as http.IncomingMessage;
  }

  it("parseBody：客户端中断（error 无 end）立即收敛不悬挂", async () => {
    const fake = fakeReq();
    const pending = parseBody(fake);
    fake.emit("error", new Error("ECONNRESET"));
    await expect(pending).resolves.toEqual({});
  });

  it("parseBody：close 兜底收敛（无 end 无 error 的中途断开）", async () => {
    const fake = fakeReq();
    const pending = parseBody(fake);
    fake.emit("close");
    await expect(pending).resolves.toEqual({});
  });

  it("parseBody：end 正常解析，end 后 close 再触发不重复收敛", async () => {
    const fake = fakeReq();
    const pending = parseBody(fake);
    fake.emit("data", Buffer.from('{"word":"hi"'));
    fake.emit("data", Buffer.from("}"));
    fake.emit("end");
    fake.emit("close");
    await expect(pending).resolves.toEqual({ word: "hi" });
  });

  it("异步 job 多次触发：各自结果独立保留（有界缓存按 runId 存取）", async () => {
    // 两次 run 发两个不同 id（默认 mock 恒返 9，会互相覆盖键）
    vi.mocked(prisma.automationRun.create)
      .mockImplementationOnce(async () => ({ id: 100 }))
      .mockImplementationOnce(async () => ({ id: 101 }));
    const url = await registerWebhook(5, 1, { async: true });
    const first = await post(url, { word: "one" });
    const second = await post(url, { word: "two" });
    expect(first.json.jobId).toBe(100);
    expect(second.json.jobId).toBe(101);
    // fire-and-forget：轮询重试直至各自结果就绪
    const pollOf = (statusUrl: string) =>
      vi.waitFor(
        async () => {
          const poll = await fetch(statusUrl, {
            headers: { Connection: "close" },
          });
          if (poll.status === 404) {
            throw new Error("job 结果未就绪");
          }
          return (await poll.json()) as { status: string; output: string };
        },
        { timeout: 5_000 },
      );
    const poll1 = await pollOf(String(first.json.statusUrl));
    const poll2 = await pollOf(String(second.json.statusUrl));
    expect(poll1.status).toBe("success");
    expect(poll1.output).toContain("one");
    expect(poll2.output).toContain("two");
    await unregisterWebhook(5, 1);
  });
});

describe("webhook 触发图级完全访问（fullAccess）", () => {
  it("名单未放行解释器：fullAccess 缺省 → code 节点 code_permission_denied；fullAccess=true → 放行执行", async () => {
    // 模拟安全中心未放行解释器（default 决策非 allow）
    vi.mocked(commandGate).mockReturnValue("default");

    // 缺省注册（fullAccess 未开）：code 节点被无人值守门禁拦截
    const gatedUrl = await registerWebhook(5, 1);
    const gated = await post(gatedUrl, { word: "x" });
    expect(gated.json.status).toBe("failed");
    const lastUpdate = vi
      .mocked(prisma.automationRun.update)
      .mock.calls.at(-1)?.[0] as { data?: { error?: string } };
    expect(lastUpdate?.data?.error).toContain("code_permission_denied");
    await unregisterWebhook(5, 1);

    // 开启图级完全访问：同一图放行执行
    const fullUrl = await registerWebhook(5, 1, { fullAccess: true });
    const full = await post(fullUrl, { word: "x" });
    expect(full.json.status).toBe("success");
    await unregisterWebhook(5, 1);

    vi.mocked(commandGate).mockReturnValue("allow");
  });
});

describe("setWebhookPort（端口全局设置：试绑失败回滚）", () => {
  it("改端口 → 重绑生效；端口被占 → 报错并回滚旧值旧端口", async () => {
    // beforeAll 劫持 findFirst（随机端口防撞）会遮住 upsert 写入——
    // 本用例包装 findFirst/upsert：webhook.port 行由局部 portState 承载
    // （初始固定一次随机端口，保证多次 loadPort 稳定一致），其余透传
    // 原实现；用后恢复原劫持
    const portState: { value: string | null } = {
      value: String(20_000 + Math.floor(Math.random() * 20_000)),
    };
    const origFindFirst = vi.mocked(prisma.option.findFirst);
    const origFirstImpl = origFindFirst.getMockImplementation()!;
    const origUpsert = vi.mocked(prisma.option.upsert);
    const origUpsertImpl = origUpsert.getMockImplementation()!;
    origFindFirst.mockImplementation(
      async (args: { where: Record<string, unknown> }) => {
        if (args.where.name === "webhook.port") {
          return { value: portState.value as string };
        }
        return origFirstImpl(args);
      },
    );
    origUpsert.mockImplementation(
      async (args: {
        where: { name?: string; type_name_userId?: { name?: string } };
        update: { value: string };
      }) => {
        const rowName = args.where.name ?? args.where.type_name_userId?.name;
        if (rowName === "webhook.port") {
          portState.value = args.update.value;
          return { id: 0, type: "app", name: rowName };
        }
        return origUpsertImpl(args as never);
      },
    );

    try {
      // 先注册一个 webhook（起 server）并记录原端口（token 随注册 URL
      // 返回；setWebhookPort 只重绑不换 token）
      const url = await registerWebhook(5, 1);
      const portBefore = Number(/:(\d+)\//.exec(url)![1]);
      // 绑定失败制造：保留端口 80 无特权必报 EACCES（macOS SO_REUSEADDR
      // 宽松到连 0.0.0.0+127.0.0.1 都共存，真端口冲突不可移植），
      // 失败路径与 EADDRINUSE 同走回滚
      const busyPort = 80;
      await expect(setWebhookPort(busyPort)).rejects.toThrow(/绑定失败/);
      // 回滚：option 恢复原生效端口（previous 值）
      expect(portState.value).toBe(String(portBefore));

      // 正常改口：空闲端口生效（option 落新值）
      const free = await new Promise<number>((r) => {
        const probe = net.createServer();
        probe.listen(0, "127.0.0.1", () => {
          const p = (probe.address() as { port: number }).port;
          probe.close(() => r(p));
        });
      });
      const bound = await setWebhookPort(free);
      expect(bound).toBe(free);
      expect(portState.value).toBe(String(free));
    } finally {
      origFindFirst.mockImplementation(origFirstImpl);
      origUpsert.mockImplementation(origUpsertImpl);
    }
  });
});
