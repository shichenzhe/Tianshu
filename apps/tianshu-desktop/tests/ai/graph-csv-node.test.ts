// tests/ai/graph-csv-node.test.ts
/**
 * CSV 读写节点：csvRead（RFC4180 流式解析——引号包裹/内嵌逗号与换行/
 * 双引号转义、maxRows 熔断、工作空间门禁）与 csvWrite（JSON 行数组 →
 * 转义序列化落盘）。mock 三件套沿用 graph-nodes-extra.test.ts 先例。
 */
import { describe, expect, it, vi, beforeAll, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
vi.mock("../../electron/domains/security/command-gate", () => ({
  commandGate: vi.fn(() => "allow" as const),
}));

import prisma from "../../electron/commons/prisma-client";
import { executeGraphRun } from "../../electron/domains/ai/orchestration/graph-executor";

let workspaceDir: string;

beforeAll(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "tianshu-csv-"));
});

afterEach(() => {
  vi.mocked(prisma.automationRun.update).mockReset();
  vi.mocked(prisma.graphRunNode.upsert).mockClear();
});

const run = (nodes: object[], edges: object[] = [{ from: "n", to: "END" }]) =>
  executeGraphRun({
    graph: {
      id: 5,
      name: "csv-demo",
      graphJson: JSON.stringify({ version: 1, inputSchema: {}, nodes, edges }),
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
    workspace: { id: 9, directoryPath: workspaceDir },
  });

const lastUpdate = () =>
  vi.mocked(prisma.automationRun.update).mock.calls.at(-1)![0];
const traceOf = () => JSON.parse(lastUpdate().data.graphTrace as string);

describe("csvRead 节点", () => {
  it("RFC4180：引号包裹（内嵌逗号/换行/双引号转义）正确解析，首行为键输出行数组 JSON", async () => {
    await fs.writeFile(
      path.join(workspaceDir, "orders.csv"),
      [
        "id,name,remark",
        '1,"Smith, John",plain',
        '2,"say ""hi""","line1\nline2"',
        "3,裸值,无引号",
      ].join("\n"),
      "utf8",
    );
    const out = await run([
      { id: "n", name: "读", kind: "csvRead", path: "orders.csv" },
    ]);
    expect(out).toBe("success");
    const rows = JSON.parse(traceOf()[0].outputPreview);
    expect(rows).toEqual([
      { id: "1", name: "Smith, John", remark: "plain" },
      { id: "2", name: 'say "hi"', remark: "line1\nline2" },
      { id: "3", name: "裸值", remark: "无引号" },
    ]);
  });

  it("分隔符可配（分号）", async () => {
    await fs.writeFile(path.join(workspaceDir, "semi.csv"), "a;b\n1;2", "utf8");
    const out = await run([
      {
        id: "n",
        name: "读",
        kind: "csvRead",
        path: "semi.csv",
        delimiter: "semicolon",
      },
    ]);
    expect(out).toBe("success");
    expect(JSON.parse(traceOf()[0].outputPreview)).toEqual([
      { a: "1", b: "2" },
    ]);
  });

  it("超过 maxRows → csv_too_many_rows 熔断", async () => {
    await fs.writeFile(
      path.join(workspaceDir, "big.csv"),
      "a\n1\n2\n3",
      "utf8",
    );
    const out = await run([
      { id: "n", name: "读", kind: "csvRead", path: "big.csv", maxRows: 2 },
    ]);
    expect(out).toBe("failed");
    expect(lastUpdate().data.error).toMatch(/node:n csv_too_many_rows/);
  });

  it("路径越界 → file_outside_workspace；文件缺失 → file_missing", async () => {
    const outside = await run([
      { id: "n", name: "读", kind: "csvRead", path: "../secret.csv" },
    ]);
    expect(outside).toBe("failed");
    expect(lastUpdate().data.error).toMatch(/node:n file_outside_workspace/);

    const missing = await run([
      { id: "n", name: "读", kind: "csvRead", path: "ghost.csv" },
    ]);
    expect(missing).toBe("failed");
    expect(lastUpdate().data.error).toMatch(/node:n file_missing/);
  });
});

describe("csvWrite 节点", () => {
  it("行数组 → 表头并集序列化；含逗号/引号/换行的值正确转义，可读回", async () => {
    const rows = JSON.stringify([
      { id: 1, name: "Smith, John", remark: 'say "hi"' },
      { id: 2, name: "多\n行", remark: "" },
    ]);
    const out = await run([
      {
        id: "n",
        name: "写",
        kind: "csvWrite",
        path: "out/export.csv",
        rowsSource: rows,
      },
    ]);
    expect(out).toBe("success");
    const written = await fs.readFile(
      path.join(workspaceDir, "out/export.csv"),
      "utf8",
    );
    expect(written).toBe(
      ["id,name,remark", '1,"Smith, John","say ""hi"""', '2,"多\n行",""'].join(
        "\n",
      ),
    );
    // 回读闭环：csvWrite 产物能被 csvRead 原样解析回
    await run([
      { id: "n", name: "读", kind: "csvRead", path: "out/export.csv" },
    ]);
    expect(JSON.parse(traceOf()[0].outputPreview)).toEqual([
      { id: "1", name: "Smith, John", remark: 'say "hi"' },
      { id: "2", name: "多\n行", remark: "" },
    ]);
  });

  it("rowsSource 非法 JSON → csv_rows_invalid", async () => {
    const out = await run([
      {
        id: "n",
        name: "写",
        kind: "csvWrite",
        path: "bad.csv",
        rowsSource: "不是数组",
      },
    ]);
    expect(out).toBe("failed");
    expect(lastUpdate().data.error).toMatch(/node:n csv_rows_invalid/);
  });
});
