/** PlanViewApi 薄封装测试（沿用 tests/project/plan-item-api.test.ts 的 invoke mock 模式）：
 * 通道名小驼峰 + 参数透传 + query key 工厂形状 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({ invoke: invokeMock }));

import PlanViewApi, {
  PLAN_VIEWS_KEY,
} from "../../src-react/domains/project/api/plan-view.api";

describe("PlanViewApi", () => {
  beforeEach(() => vi.clearAllMocks());

  it("list 透传 planView:list", async () => {
    invokeMock.mockResolvedValue([]);
    await PlanViewApi.list(11);
    expect(invokeMock).toHaveBeenCalledWith("planView:list", 11);
  });

  it("create/update/remove/reorder 通道与参数", async () => {
    invokeMock.mockResolvedValue(undefined);
    await PlanViewApi.create({ projectId: 11, name: "看板", type: "kanban" });
    await PlanViewApi.update({ id: 1, name: "改名" });
    await PlanViewApi.remove(1);
    await PlanViewApi.reorder([{ id: 1, sortOrder: 0 }]);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "planView:create", {
      projectId: 11,
      name: "看板",
      type: "kanban",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "planView:update", {
      id: 1,
      name: "改名",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "planView:delete", 1);
    expect(invokeMock).toHaveBeenNthCalledWith(4, "planView:reorder", [
      { id: 1, sortOrder: 0 },
    ]);
  });

  it("PLAN_VIEWS_KEY 工厂", () => {
    expect(PLAN_VIEWS_KEY(11)).toEqual(["planViews", 11]);
  });
});
