// tests/ai/graph-http-node.test.ts
/**
 * HTTP 节点执行测试：fetch 打桩（URL/方法/头/查询串/体逐项断言）、
 * 变量模板替换（url/头值/参数值/body）、非 2xx → http_status_error、
 * 网络失败 → http_request_failed、响应体截断、withQueryParams 纯函数。
 */
import { describe, expect, it, vi, beforeAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`) },
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    // 去会话化：节点详情落 graphRunNode（session/message 两键已删）
    graphRunNode: { upsert: vi.fn(async () => ({ id: 1 })) },
    automationRun: { create: vi.fn(async () => ({ id: 9 })), update: vi.fn() },
    automationTask: { update: vi.fn() },
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

import prisma from "../../electron/commons/prisma-client";
import { workflowAssetsDir } from "../../electron/commons/paths";
import {
  executeGraphRun,
  withQueryParams,
} from "../../electron/domains/ai/orchestration/graph-executor";

const httpGraph = (nodes: object[], edges: object[], inputs = {}) => ({
  graph: {
    id: 7,
    name: "http-demo",
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

/** 带真实工作空间目录的图参数（binary body 文件读取用） */
const httpGraphInWorkspace = async (
  nodes: object[],
  edges: object[],
): Promise<ReturnType<typeof httpGraph>> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tianshu-httpbin-"));
  await fs.writeFile(path.join(dir, "payload.bin"), "BINARYDATA");
  return {
    ...httpGraph(nodes, edges),
    workspace: { id: 9, directoryPath: dir },
  };
};

const httpNode = (id: string, extra: object = {}) => ({
  id,
  name: id,
  kind: "http",
  url: "https://api.test/x",
  ...extra,
});

const fetchMock = vi.fn();
const lastRunUpdate = () =>
  vi.mocked(prisma.automationRun.update).mock.calls.at(-1)![0];
const traceOf = () => JSON.parse(lastRunUpdate().data.graphTrace as string);

/** Response 形桩（fetch 返回） */
const respond = (status: number, body: string) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  }) as never;

beforeAll(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(prisma.graphRunNode.upsert).mockClear();
  vi.mocked(prisma.automationRun.update).mockClear();
});

afterEach(() => {
  fetchMock.mockReset();
});

describe("withQueryParams（纯函数）", () => {
  it("空参数原样；拼接用 ? / &；键值 URL 编码", () => {
    expect(withQueryParams("https://a.b/x", [])).toBe("https://a.b/x");
    expect(withQueryParams("https://a.b/x", [{ key: "q", value: "a b" }])).toBe(
      "https://a.b/x?q=a%20b",
    );
    expect(
      withQueryParams("https://a.b/x?z=1", [{ key: "p", value: "2" }]),
    ).toBe("https://a.b/x?z=1&p=2");
  });
});

describe("HTTP 节点执行", () => {
  it("GET 成功：query 拼接 + 头/URL 变量替换，响应体为 output", async () => {
    fetchMock.mockResolvedValue(respond(200, '{"ok":true}'));
    const out = await executeGraphRun(
      httpGraph(
        [
          httpNode("call", {
            url: "https://api.test/{{input.path}}",
            headers: [
              { key: "Authorization", value: "Bearer {{input.token}}" },
            ],
            query: [{ key: "page", value: "{{input.page}}" }],
          }),
        ],
        [{ from: "call", to: "END" }],
        { path: "items", token: "t1", page: "3" },
      ),
    );
    expect(out).toBe("success");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.test/items?page=3");
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({ Authorization: "Bearer t1" });
    expect(traceOf()[0].outputPreview).toContain('{"ok":true}');
  });

  it("POST json：body 变量替换 + 缺省 Content-Type；显式头优先", async () => {
    fetchMock.mockResolvedValue(respond(201, "created"));
    const out = await executeGraphRun(
      httpGraph(
        [
          httpNode("post", {
            method: "POST",
            bodyType: "json",
            body: '{"q":"{{input.q}}"}',
            headers: [
              { key: "Content-Type", value: "application/json; charset=utf-8" },
            ],
          }),
        ],
        [{ from: "post", to: "END" }],
        { q: "hi" },
      ),
    );
    expect(out).toBe("success");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe('{"q":"hi"}');
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json; charset=utf-8",
    });
  });

  it("非 2xx → http_status_error（状态码与响应片段进错误）", async () => {
    fetchMock.mockResolvedValue(respond(503, "service unavailable"));
    const out = await executeGraphRun(
      httpGraph([httpNode("call")], [{ from: "call", to: "END" }]),
    );
    expect(out).toBe("failed");
    expect(lastRunUpdate().data.error).toMatch(/node:call http_status_error/);
    expect(lastRunUpdate().data.error).toContain("503");
    expect(traceOf()[0].status).toBe("failed");
  });

  it("网络层失败 → http_request_failed", async () => {
    fetchMock.mockRejectedValue(new Error("ENOTFOUND api.test"));
    const out = await executeGraphRun(
      httpGraph([httpNode("call")], [{ from: "call", to: "END" }]),
    );
    expect(out).toBe("failed");
    expect(lastRunUpdate().data.error).toMatch(/node:call http_request_failed/);
  });

  it("响应体超 64KB 截断", async () => {
    fetchMock.mockResolvedValue(respond(200, "x".repeat(70_000)));
    const out = await executeGraphRun(
      httpGraph([httpNode("call")], [{ from: "call", to: "END" }]),
    );
    expect(out).toBe("success");
    expect(traceOf()[0].outputPreview.length).toBeLessThanOrEqual(200);
  });
});

describe("HTTP 节点鉴权", () => {
  it("bearer：token 占位符替换后注入 Authorization（覆盖同名头）", async () => {
    fetchMock.mockResolvedValue(respond(200, "ok"));
    const out = await executeGraphRun(
      httpGraph(
        [
          httpNode("call", {
            auth: { type: "bearer", token: "{{input.key}}" },
            headers: [{ key: "Authorization", value: "stale" }],
          }),
        ],
        [{ from: "call", to: "END" }],
        { key: "k9" },
      ),
    );
    expect(out).toBe("success");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: "Bearer k9" });
  });

  it("basic：base64(user:password) 注入", async () => {
    fetchMock.mockResolvedValue(respond(200, "ok"));
    await executeGraphRun(
      httpGraph(
        [
          httpNode("call", {
            auth: { type: "basic", user: "u1", password: "p1" },
          }),
        ],
        [{ from: "call", to: "END" }],
      ),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const expected = Buffer.from("u1:p1").toString("base64");
    expect(init.headers).toMatchObject({ Authorization: `Basic ${expected}` });
  });

  it("自定义头鉴权：头名值注入", async () => {
    fetchMock.mockResolvedValue(respond(200, "ok"));
    await executeGraphRun(
      httpGraph(
        [
          httpNode("call", {
            auth: { type: "header", name: "X-Api-Key", value: "{{input.k}}" },
          }),
        ],
        [{ from: "call", to: "END" }],
        { k: "abc" },
      ),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ "X-Api-Key": "abc" });
  });
});

describe("HTTP 节点重试", () => {
  it("retries=2：前两次 503 第三次成功 → 节点成功，fetch 共 3 次", async () => {
    fetchMock
      .mockResolvedValueOnce(respond(503, "down"))
      .mockResolvedValueOnce(respond(503, "down"))
      .mockResolvedValueOnce(respond(200, "recovered"));
    const out = await executeGraphRun(
      httpGraph(
        [httpNode("call", { retries: 2 })],
        [{ from: "call", to: "END" }],
      ),
    );
    expect(out).toBe("success");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(traceOf()[0].outputPreview).toContain("recovered");
  });

  it("重试耗尽仍失败 → run failed（末次错误）", async () => {
    fetchMock.mockResolvedValue(respond(500, "boom"));
    const out = await executeGraphRun(
      httpGraph(
        [httpNode("call", { retries: 1 })],
        [{ from: "call", to: "END" }],
      ),
    );
    expect(out).toBe("failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lastRunUpdate().data.error).toMatch(/node:call http_status_error/);
  });
});

describe("HTTP 节点 binary 上传", () => {
  it("body 为文件路径 → 读文件 Buffer 作请求体，缺省 Content-Type 兜底", async () => {
    fetchMock.mockResolvedValue(respond(200, "uploaded"));
    // 工作空间内文件（路径边界收紧后，工作空间外绝对路径不再放行——
    // 见「路径边界」describe）
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tianshu-httpbin-"));
    const file = path.join(dir, "upload.png");
    await fs.writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      const out = await executeGraphRun({
        ...httpGraph(
          [
            httpNode("upload", {
              method: "POST",
              bodyType: "binary",
              body: file,
            }),
          ],
          [{ from: "upload", to: "END" }],
        ),
        workspace: { id: 9, directoryPath: dir },
      });
      expect(out).toBe("success");
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.body).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
      expect(init.headers).toMatchObject({
        "Content-Type": "application/octet-stream",
      });
    } finally {
      await fs.rm(file, { force: true });
    }
  });

  it("文件不可读 → http_body_file_missing", async () => {
    // 工作空间内的不存在文件（越界外路径先报 outside，见边界用例）
    const params = await httpGraphInWorkspace(
      [
        httpNode("upload", {
          method: "POST",
          bodyType: "binary",
          body: "missing.bin",
        }),
      ],
      [{ from: "upload", to: "END" }],
    );
    const out = await executeGraphRun(params);
    expect(out).toBe("failed");
    expect(lastRunUpdate().data.error).toMatch(
      /node:upload http_body_file_missing/,
    );
  });
});

describe("ACS3 签名（阿里云 V3）", () => {
  it("percentEncode RFC3986：! ' ( ) * 补编码", async () => {
    const { percentEncode } =
      await import("../../electron/domains/ai/orchestration/acs3-sign");
    expect(percentEncode("a b!c'd(e)f*g")).toBe("a%20b%21c%27d%28e%29f%2Ag");
    expect(percentEncode("中文")).toBe("%E4%B8%AD%E6%96%87");
  });

  it("固定时间/nonce 的签名向量：Authorization 结构与 HMAC 一致", async () => {
    const { signAcs3 } =
      await import("../../electron/domains/ai/orchestration/acs3-sign");
    const { createHash, createHmac } = await import("node:crypto");
    const now = new Date("2026-10-05T08:00:00Z");
    const nonce = "test-nonce";
    const url = new URL(
      "https://ecs.aliyuncs.com/?PageSize=10&Action=DescribeInstances",
    );
    const body = "";
    const result = signAcs3({
      method: "GET",
      url,
      headers: {
        "Content-Type": "application/json",
        "x-acs-version": "2014-05-26",
      },
      body,
      accessKeyId: "LTAI_TEST",
      accessKeySecret: "TEST_SECRET",
      now,
      nonce,
    });
    // 自动注入
    expect(result.headers["x-acs-date"]).toBe("2026-10-05T08:00:00Z");
    expect(result.headers["x-acs-signature-nonce"]).toBe("test-nonce");
    const payloadHash = createHash("sha256").update("").digest("hex");
    expect(result.headers["x-acs-content-sha256"]).toBe(payloadHash);
    // 手工复算
    const canonical = [
      "GET",
      "/",
      "Action=DescribeInstances&PageSize=10",
      [
        "content-type:application/json\n",
        "host:ecs.aliyuncs.com\n",
        `x-acs-content-sha256:${payloadHash}\n`,
        "x-acs-date:2026-10-05T08:00:00Z\n",
        "x-acs-signature-nonce:test-nonce\n",
        "x-acs-version:2014-05-26\n",
      ].join(""),
      "content-type;host;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version",
      payloadHash,
    ].join("\n");
    const stringToSign = `ACS3-HMAC-SHA256\n${createHash("sha256").update(canonical).digest("hex")}`;
    const signature = createHmac("sha256", "TEST_SECRET")
      .update(stringToSign)
      .digest("hex");
    expect(result.authorization).toBe(
      `ACS3-HMAC-SHA256 Credential=LTAI_TEST,SignedHeaders=content-type;host;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=${signature}`,
    );
    expect(result.headers.Authorization).toBe(result.authorization);
  });

  it("签名头前缀可配置（x-acs-* → x-ca-*）+ 执行器集成注入", async () => {
    const { signAcs3 } =
      await import("../../electron/domains/ai/orchestration/acs3-sign");
    const result = signAcs3({
      method: "GET",
      url: new URL("https://api.example.com/path"),
      headers: {},
      body: "",
      accessKeyId: "id",
      accessKeySecret: "secret",
      headerPrefix: "X-Ca-", // 大写输入——签名内部归一小写
      now: new Date("2026-10-05T08:00:00Z"),
      nonce: "n",
    });
    // 前缀归一：自动注入 x-ca-date / x-ca-signature-nonce / x-ca-content-sha256
    expect(result.headers["x-ca-date"]).toBe("2026-10-05T08:00:00Z");
    expect(result.headers["x-ca-signature-nonce"]).toBe("n");
    expect(result.headers["x-ca-content-sha256"]).toBeTruthy();
    // Authorization 固定为签名放置头（不再可改名）
    expect(result.headers.Authorization).toContain("ACS3-HMAC-SHA256");
    expect(result.headers["x-ca-action"]).toBeUndefined();

    // 执行器集成：fetch 收到的头带签名与 x-acs-*
    fetchMock.mockResolvedValue(respond(200, "ok"));
    const out = await executeGraphRun(
      httpGraph(
        [
          {
            id: "call",
            name: "阿里云",
            kind: "http",
            url: "https://ecs.aliyuncs.com/?Action=Test",
            auth: {
              type: "acs3",
              accessKeyId: "LTAI",
              accessKeySecret: "SEC",
              headerPrefix: "x-ca-",
            },
            headers: [{ key: "x-ca-action", value: "Test" }],
          },
        ],
        [{ from: "call", to: "END" }],
      ),
    );
    expect(out).toBe("success");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-ca-action"]).toBe("Test");
    expect(headers["x-ca-date"]).toBeTruthy();
    expect(headers["x-ca-signature-nonce"]).toBeTruthy();
    expect(headers.Authorization).toContain("ACS3-HMAC-SHA256");
  });
});

describe("自定义前缀 + 算法标识可配置", () => {
  it("x-custom- 前缀 + CUSTOM-HMAC-SHA256 算法：三头按前缀注入，Authorization 首段与 StringToSign 同步换标识", async () => {
    const { signAcs3 } =
      await import("../../electron/domains/ai/orchestration/acs3-sign");
    const { createHash, createHmac } = await import("node:crypto");
    const now = new Date("2026-10-05T08:00:00Z");
    const result = signAcs3({
      method: "POST",
      url: new URL("https://api.example.com/v1/order"),
      headers: {
        "Content-Type": "application/json",
        "x-custom-version": "2024-05-20",
      },
      body: '{"k":"v"}',
      accessKeyId: "CUSTOM_KEY",
      accessKeySecret: "CUSTOM_SECRET",
      headerPrefix: "x-custom-",
      algorithm: "CUSTOM-HMAC-SHA256",
      now,
      nonce: "custom-nonce",
    });
    // 按前缀注入
    expect(result.headers["x-custom-date"]).toBe("2026-10-05T08:00:00Z");
    expect(result.headers["x-custom-signature-nonce"]).toBe("custom-nonce");
    const payloadHash = createHash("sha256").update('{"k":"v"}').digest("hex");
    expect(result.headers["x-custom-content-sha256"]).toBe(payloadHash);
    // 手工复算（StringToSign 首行 = CUSTOM-HMAC-SHA256）
    const canonical = [
      "POST",
      "/v1/order",
      "",
      [
        "content-type:application/json\n",
        "host:api.example.com\n",
        `x-custom-content-sha256:${payloadHash}\n`,
        "x-custom-date:2026-10-05T08:00:00Z\n",
        "x-custom-signature-nonce:custom-nonce\n",
        "x-custom-version:2024-05-20\n",
      ].join(""),
      "content-type;host;x-custom-content-sha256;x-custom-date;x-custom-signature-nonce;x-custom-version",
      payloadHash,
    ].join("\n");
    const stringToSign = `CUSTOM-HMAC-SHA256\n${createHash("sha256").update(canonical).digest("hex")}`;
    const signature = createHmac("sha256", "CUSTOM_SECRET")
      .update(stringToSign)
      .digest("hex");
    expect(result.authorization).toBe(
      `CUSTOM-HMAC-SHA256 Credential=CUSTOM_KEY,SignedHeaders=content-type;host;x-custom-content-sha256;x-custom-date;x-custom-signature-nonce;x-custom-version,Signature=${signature}`,
    );
  });

  it("缺省配置保持阿里云 ACS3 行为（回归）", async () => {
    const { signAcs3 } =
      await import("../../electron/domains/ai/orchestration/acs3-sign");
    const result = signAcs3({
      method: "GET",
      url: new URL("https://ecs.aliyuncs.com/"),
      headers: {},
      body: "",
      accessKeyId: "k",
      accessKeySecret: "s",
      now: new Date("2026-10-05T08:00:00Z"),
      nonce: "n",
    });
    expect(result.headers["x-acs-date"]).toBe("2026-10-05T08:00:00Z");
    expect(result.authorization.startsWith("ACS3-HMAC-SHA256 ")).toBe(true);
  });
});

describe("HTTP binary 请求体路径边界（授权边界对齐 fileRead）", () => {
  it("工作空间外绝对路径 → http_body_outside_workspace 拒读", async () => {
    fetchMock.mockResolvedValue(respond(200, "ok"));
    const params = await httpGraphInWorkspace(
      [
        httpNode("upload", {
          method: "POST",
          bodyType: "binary",
          body: "/etc/passwd",
        }),
      ],
      [{ from: "upload", to: "END" }],
    );
    const out = await executeGraphRun(params);
    expect(out).toBe("failed");
    expect(lastRunUpdate().data.error).toMatch(/http_body_outside_workspace/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("工作空间内相对路径 → 读 Buffer 上传（不越界）", async () => {
    fetchMock.mockResolvedValue(respond(200, "ok"));
    const params = await httpGraphInWorkspace(
      [
        httpNode("upload", {
          method: "POST",
          bodyType: "binary",
          body: "payload.bin",
        }),
      ],
      [{ from: "upload", to: "END" }],
    );
    const out = await executeGraphRun(params);
    expect(out).toBe("success");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeInstanceOf(Uint8Array);
  });

  it("应用 workflow-assets 目录（imageGen 产物）→ 放行", async () => {
    fetchMock.mockResolvedValue(respond(200, "ok"));
    // 数据根走 commons/paths（全局 setup 已隔离）
    const assetsDir = workflowAssetsDir();
    await fs.mkdir(assetsDir, { recursive: true });
    const assetFile = path.join(assetsDir, "image-1.png");
    await fs.writeFile(assetFile, "PNGDATA");
    const out = await executeGraphRun(
      httpGraph(
        [
          httpNode("upload", {
            method: "POST",
            bodyType: "binary",
            body: assetFile,
          }),
        ],
        [{ from: "upload", to: "END" }],
      ),
    );
    expect(out).toBe("success");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeInstanceOf(Uint8Array);
  });
});

describe("HTTP 节点失败详情（error.detail）", () => {
  it("非 2xx → error.detail 含响应体全貌（超出 message 200 字摘要部分可见）", async () => {
    const longBody = `{"error":"${"x".repeat(400)}"}`;
    fetchMock.mockResolvedValue(respond(503, longBody));
    const out = await executeGraphRun(
      httpGraph([httpNode("call")], [{ from: "call", to: "END" }]),
    );
    expect(out).toBe("failed");
    const trace = traceOf();
    expect(trace[0].error.detail).toContain("x".repeat(300));
  });
});
