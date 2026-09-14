// tests/project/plan-view-engine.test.ts
/** 筛选引擎纯函数测试（子系统 A spec §前端）：filterItems 六字段×操作符、
 * AND 组合、搜索叠加、非法条件防御性忽略；sortItems 空规则缺省序（状态→
 * sortOrder→id）与多规则；groupItems 三种分组（空组保留、assignee 含
 * unassigned 与候选成员空组）；parseViewConfig 畸形 JSON 降级 */
import { describe, expect, it } from "vitest";
import {
  filterItems,
  groupItems,
  parseViewConfig,
  sortItems,
} from "../../src-react/domains/project/model/plan-view-engine";
import type { PlanItemRecord } from "../../electron/domains/project/plan-item.entity";

const item = (over: Partial<PlanItemRecord>): PlanItemRecord => ({
  id: 1,
  projectId: 11,
  title: "标题",
  status: "not_started",
  priority: "P1",
  assigneeId: 7,
  tags: [],
  customFields: {},
  sortOrder: 1,
  createdById: 1,
  source: "manual",
  startDate: "",
  dueDate: "",
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
  ...over,
});

const items = [
  item({
    id: 1,
    title: "写技术方案",
    status: "in_progress",
    priority: "P0",
    assigneeId: 7,
    tags: ["前端"],
  }),
  item({
    id: 2,
    title: "评审 PRD",
    status: "not_started",
    priority: "P2",
    assigneeId: 8,
    tags: ["产品"],
    source: "ai",
  }),
  item({
    id: 3,
    title: "修复登录",
    status: "done",
    priority: "P1",
    assigneeId: null,
    tags: [],
  }),
];

describe("filterItems", () => {
  it("空条件 + 空搜索 → 全量直通", () => {
    expect(filterItems(items, [], "", 7)).toHaveLength(3);
  });

  it("title contains 大小写不敏感子串", () => {
    expect(
      filterItems(
        items,
        [{ field: "title", op: "contains", value: "PRD" }],
        "",
        7,
      ),
    ).toEqual([items[1]]);
  });

  it("status in 多选命中", () => {
    expect(
      filterItems(
        items,
        [{ field: "status", op: "in", value: ["in_progress", "done"] }],
        "",
        7,
      ),
    ).toEqual([items[0], items[2]]);
  });

  it("status notIn 排除", () => {
    expect(
      filterItems(
        items,
        [{ field: "status", op: "notIn", value: ["done"] }],
        "",
        7,
      ),
    ).toEqual([items[0], items[1]]);
  });

  it("assigneeId isMe 只留当前用户的（含未指派排除）", () => {
    expect(
      filterItems(
        items,
        [{ field: "assigneeId", op: "isMe", value: "" }],
        "",
        7,
      ),
    ).toEqual([items[0]]);
  });

  it("assigneeId notMe 排除当前用户（未指派与他人命中）", () => {
    expect(
      filterItems(
        items,
        [{ field: "assigneeId", op: "notMe" as never, value: "" }],
        "",
        7,
      ),
    ).toEqual([items[1], items[2]]);
  });

  it("assigneeId in 按 id 字符串匹配", () => {
    expect(
      filterItems(
        items,
        [{ field: "assigneeId", op: "in", value: ["8"] }],
        "",
        7,
      ),
    ).toEqual([items[1]]);
  });

  it("source / priority in", () => {
    expect(
      filterItems(items, [{ field: "source", op: "in", value: ["ai"] }], "", 7),
    ).toEqual([items[1]]);
    expect(
      filterItems(
        items,
        [{ field: "priority", op: "in", value: ["P0", "P1"] }],
        "",
        7,
      ),
    ).toEqual([items[0], items[2]]);
  });

  it("tags contains 含任一指定标签即命中（value 数组）", () => {
    expect(
      filterItems(
        items,
        [{ field: "tags", op: "contains", value: ["前端"] }],
        "",
        7,
      ),
    ).toEqual([items[0]]);
  });

  it("多条件 AND 交集 + 搜索关键词叠加（仅匹配标题）", () => {
    const result = filterItems(
      items,
      [
        { field: "status", op: "in", value: ["in_progress", "not_started"] },
        { field: "priority", op: "in", value: ["P0", "P2"] },
      ],
      "评审",
      7,
    );
    expect(result).toEqual([items[1]]);
  });

  it("非法条件（未知 field/op）防御性忽略不抛错", () => {
    expect(
      filterItems(
        items,
        [
          { field: "hacker" as never, op: "in", value: ["x"] },
          { field: "status", op: "explode" as never, value: "x" },
        ],
        "",
        7,
      ),
    ).toHaveLength(3);
  });
});

