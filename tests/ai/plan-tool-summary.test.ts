/**
 * planToolDigest 纯函数测试（三期批 11 D15）：四工具各形态 + 字段缺失
 * 降级 + 畸形输入返回 null（渲染层回退现有文本形态，宁退不崩）。
 * 工具实名/输出文案口径对齐 electron plan-tools.ts（「共 N 项」「错误: ...」）
 */
import { describe, expect, it } from "vitest";

import { planToolDigest } from "../../src-react/domains/ai/chat/lib/plan-tool-summary";

describe("planToolDigest 四工具解析（批 11 D15）", () => {
  it("plan_create_item：标题可得 → 新建摘要（不依赖输出，运行中即可渲染）", () => {
    expect(planToolDigest("plan_create_item", { title: "调研竞品" })).toEqual({
      key: "chat:tool.plan.create",
      values: { title: "调研竞品" },
    });
  });

  it("plan_create_item：title 缺失/空白/args 畸形 → null", () => {
    expect(planToolDigest("plan_create_item", {})).toBeNull();
    expect(planToolDigest("plan_create_item", { title: "  " })).toBeNull();
    expect(planToolDigest("plan_create_item", null)).toBeNull();
    expect(planToolDigest("plan_create_item", "标题")).toBeNull();
  });

  it("plan_update_status：合法入参 → statusKey 复用既有状态文案映射（旧状态不在数据源，降级 #id → 新状态）", () => {
    expect(
      planToolDigest("plan_update_status", { id: 3, status: "in_progress" }),
    ).toEqual({
      key: "chat:tool.plan.update",
      values: { id: 3 },
      statusKey: "project:plan.statusInProgress",
    });
  });

  it("plan_update_status：id 缺失/非法状态枚举 → null", () => {
    expect(planToolDigest("plan_update_status", { status: "done" })).toBeNull();
    expect(
      planToolDigest("plan_update_status", { id: 3, status: "archived" }),
    ).toBeNull();
    expect(
      planToolDigest("plan_update_status", { id: "3", status: "done" }),
    ).toBeNull();
  });

  it("plan_append_summary：text 截断 60 字符（卡片头单行语义）", () => {
    const digest = planToolDigest("plan_append_summary", {
      id: 3,
      text: "进".repeat(80),
    });
    expect(digest).toEqual({
      key: "chat:tool.plan.append",
      values: { text: "进".repeat(60) },
    });
  });

  it("plan_append_summary：text 缺失 → null", () => {
    expect(planToolDigest("plan_append_summary", { id: 3 })).toBeNull();
  });

  it("plan_list_items：输出「共 N 项」解析计数（含空清单 0 项）", () => {
    expect(
      planToolDigest(
        "plan_list_items",
        {},
        "当前项目计划清单（共 3 项）：\n#1《a》",
      ),
    ).toEqual({ key: "chat:tool.plan.list", values: { count: 3 } });
    expect(
      planToolDigest("plan_list_items", {}, "当前项目计划清单为空（共 0 项）"),
    ).toEqual({ key: "chat:tool.plan.list", values: { count: 0 } });
  });

  it("plan_list_items：失败文案/无输出 → null（回退现有形态）", () => {
    expect(
      planToolDigest("plan_list_items", {}, "错误: 当前会话未关联项目"),
    ).toBeNull();
    expect(planToolDigest("plan_list_items", {})).toBeNull();
  });

  it("非四工具（plan_get_item/文件工具/未知）→ null", () => {
    expect(planToolDigest("plan_get_item", { id: 1 })).toBeNull();
    expect(planToolDigest("write_file", { path: "a.ts" })).toBeNull();
    expect(planToolDigest("whatever", {})).toBeNull();
  });
});
