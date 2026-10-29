/**
 * planToolDigest 纯函数测试（三期批 11 D15）：四工具各形态 + 字段缺失
 * 降级 + 畸形输入返回 null（渲染层回退现有文本形态，宁退不崩）。
 * 工具实名/输出文案口径对齐 electron plan-tools.ts（「共 N 项」「错误: ...」）
 */
import { describe, expect, it } from "vitest";

import { planToolDigest } from "../../src-react/domains/ai/chat/lib/plan-tool-summary";

describe("planToolDigest 四工具解析（批 11 D15）", () => {
  it("todo_write：标题可得 → 新建摘要（不依赖输出，运行中即可渲染）", () => {
    expect(planToolDigest("todo_write", { title: "调研竞品" })).toEqual({
      key: "chat:tool.plan.create",
      values: { title: "调研竞品" },
    });
  });

  it("todo_write：title 缺失/空白/args 畸形 → null", () => {
    expect(planToolDigest("todo_write", {})).toBeNull();
    expect(planToolDigest("todo_write", { title: "  " })).toBeNull();
    expect(planToolDigest("todo_write", null)).toBeNull();
    expect(planToolDigest("todo_write", "标题")).toBeNull();
  });

  it("todo_write：合法入参 → statusKey 复用既有状态文案映射（旧状态不在数据源，降级 #id → 新状态）", () => {
    expect(
      planToolDigest("todo_write", { id: 3, status: "in_progress" }),
    ).toEqual({
      key: "chat:tool.plan.update",
      values: { id: 3 },
      statusKey: "project:plan.statusInProgress",
    });
  });

  it("todo_write：id 缺失/非法状态枚举 → null", () => {
    expect(planToolDigest("todo_write", { status: "done" })).toBeNull();
    expect(
      planToolDigest("todo_write", { id: 3, status: "archived" }),
    ).toBeNull();
    expect(
      planToolDigest("todo_write", { id: "3", status: "done" }),
    ).toBeNull();
  });

  it("todo_write：text 截断 60 字符（卡片头单行语义）", () => {
    const digest = planToolDigest("todo_write", {
      id: 3,
      text: "进".repeat(80),
    });
    expect(digest).toEqual({
      key: "chat:tool.plan.append",
      values: { text: "进".repeat(60) },
    });
  });

  it("todo_write：text 缺失 → null", () => {
    expect(planToolDigest("todo_write", { id: 3 })).toBeNull();
  });

  it("todo_read：输出「共 N 项」解析计数（含空清单 0 项）", () => {
    expect(
      planToolDigest(
        "todo_read",
        {},
        "当前项目计划清单（共 3 项）：\n#1《a》",
      ),
    ).toEqual({ key: "chat:tool.plan.list", values: { count: 3 } });
    expect(
      planToolDigest("todo_read", {}, "当前项目计划清单为空（共 0 项）"),
    ).toEqual({ key: "chat:tool.plan.list", values: { count: 0 } });
  });

  it("todo_read：失败文案/无输出 → null（回退现有形态）", () => {
    expect(
      planToolDigest("todo_read", {}, "错误: 当前会话未关联项目"),
    ).toBeNull();
    expect(planToolDigest("todo_read", {})).toBeNull();
  });

  it("非四工具（todo_read/文件工具/未知）→ null", () => {
    expect(planToolDigest("todo_read", { id: 1 })).toBeNull();
    expect(planToolDigest("write", { path: "a.ts" })).toBeNull();
    expect(planToolDigest("whatever", {})).toBeNull();
  });
});
