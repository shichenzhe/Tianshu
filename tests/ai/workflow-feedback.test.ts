// tests/ai/workflow-feedback.test.ts
/**
 * 校验回喂闭环（切片 E1）：create_workflow 收到非法 graphJson 的回喂
 * 形状——字段级定位（哪个节点哪个字段）、zod 英文译中文、期望形态提示
 * （结合 D 的 inputSchema 双形态）；图级错误码一句话中文；超限折叠。
 * 目标：LLM 一轮内可自纠。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

import {
  formatGraphIssues,
  makeCreateWorkflowTool,
  makeUpdateWorkflowTool,
} from "../../electron/domains/ai/orchestration/create-workflow";

const CTX = { workspacePath: "/ws", sessionId: 42 };

const stubs = {
  graphDefinition: { create: vi.fn() },
  session: { findUnique: vi.fn(async () => ({ userId: 7, appId: null })) },
};

const startNode = {
  id: "start",
  name: "开始",
  kind: "start",
  variables: [],
};

describe("formatGraphIssues（回喂形状）", () => {
  it("zod 英文译中文：Required/枚举/类型不符 + 字段期望形态", () => {
    const text = formatGraphIssues([
      {
        code: "schema",
        params: {
          path: "nodes.insert-expense.sql",
          message: "Required",
          nodeId: "insert-expense",
        },
      },
      {
        code: "schema",
        params: {
          path: "nodes.insert-expense.engine",
          message:
            "Invalid enum value. Expected 'sqlite' | 'postgres' | 'mysql' | 'oracle' | 'sqlserver', received 'sqlite3'",
          nodeId: "insert-expense",
        },
      },
      {
        code: "schema",
        params: {
          path: "nodes.gen.modelId",
          message: "Expected number, received string",
          nodeId: "gen",
        },
      },
    ]);
    expect(text).toContain("节点「insert-expense」sql：缺少必填字段");
    expect(text).toContain("期望：单条 SQL 文本");
    expect(text).toContain("engine：取值必须是");
    expect(text).toContain("sqlite / postgres / mysql / oracle / sqlserver");
    expect(text).toContain("节点「gen」modelId：类型应为");
    expect(text).toContain("正整数（模型表 id）");
  });

  it("inputSchema 路径 → 双形态期望；自定义中文消息透传", () => {
    const text = formatGraphIssues([
      {
        code: "schema",
        params: {
          path: "inputSchema.category.enumValues",
          message: "enum 类型必须提供非空 enumValues",
        },
      },
      {
        code: "schema",
        params: {
          path: "inputSchema.amount.type",
          message:
            "Invalid enum value. Expected 'string' | 'number', received 'float'",
        },
      },
    ]);
    expect(text).toContain("图级 inputSchema.category.enumValues");
    expect(text).toContain("enum 类型必须提供非空 enumValues");
    expect(text).toContain("enumValues?（enum 必填非空不重复）");
    expect(text).toContain("type：取值必须是");
  });

  it("图级错误码一句话中文；超 12 项折叠计数", () => {
    const text = formatGraphIssues([
      { code: "uniqueEntry", params: { count: 2 } },
      ...Array.from({ length: 15 }, () => ({
        code: "schema",
        params: { path: "nodes.x.prompt", message: "Required", nodeId: "x" },
      })),
    ]);
    expect(text).toContain("入口不唯一");
    expect(text).toContain("另有 4 项问题");
    // 折叠后仍在限内（12 行 + 图级 1 行 + 折叠 1 行 = 14 行）
    expect(text.split("\n").length).toBeLessThanOrEqual(14);
  });
});

describe("节点 cookbook 静态注入（切片 E2）", () => {
  it("create/update 描述含全 kind 速查、范式与照猫画虎引导", () => {
    const create = makeCreateWorkflowTool(stubs as never);
    const update = makeUpdateWorkflowTool(stubs as never);
    for (const description of [create.description, update.description]) {
      expect(description).toContain("【节点速查】");
      expect(description).toContain("database（SQL+params 参数化");
      expect(description).toContain("merge（多上游模板聚合");
      expect(description).toContain("【常用范式】");
      expect(description).toContain("勿用 code 节点");
      expect(description).toContain("confirm_form");
      expect(description).toContain("【照猫画虎】");
      expect(description).toContain("get_workflow");
    }
  });
});

describe("create_workflow 坏图回喂（端到端形状）", () => {
  const tool = makeCreateWorkflowTool(stubs as never);

  it("缺必填字段的 database 节点：定位到节点与字段，含期望形态", async () => {
    const result = await tool.execute(CTX, {
      name: "bad-flow",
      graphJson: {
        version: 1,
        inputSchema: {},
        nodes: [
          startNode,
          {
            id: "insert-expense",
            name: "插入",
            kind: "database",
            engine: "sqlite",
            sqlitePath: "demo.db",
            // 缺 sql
          },
        ],
        edges: [
          { from: "start", to: "insert-expense" },
          { from: "insert-expense", to: "END" },
        ],
      },
    });
    expect(result).toContain("校验未通过");
    expect(result).toContain("节点「insert-expense」sql：缺少必填字段");
    expect(result).toContain("期望：单条 SQL 文本");
    expect(stubs.graphDefinition.create).not.toHaveBeenCalled();
  });

  it("inputSchema 非法对象形态：双形态期望提示（D 批上下文）", async () => {
    const result = await tool.execute(CTX, {
      name: "bad-schema-flow",
      graphJson: {
        version: 1,
        inputSchema: { amount: { type: "float" } },
        nodes: [startNode],
        edges: [{ from: "start", to: "END" }],
      },
    });
    expect(result).toContain("图级 inputSchema");
    expect(result).toContain(
      '简写 "string" 或对象 {type: "string"|"number"|"boolean"|"enum"|"date"',
    );
  });
});
