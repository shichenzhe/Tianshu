// tests/ai/graph-db-page.test.ts
/**
 * 大表分页抽取机制端到端：父图 while 循环（carry=累计 offset）驱动
 * 分片子图（sqlite LIMIT/OFFSET + nodejs 累计、空页 DONE），验证
 * db-page-extract/db-page-child 模板宣称的分片循环真实可跑。mock 三件套
 * 沿用 graph-nodes-extra.test.ts 先例。
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

/** better-sqlite3 二进制随 Electron ABI（149）编译，系统 Node（147）加载
 * 失败——真跑用例仅 Electron ABI 宿主可跑（先例 graph-nodes-extra
 * .test.ts 的 database 组），其余宿主跳过而非误报 */
const sqliteNative = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const D = require("better-sqlite3");
    const probe = new D(":memory:");
    probe.close();
    return true;
  } catch {
    return false;
  }
})();

const beforeAllHook = async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "tianshu-dbpage-"));
  // 2500 行源表：2 个满页（1000/页）+ 1 个半页 → 第 3 轮读尽、第 4 轮空页 DONE
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3");
  const db = new Database(path.join(workspaceDir, "app.db"));
  db.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, name TEXT)");
  const insert = db.prepare("INSERT INTO records (name) VALUES (?)");
  db.transaction(() => {
    for (let i = 1; i <= 2500; i += 1) {
      insert.run(`row-${i}`);
    }
  })();
  db.close();
};

afterEach(() => {
  vi.mocked(prisma.automationRun.update).mockReset();
  vi.mocked(prisma.graphRunNode.upsert).mockClear();
});

/** 分片子图（db-page-child 模板同构）：OFFSET 取注入 acc，输出新累计，
 * 空页输出 DONE */
const childGraphRow = () => ({
  id: 77,
  name: "分片子图",
  graphJson: JSON.stringify({
    version: 1,
    inputSchema: { acc: "string" },
    nodes: [
      {
        id: "fetch",
        name: "fetch",
        kind: "database",
        engine: "sqlite",
        sqlitePath: "app.db",
        sql: "SELECT id, name FROM records ORDER BY id LIMIT 1000 OFFSET {{input.acc}}",
        params: [],
        maxRows: 1001,
      },
      {
        id: "step",
        name: "step",
        kind: "code",
        language: "nodejs",
        script: [
          'import { readFileSync } from "node:fs";',
          'const payload = JSON.parse(readFileSync(0, "utf-8"));',
          'const acc = Number(payload.inputs.acc || "0");',
          'const rows = JSON.parse(payload.nodes.fetch?.output || "[]");',
          'console.log(rows.length === 0 ? "DONE" : String(acc + rows.length));',
        ].join("\n"),
        timeoutMs: 30_000,
      },
    ],
    edges: [
      { from: "fetch", to: "step" },
      { from: "step", to: "END" },
    ],
  }),
  version: 1,
  enabled: true,
  userId: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const lastUpdate = () =>
  vi.mocked(prisma.automationRun.update).mock.calls.at(-1)![0];
const traceOf = () => JSON.parse(lastUpdate().data.graphTrace as string);

(sqliteNative ? describe : describe.skip)(
  "大表分页抽取（while + carry + DONE）",
  () => {
    beforeAll(beforeAllHook);
    it("2500 行按 1000/页分 4 轮读尽后 DONE 终止，末轮累计 2500", async () => {
      vi.mocked(prisma.graphDefinition.findFirst).mockResolvedValue(
        childGraphRow() as never,
      );
      const out = await executeGraphRun({
        graph: {
          id: 5,
          name: "db-page-extract",
          graphJson: JSON.stringify({
            version: 1,
            inputSchema: {},
            nodes: [
              {
                id: "loop",
                name: "loop",
                kind: "iterate",
                loopMode: "while",
                itemsSource: "",
                graphId: 77,
                carryVariable: "acc",
                carryInitial: "0",
                maxItems: 10,
                breakCondition: {
                  source: "{{nodes.loop.output}}",
                  operator: "contains",
                  value: "DONE",
                },
              },
            ],
            edges: [{ from: "loop", to: "END" }],
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
      expect(out).toBe("success");
      const loop = traceOf()[0];
      // 轮次输出 1000/2000/2500/DONE 按行 join（空页轮 DONE 命中即停）
      expect(loop.outputPreview).toContain("1000");
      expect(loop.outputPreview).toContain("2000");
      expect(loop.outputPreview).toContain("2500");
      expect(loop.outputPreview).toContain("DONE");
      // 第 5 轮未发生：不存在累计 3500 的行
      expect(loop.outputPreview).not.toContain("3500");
    });
  },
);