describe("sortItems", () => {
  it("空规则 → 缺省序：状态序 → sortOrder → id", () => {
    const shuffled = [
      item({ id: 5, status: "not_started", sortOrder: 2 }),
      item({ id: 4, status: "done", sortOrder: 1 }),
      item({ id: 3, status: "not_started", sortOrder: 1 }),
    ];
    expect(sortItems(shuffled, []).map((i) => i.id)).toEqual([3, 5, 4]);
  });

  it("priority asc 按 P0<P1<P2<P3；title desc 倒序", () => {
    expect(
      sortItems(items, [{ field: "priority", dir: "asc" }]).map(
        (i) => i.priority,
      ),
    ).toEqual(["P0", "P1", "P2"]);
    expect(
      sortItems(items, [{ field: "title", dir: "desc" }]).map((i) => i.title),
    ).toEqual(["评审 PRD", "写技术方案", "修复登录"]);
  });

  it("dueDate asc：空日期排最后", () => {
    const withDates = [
      item({ id: 1, dueDate: "" }),
      item({ id: 2, dueDate: "2026-09-20T00:00:00.000Z" }),
      item({ id: 3, dueDate: "2026-09-15T00:00:00.000Z" }),
    ];
    expect(
      sortItems(withDates, [{ field: "dueDate", dir: "asc" }]).map((i) => i.id),
    ).toEqual([3, 2, 1]);
  });
});

describe("groupItems", () => {
  it("status 分组：四组全保留（含空组）", () => {
    const groups = groupItems(items, "status");
    expect(groups.map((g) => g.key)).toEqual([
      "not_started",
      "in_progress",
      "paused",
      "done",
    ]);
    expect(groups.find((g) => g.key === "paused")?.items).toEqual([]);
    expect(groups.find((g) => g.key === "in_progress")?.items).toEqual([
      items[0],
    ]);
  });

  it("priority 分组：P0-P3 四组", () => {
    expect(groupItems(items, "priority").map((g) => g.key)).toEqual([
      "P0",
      "P1",
      "P2",
      "P3",
    ]);
  });

  it("assignee 分组：unassigned + 候选成员组（无事项成员也保留空组）", () => {
    const members = [
      { userId: 7, nickname: "黄", username: "hjx", role: "owner" },
      { userId: 9, nickname: "九", username: "u9", role: "member" },
    ];
    const groups = groupItems(items, "assignee", members);
    expect(groups.map((g) => g.key)).toEqual(["unassigned", "7", "9", "8"]);
    expect(groups.find((g) => g.key === "unassigned")?.items).toEqual([
      items[2],
    ]);
    expect(groups.find((g) => g.key === "9")?.items).toEqual([]);
  });

  it("assignee 分组：无候选时按数据内出现的 assigneeId 生成组", () => {
    expect(groupItems(items, "assignee").map((g) => g.key)).toEqual([
      "unassigned",
      "7",
      "8",
    ]);
  });
});

describe("parseViewConfig 容错", () => {
  it("合法 JSON 解析；畸形/形状不符降级空配置", () => {
    expect(parseViewConfig("{}", "[]")).toEqual({
      conditions: [],
      sortRules: [],
    });
    expect(
      parseViewConfig(
        JSON.stringify({
          conditions: [{ field: "status", op: "in", value: ["done"] }],
        }),
        JSON.stringify([{ field: "dueDate", dir: "asc" }]),
      ),
    ).toEqual({
      conditions: [{ field: "status", op: "in", value: ["done"] }],
      sortRules: [{ field: "dueDate", dir: "asc" }],
    });
    expect(parseViewConfig("not-json{", "[[")).toEqual({
      conditions: [],
      sortRules: [],
    });
    expect(parseViewConfig(JSON.stringify({ nope: 1 }), "42")).toEqual({
      conditions: [],
      sortRules: [],
    });
  });
});
