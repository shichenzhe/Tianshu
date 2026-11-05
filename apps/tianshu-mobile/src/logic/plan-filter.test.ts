// apps/tianshu-mobile/src/logic/plan-filter.test.ts
// 计划筛选条件管理纯函数测试（#8 桌面对齐批）：updater 族与桌面
// PlanFilterPopover 纯函数同构——语义基线以桌面实现为准（条件字段在
// 面板内唯一由调用方 toggle 保证，updater 本身纯追加/滤除/补丁）。
import { describe, expect, it } from "vitest";

import type { PlanFilterCondition } from "./plan-view";
import {
  DEFAULT_OPS,
  addConditionUpdater,
  emptyValueOf,
  patchConditionUpdater,
  removeConditionUpdater,
  setConditionOpUpdater,
  toggleConditionValueUpdater,
} from "./plan-filter";

const cond = (
  field: PlanFilterCondition["field"],
  op: PlanFilterCondition["op"],
  value: string | string[],
): PlanFilterCondition => ({ field, op, value });

describe("plan-filter 条件管理纯函数", () => {
  it("emptyValueOf：列表操作符空数组，其余空串", () => {
    expect(emptyValueOf("in")).toEqual([]);
    expect(emptyValueOf("notIn")).toEqual([]);
    expect(emptyValueOf("contains")).toBe("");
    expect(emptyValueOf("isMe")).toBe("");
    expect(emptyValueOf("notMe")).toBe("");
  });

  it("addConditionUpdater：追加缺省操作符与空值（DEFAULT_OPS 映射）", () => {
    const prev = [cond("title", "contains", "x")];
    const next = addConditionUpdater("status")(prev);
    expect(next).toEqual([
      cond("title", "contains", "x"),
      cond("status", "in", []),
    ]);
    expect(DEFAULT_OPS.assigneeId).toBe("isMe");
    expect(DEFAULT_OPS.tags).toBe("contains");
  });

  it("removeConditionUpdater：滤除指定字段条件，其余不动", () => {
    const prev = [
      cond("title", "contains", "x"),
      cond("status", "in", ["done"]),
    ];
    expect(removeConditionUpdater("title")(prev)).toEqual([
      cond("status", "in", ["done"]),
    ]);
    // 不存在字段 no-op
    expect(removeConditionUpdater("priority")(prev)).toEqual(prev);
  });

  it("patchConditionUpdater：局部补丁指定字段条件", () => {
    const prev = [cond("title", "contains", "x")];
    expect(patchConditionUpdater("title", { value: "y" })(prev)).toEqual([
      cond("title", "contains", "y"),
    ]);
  });

  it("setConditionOpUpdater：切操作符同时重置为对应空值（防跨形态残留）", () => {
    const prev = [cond("status", "contains" as never, "done")];
    expect(setConditionOpUpdater("status", "in")(prev)).toEqual([
      cond("status", "in", []),
    ]);
    expect(setConditionOpUpdater("status", "notIn")(prev)).toEqual([
      cond("status", "notIn", []),
    ]);
    // 字段不存在 no-op（原条件原样返回）
    expect(setConditionOpUpdater("title", "contains")(prev)).toEqual(prev);
  });

  it("toggleConditionValueUpdater：多选 toggle 追加/移除；单值字符串容错归一", () => {
    const base = [cond("status", "in", ["done"])];
    expect(toggleConditionValueUpdater("status", "paused")(base)).toEqual([
      cond("status", "in", ["done", "paused"]),
    ]);
    // 再点同一值即移除
    expect(
      toggleConditionValueUpdater("status", "done")(
        toggleConditionValueUpdater("status", "paused")(base),
      ),
    ).toEqual([cond("status", "in", ["paused"])]);
    // 遗留单值字符串归一为列表后 toggle
    const legacy = [cond("priority", "in", "P0")];
    expect(toggleConditionValueUpdater("priority", "P1")(legacy)).toEqual([
      cond("priority", "in", ["P0", "P1"]),
    ]);
  });
});
