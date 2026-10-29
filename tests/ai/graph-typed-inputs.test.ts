// tests/ai/graph-typed-inputs.test.ts
/**
 * typed 输入执行链（切片 D2）：
 * - db-client typed 参数：number/boolean 原生抵达驱动绑定（better-sqlite3
 *   为 Electron ABI，vitest 不可加载——仓内「两路替身法」先例，stub 捕获
 *   绑定值断言归一逻辑：boolean → 1/0）
 * - run_workflow 入口归一：typed inputs 原样直达 launch（number 保型）、
 *   required 缺参结构化回喂、enum 越界回喂、未声明键丢弃
 * - normalizeGraphInputs 空声明直通（旧图 inputSchema 未声明仍可透传）
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
// better-sqlite3 原生模块为 Electron ABI（vitest/Node 不可加载——仓内
// 「两路替身法」先例）：stub 只断言绑定值形态（toSqliteValue 归一逻辑）
vi.mock("better-sqlite3", () => {
  class DatabaseStub {
    static lastBind: unknown[] = [];
    prepare(sql: string) {
      const self = DatabaseStub;
      return {
        reader: /^SELECT/i.test(sql),
        run: (...values: unknown[]) => {
          self.lastBind = values;
          return { changes: values.length };
        },
        iterate: (..._values: unknown[]) => [],
      };
    }
    close() {}
  }
  return { default: DatabaseStub };
});

import { runDatabaseQuery } from "../../electron/domains/ai/orchestration/db-client";
import { makeRunWorkflowTool } from "../../electron/domains/ai/orchestration/create-workflow";
import { normalizeGraphInputs } from "../../packages/tianshu-core/src/graph-inputs";
import { validateGraph } from "../../packages/tianshu-core/src/graph-schema";

/** stub 捕获的最近一次绑定值 */
// eslint-disable-next-line import/order
import DatabaseStub from "better-sqlite3";

describe("db-client typed 参数（原生类型绑定，stub 捕获绑定值）", () => {
  it("number/boolean 原生抵达驱动绑定；sqlite 侧 boolean 归一 1/0", async () => {
    const ctx = { workspacePath: "/ws" } as never;
    const run = (params: Array<string | number | boolean>) =>
      runDatabaseQuery({
        engine: "sqlite",
        sqlitePath: "demo.db",
        host: "",
        port: 5432,
        database: "",
        username: "",
        password: "",
        sql: "INSERT INTO t (a, b) VALUES (?, ?)",
        params,
        maxRows: 10,
        batchRows: null,
        ctx,
      });
    await run([42.5, "x"]);
    // number 与 string 原样抵达绑定（无字符串化）
    expect(
      (DatabaseStub as unknown as { lastBind: unknown[] }).lastBind,
    ).toEqual([42.5, "x"]);
    await run([42.5, true]);
    // boolean 归一 1/0（better-sqlite3 不收布尔——toSqliteValue 逻辑）
    expect(
      (DatabaseStub as unknown as { lastBind: unknown[] }).lastBind,
    ).toEqual([42.5, 1]);
  });
});

/** run_workflow typed 流（stub 装配，先例 create-workflow.test.ts） */
const TYPED_GRAPH = (() => {
  const json = {
    version: 1,
    inputSchema: {
      amount: { type: "number", required: true },
      category: {
        type: "enum",
        enumValues: ["餐饮", "交通"],
        default: "餐饮",
      },
      note: { type: "string", required: false, default: "" },
    },
    nodes: [
      { id: "start", name: "开始", kind: "start", variables: ["amount"] },
      {
        id: "insert",
        name: "插入",
        kind: "database",
        engine: "sqlite",
        sqlitePath: "demo.db",
        sql: "INSERT INTO expense (amount, category) VALUES (?, ?)",
        params: ["{{input.amount}}", "{{input.category}}"],
      },
    ],
    edges: [
      { from: "start", to: "insert" },
      { from: "insert", to: "END" },
    ],
  };
  expect(validateGraph(json).ok).toBe(true);
  return json;
})();

const CTX = { workspacePath: "/ws", sessionId: 42 };

function makeStubs() {
  return {
    graphDefinition: {
      findFirst: vi.fn(async () => ({
        id: 1,
        name: "typed-flow",
        description: null,
        graphJson: JSON.stringify(TYPED_GRAPH),
        version: 1,
      })),
    },
    session: {
      findUnique: vi.fn(async () => ({ userId: 7, appId: null })),
    },
    workspace: {
      findFirst: vi.fn(async () => ({ id: 9, directoryPath: "/ws" })),
    },
  };
}

describe("run_workflow typed 入口归一", () => {
  it("number 保型直达 launch + default 填充 + 未声明键丢弃", async () => {
    const stubs = makeStubs();
    const launch = vi.fn();
    const tool = makeRunWorkflowTool({ ...stubs, launch } as never);
    const result = await tool.execute(CTX, {
      id: 1,
      inputs: { amount: 35, evil: "drop-me" },
    });
    expect(result).toContain("已启动");
    expect(launch).toHaveBeenCalledTimes(1);
    const params = launch.mock.calls[0][0];
    expect(params.inputs).toEqual({
      amount: 35,
      category: "餐饮",
      note: "",
    });
    // number 未被字符串化（原生类型直达执行层）
    expect(typeof params.inputs.amount).toBe("number");
  });

  it("required 缺参结构化回喂（可自纠）；enum 越界回喂值域", async () => {
    const stubs = makeStubs();
    const launch = vi.fn();
    const tool = makeRunWorkflowTool({ ...stubs, launch } as never);
    const missing = await tool.execute(CTX, { id: 1, inputs: {} });
    expect(missing).toContain("输入参数无效");
    expect(missing).toContain("缺少必填输入: amount");
    expect(launch).not.toHaveBeenCalled();
    const badEnum = await tool.execute(CTX, {
      id: 1,
      inputs: { amount: 1, category: "娱乐" },
    });
    expect(badEnum).toContain("餐饮|交通");
    expect(launch).not.toHaveBeenCalled();
  });

  it("空声明直通（旧图 inputSchema 未声明——模板仍可引用 input.x）", () => {
    const result = normalizeGraphInputs({}, { topic: "x", n: 3 });
    expect(result).toEqual({ ok: true, inputs: { topic: "x", n: 3 } });
  });
});
