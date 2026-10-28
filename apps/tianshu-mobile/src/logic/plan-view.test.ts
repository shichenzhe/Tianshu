// apps/tianshu-mobile/src/logic/plan-view.test.ts
/** plan-view 双份移植的钉测试（与 packages/tianshu-core 同名实现行为对齐） */
import { describe, expect, it } from "vitest";
import type { PlanItemRecordDto } from "@tianshu/protocol";

import {
  dateKeyToIso,
  filterPlanItems,
  groupPlanItems,
  isoToDateKey,
  parsePlanViewConfig,
  sortPlanItems,
} from "./plan-view";

function item(partial: Partial<PlanItemRecordDto>): PlanItemRecordDto {
  return {
    id: 1,
    projectId: 1,
    title: "任务",
    description: "",
    aiSummary: "",
    status: "not_started",
    priority: "P1",
    assigneeId: null,
    tags: [],
    customFields: {},
    startDate: "",
    dueDate: "",
    source: "manual",
    sortOrder: 0,
    createdById: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...partial,
  };
}

describe("filterPlanItems", () => {
  const items = [
    item({ id: 1, title: "修复登录 Bug", status: "in_progress" }),
    item({ id: 2, title: "写周报", status: "done", assigneeId: 7 }),
  ];

  it("状态 in 过滤 + 标题搜索叠加", () => {
    expect(
      filterPlanItems(items, [{ field: "status", op: "in", value: ["done"] }], "周报", 0),
    ).toHaveLength(1);
    expect(
      filterPlanItems(items, [{ field: "status", op: "in", value: ["done"] }], "登录", 0),
    ).toHaveLength(0);
  });

  it("assigneeId isMe 匹配当前用户", () => {
    expect(
      filterPlanItems(
        items,
        [{ field: "assigneeId", op: "isMe", value: "" }],
        "",
        7,
      ),
    ).toHaveLength(1);
  });

  it("未知条件恒真（忽略）", () => {
    expect(
      filterPlanItems(
        items,
        [{ field: "title", op: "in", value: "x" } as never],
        "",
        0,
      ),
    ).toHaveLength(2);
  });
});

describe("sortPlanItems", () => {
  it("空规则走缺省序：状态序 → sortOrder → id", () => {
    const items = [
      item({ id: 3, status: "done", sortOrder: 0 }),
      item({ id: 1, status: "not_started", sortOrder: 5 }),
      item({ id: 2, status: "not_started", sortOrder: 1 }),
    ];
    expect(sortPlanItems(items, []).map((i) => i.id)).toEqual([2, 1, 3]);
  });

  it("标题规则升序；空日期恒排最后", () => {
    const items = [
      item({ id: 1, title: "b", dueDate: "" }),
      item({ id: 2, title: "a", dueDate: "2026-10-02T00:00:00.000Z" }),
    ];
    expect(
      sortPlanItems(items, [{ field: "title", dir: "asc" }]).map((i) => i.id),
    ).toEqual([2, 1]);
  });
});

describe("groupPlanItems", () => {
  it("status 分组保留全枚举空组", () => {
    const groups = groupPlanItems(
      [item({ status: "done" })],
      "status",
    );
    expect(groups.map((g) => g.key)).toEqual([
      "not_started",
      "in_progress",
      "paused",
      "done",
    ]);
    expect(groups.find((g) => g.key === "done")?.items).toHaveLength(1);
  });
});

describe("parsePlanViewConfig", () => {
  it("畸形 JSON 降级空配置", () => {
    expect(parsePlanViewConfig("{bad", "[1,")).toEqual({
      conditions: [],
      sortRules: [],
    });
  });

  it("合法配置解析出条件与规则", () => {
    const { conditions, sortRules } = parsePlanViewConfig(
      JSON.stringify({
        conditions: [{ field: "status", op: "in", value: ["done"] }],
      }),
      JSON.stringify([{ field: "dueDate", dir: "asc" }]),
    );
    expect(conditions).toHaveLength(1);
    expect(sortRules).toEqual([{ field: "dueDate", dir: "asc" }]);
  });
});

describe("日期键", () => {
  it("isoToDateKey 取日历日，空串透传", () => {
    expect(isoToDateKey("2026-10-02T00:00:00.000Z")).toBe("2026-10-02");
    expect(isoToDateKey("")).toBe("");
  });

  it("dateKeyToIso UTC 零点", () => {
    expect(dateKeyToIso("2026-10-02")).toBe("2026-10-02T00:00:00.000Z");
  });
});
