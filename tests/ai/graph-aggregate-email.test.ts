// tests/ai/graph-aggregate-email.test.ts
/**
 * 聚合统计节点（kind:aggregate）：source（JSON 行数组优先/多行文本）→
 * count/sum/avg/min/max/distinctCount/groupByCount → JSON 结果输出。
 * 邮件节点（kind:email）：nodemailer SMTP 发送（{{}} 占位渲染），失败
 * 归因 email_send_failed（nodemailer mock）。mock 三件套沿用先例。
 */
import { describe, expect, it, vi, afterEach } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`) },
  Notification: vi.fn(),
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    // 去会话化：节点详情落 graphRunNode（session/message 两键已删）
    graphRunNode: { upsert: vi.fn(async () => ({ id: 1 })) },
    automationRun: { create: vi.fn(async () => ({ id: 9 })), update: vi.fn() },
    automationTask: { update: vi.fn() },
    graphDefinition: { findFirst: vi.fn() },
  },
}));
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../electron/domains/ai/agent/skill-loader", () => ({
  loadSkills: vi.fn(() => []),
}));
const transportMock = vi.hoisted(() => ({ sendMail: vi.fn() }));
vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => transportMock),
  },
}));

import prisma from "../../electron/commons/prisma-client";
import { executeGraphRun } from "../../electron/domains/ai/orchestration/graph-executor";

const run = (nodes: object[], inputs: Record<string, string> = {}) =>
  executeGraphRun({
    graph: {
      id: 5,
      name: "agg-demo",
      graphJson: JSON.stringify({
        version: 1,
        inputSchema: {},
        nodes,
        edges: [{ from: "n", to: "END" }],
      }),
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

const lastUpdate = () =>
  vi.mocked(prisma.automationRun.update).mock.calls.at(-1)![0];
const traceOf = () => JSON.parse(lastUpdate().data.graphTrace as string);

afterEach(() => {
  vi.mocked(prisma.automationRun.update).mockReset();
  vi.mocked(prisma.graphRunNode.upsert).mockClear();
  transportMock.sendMail.mockReset();
});

describe("aggregate 节点", () => {
  it("JSON 行数组：count/sum/avg/min/max/groupByCount/distinctCount", async () => {
    const rows = JSON.stringify([
      { amount: "10", cat: "a" },
      { amount: "20", cat: "b" },
      { amount: "30", cat: "a" },
    ]);
    const out = await run([
      {
        id: "n",
        name: "统计",
        kind: "aggregate",
        source: rows,
        ops: [
          { type: "count" },
          { type: "sum", field: "amount" },
          { type: "avg", field: "amount" },
          { type: "min", field: "amount" },
          { type: "max", field: "amount" },
          { type: "groupByCount", field: "cat" },
          { type: "distinctCount", field: "cat" },
        ],
      },
    ]);
    expect(out).toBe("success");
    expect(JSON.parse(traceOf()[0].outputPreview)).toEqual({
      count: 3,
      "sum:amount": 60,
      "avg:amount": 20,
      "min:amount": 10,
      "max:amount": 30,
      "groupByCount:cat": { a: 2, b: 1 },
      "distinctCount:cat": 2,
    });
  });

  it("多行文本：count + 整行去重 distinctCount（source 支持 {{}}）", async () => {
    const out = await run(
      [
        {
          id: "n",
          name: "统计",
          kind: "aggregate",
          source: "{{input.lines}}",
          ops: [{ type: "count" }, { type: "distinctCount" }],
        },
      ],
      { lines: "x\ny\nx" },
    );
    expect(out).toBe("success");
    expect(JSON.parse(traceOf()[0].outputPreview)).toEqual({
      count: 3,
      distinctCount: 2,
    });
  });

  it("sum 遇非数值字段 → aggregate_bad_field 节点失败", async () => {
    const out = await run([
      {
        id: "n",
        name: "统计",
        kind: "aggregate",
        source: JSON.stringify([{ amount: "abc" }]),
        ops: [{ type: "sum", field: "amount" }],
      },
    ]);
    expect(out).toBe("failed");
    expect(lastUpdate().data.error).toMatch(/node:n aggregate_bad_field/);
  });
});

describe("email 节点（SMTP）", () => {
  it("渲染占位后经 nodemailer 发送：to/subject/body 断言", async () => {
    transportMock.sendMail.mockResolvedValue({ messageId: "m-1" });
    const out = await run(
      [
        {
          id: "n",
          name: "发邮件",
          kind: "email",
          host: "smtp.example.com",
          port: 465,
          secure: true,
          username: "bot@example.com",
          password: "secret",
          from: "bot@example.com",
          to: "a@x.com, {{input.cc}}",
          subject: "日报 {{date}}",
          body: "今日完成 {{input.count}} 项",
        },
      ],
      { cc: "b@x.com", count: "5" },
    );
    expect(out).toBe("success");
    expect(transportMock.sendMail).toHaveBeenCalledTimes(1);
    const mail = transportMock.sendMail.mock.calls[0][0] as Record<
      string,
      string
    >;
    expect(mail.to).toBe("a@x.com, b@x.com");
    expect(mail.subject).toMatch(/日报 \d{4}-\d{2}-\d{2}/);
    expect(mail.text).toBe("今日完成 5 项");
    expect(traceOf()[0].outputPreview).toContain("m-1");
  });

  it("发送失败 → email_send_failed", async () => {
    transportMock.sendMail.mockRejectedValue(new Error("SMTP auth failed"));
    const out = await run([
      {
        id: "n",
        name: "发邮件",
        kind: "email",
        host: "smtp.example.com",
        port: 465,
        secure: true,
        username: "bot@example.com",
        password: "bad",
        from: "bot@example.com",
        to: "a@x.com",
        subject: "hi",
        body: "hello",
      },
    ]);
    expect(out).toBe("failed");
    expect(lastUpdate().data.error).toMatch(/node:n email_send_failed/);
  });
});

describe("email 节点重试（易抖节点 retries）", () => {
  it("sendMail 前两次闪断 + retries=2 → 第三次成功，节点成功", async () => {
    transportMock.sendMail
      .mockRejectedValueOnce(new Error("ECONNRESET 1"))
      .mockRejectedValueOnce(new Error("ECONNRESET 2"))
      .mockResolvedValue({ messageId: "m-2" });
    const out = await run([
      {
        id: "n",
        name: "发邮件",
        kind: "email",
        host: "smtp.example.com",
        port: 465,
        secure: true,
        username: "bot@example.com",
        password: "secret",
        from: "bot@example.com",
        to: "a@x.com",
        subject: "hi",
        body: "hello",
        retries: 2,
      },
    ]);
    expect(out).toBe("success");
    expect(transportMock.sendMail).toHaveBeenCalledTimes(3);
  });

  it("retries=0（缺省）→ 首次失败即节点失败", async () => {
    transportMock.sendMail
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValue({ messageId: "m-3" });
    const out = await run([
      {
        id: "n",
        name: "发邮件",
        kind: "email",
        host: "smtp.example.com",
        port: 465,
        secure: true,
        username: "bot@example.com",
        password: "secret",
        from: "bot@example.com",
        to: "a@x.com",
        subject: "hi",
        body: "hello",
      },
    ]);
    expect(out).toBe("failed");
    expect(transportMock.sendMail).toHaveBeenCalledTimes(1);
  });
});
