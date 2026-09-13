// tests/project/use-plan-views.test.ts
/** usePlanViews 纯函数部分测试：resolveInitialViewId 的 viewId 直取 /
 * 旧 ?view= 按 type 映射 / 失效回退首个 */
import { describe, expect, it } from "vitest";
import { resolveInitialViewId } from "../../src-react/domains/project/model/use-plan-views";
import type { PlanViewRecord } from "../../electron/domains/project/plan-view.entity";

const view = (over: Partial<PlanViewRecord>): PlanViewRecord => ({
  id: 1,
  projectId: 11,
  name: "",
  type: "table",
  groupBy: null,
  filterJson: "{}",
  sortJson: "[]",
  sortOrder: 0,
  createdAt: "",
  updatedAt: "",
  ...over,
});

describe("resolveInitialViewId", () => {
  const views = [
    view({ id: 10, type: "table", sortOrder: 0 }),
    view({ id: 11, type: "kanban", sortOrder: 1 }),
  ];

  it("viewId 参数命中 → 直取", () => {
    expect(resolveInitialViewId(views, "11", null)).toBe(11);
  });

  it("旧参数 ?view=kanban → 按 type 映射（平滑兼容）", () => {
    expect(resolveInitialViewId(views, null, "kanban")).toBe(11);
    expect(resolveInitialViewId(views, null, "table")).toBe(10);
  });

  it("viewId 失效/无参数 → 回退首个", () => {
    expect(resolveInitialViewId(views, "999", null)).toBe(10);
    expect(resolveInitialViewId(views, null, null)).toBe(10);
    expect(resolveInitialViewId([], null, null)).toBeNull();
  });
});
