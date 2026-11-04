// tests/ai/graph-excel-node.test.ts
/**
 * Excel 读取节点：maxRows 熔断（超上限报 excel_too_many_rows 防大表
 * 撑爆内存/输出；exceljs 真文件读写）。
 */
import { describe, expect, it, vi, beforeAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
  commandGate: vi.fn(() => "allow" as const),
}));

import prisma from "../../electron/commons/prisma-client";
import { executeGraphRun } from "../../electron/domains/ai/orchestration/graph-executor";

let workspaceDir: string;
let xlsxPath: string;

beforeAll(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "tianshu-excel-"));
  const ExcelJS = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Sheet1");
  sheet.addRow(["name", "score"]);
  sheet.addRow(["a", 1]);
  sheet.addRow(["b", 2]);
  sheet.addRow(["c", 3]);
  xlsxPath = path.join(workspaceDir, "data.xlsx");
  await wb.xlsx.writeFile(xlsxPath);
});

const excelGraph = (extra: object) => ({
  graph: {
    id: 6,
    name: "excel-demo",
    graphJson: JSON.stringify({
      version: 1,
      inputSchema: {},
      nodes: [
        {
          id: "read",
          name: "读表",
          kind: "excelRead",
          path: "data.xlsx",
          ...extra,
        },
      ],
      edges: [{ from: "read", to: "END" }],
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
  workspace: { id: 9, directoryPath: workspaceDir },
});

const lastRunUpdate = () =>
  vi.mocked(prisma.automationRun.update).mock.calls.at(-1)![0];

describe("excelRead maxRows 熔断", () => {
  it("缺省上限内（3 数据行 < 1000）→ 成功输出 JSON 行数组", async () => {
    const out = await executeGraphRun(excelGraph({}));
    expect(out).toBe("success");
    const trace = JSON.parse(lastRunUpdate().data.graphTrace as string);
    const rows = JSON.parse(
      // outputPreview 200 字截断，3 行短数据完整
      trace[0].outputPreview,
    ) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
  });

  it("超 maxRows → excel_too_many_rows 失败（不静默截断行数组）", async () => {
    const out = await executeGraphRun(excelGraph({ maxRows: 2 }));
    expect(out).toBe("failed");
    expect(lastRunUpdate().data.error).toMatch(/excel_too_many_rows/);
  });
});
