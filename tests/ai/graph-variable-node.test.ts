// tests/ai/graph-variable-node.test.ts
/**
 * 变量节点（kind:variable）：多变量赋值（source {{}} 渲染 + 顺序操作链
 * trim/upper/lower/replace/slice/default/append/toNumber）→ JSON 对象
 * 输出。mock 三件套沿用 graph-nodes-extra.test.ts 先例。
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

import prisma from "../../electron/commons/prisma-client";
import { executeGraphRun } from "../../electron/domains/ai/orchestration/graph-executor";

const run = (nodes: object[], inputs: Record<string, string> = {}) =>
  executeGraphRun({
    graph: {
      id: 5,
      name: "var-demo",
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
});

describe("variable 节点", () => {
  it("多变量赋值 + 顺序操作链 → JSON 对象输出", async () => {
    const out = await run(
      [
        {
          id: "n",
          name: "变量",
          kind: "variable",
          assignments: [
            {
              name: "fullName",
              source: "{{input.first}}",
              ops: [{ type: "trim" }, { type: "append", text: "-app" }],
            },
            {
              name: "upperName",
              source: "{{input.first}}",
              ops: [{ type: "trim" }, { type: "upper" }],
            },
            {
              name: "replaced",
              source: "{{input.first}}",
              ops: [
                { type: "trim" },
                { type: "replace", find: "tian", replacement: "天" },
              ],
            },
            {
              name: "sliced",
              source: "{{input.first}}",
              ops: [{ type: "trim" }, { type: "slice", start: 0, end: 4 }],
            },
          ],
        },
      ],
      { first: " tianshu " },
    );
    expect(out).toBe("success");
    expect(JSON.parse(traceOf()[0].outputPreview)).toEqual({
      fullName: "tianshu-app",
      upperName: "TIANSHU",
      replaced: "天shu",
      sliced: "tian",
    });
  });

  it("toNumber 数值化（非法数字保持原样）；default 空串兜底", async () => {
    const out = await run(
      [
        {
          id: "n",
          name: "变量",
          kind: "variable",
          assignments: [
            {
              name: "count",
              source: "{{input.n}}",
              ops: [{ type: "toNumber" }],
            },
            {
              name: "bad",
              source: "{{input.bad}}",
              ops: [{ type: "toNumber" }],
            },
            {
              name: "filled",
              source: "{{input.empty}}",
              ops: [{ type: "default", value: "兜底值" }],
            },
          ],
        },
      ],
      { n: "42", bad: "abc", empty: "" },
    );
    expect(out).toBe("success");
    expect(JSON.parse(traceOf()[0].outputPreview)).toEqual({
      count: 42,
      bad: "abc",
      filled: "兜底值",
    });
  });

  it("缺引用照常炸节点（模板引擎语义）→ graph_invalid 归因", async () => {
    const out = await run([
      {
        id: "n",
        name: "变量",
        kind: "variable",
        assignments: [{ name: "x", source: "{{input.ghost}}", ops: [] }],
      },
    ]);
    expect(out).toBe("failed");
  });
});

describe("variable 节点日期算子", () => {
  it("now → dateAdd → dateFormat：当前时间偏移后格式化（now 基准由执行器注入）", async () => {
    const out = await run(
      [
        {
          id: "n",
          name: "变量",
          kind: "variable",
          assignments: [
            {
              name: "deadline",
              source: "",
              ops: [
                { type: "now" },
                { type: "dateAdd", amount: 3, unit: "days" },
                { type: "dateFormat", format: "yyyy-MM-dd" },
              ],
            },
            {
              name: "lastMonthEnd",
              source: "{{input.today}}",
              ops: [
                { type: "dateAdd", amount: -1, unit: "months" },
                { type: "dateFormat", format: "yyyy/MM/dd" },
              ],
            },
            {
              name: "badDate",
              source: "{{input.notDate}}",
              ops: [{ type: "dateFormat", format: "yyyy" }],
            },
          ],
        },
      ],
      { today: "2026-10-06", notDate: "not-a-date" },
    );
    expect(out).toBe("success");
    const vars = JSON.parse(traceOf()[0].outputPreview);
    // now 基准 = 执行时刻：+3 天落在 [今天+2, 今天+4] 区间（防跨日边界）
    expect(vars.deadline).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(vars.deadline).getTime()).toBeGreaterThan(
      Date.now() + 1.5 * 86400_000,
    );
    expect(vars.lastMonthEnd).toBe("2026/09/06");
    // 非法日期串保持原样（不炸节点）
    expect(vars.badDate).toBe("not-a-date");
  });
});
