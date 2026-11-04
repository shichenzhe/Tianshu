// @vitest-environment jsdom
/**
 * usePlanViews 测试：
 * - 纯函数 resolveInitialViewId：viewId 直取 / 旧 ?view= 按 type 映射 /
 *   失效回退首个
 * - renderHook 集成（真实 hook 逻辑走 React Query 层，仅 mock API 边界）：
 *   removeView 删除激活视图 → 失效重取后回退剩余首个；saveOverwrite 覆盖
 *   draft → 重取携带已存配置后 isDirty 归零；saveAsNew → 新建视图激活；
 *   变更失败（mock reject）→ invalidateQueries + toast.error 且激活视图不变
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

// mapIpcError → 错误 message 原样透传（免拉 @/i18n 完整实例）
vi.mock("@/domains/ai/chat/lib/error-message", () => ({
  mapIpcError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

// PlanViewApi 静态类整体 mock（视图数据源；key 工厂保留真实实现）
const planViewMock = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  reorder: vi.fn(),
}));
vi.mock("@/domains/project/api/plan-view.api", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/domains/project/api/plan-view.api")
    >();
  return {
    ...actual,
    default: planViewMock,
    PLAN_VIEWS_KEY: actual.PLAN_VIEWS_KEY,
  };
});

import {
  resolveInitialViewId,
  usePlanViews,
} from "../../src-react/domains/project/model/use-plan-views";
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

/** renderPlanViews 共用两视图场景：表格(10) 激活 + 看板(11) */
const TWO_VIEWS: PlanViewRecord[] = [
  view({ id: 10, type: "table", sortOrder: 0 }),
  view({ id: 11, type: "kanban", sortOrder: 1 }),
];

/** 挂载 hook（QueryClient + MemoryRouter 语境；返回 client 供失效断言）。
 *  .ts 文件无 JSX，wrapper 经 createElement 组装 */
function renderPlanViews() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: ["/module/project/1?tab=plan"] },
        children,
      ),
    );
  const rendered = renderHook(() => usePlanViews(1), { wrapper });
  return { ...rendered, client };
}

afterEach(() => {
  cleanup();
  planViewMock.list.mockReset();
  planViewMock.create.mockReset();
  planViewMock.update.mockReset();
  planViewMock.remove.mockReset();
  planViewMock.reorder.mockReset();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
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

describe("usePlanViews 变更动作", () => {
  it("removeView 删除激活视图 → 失效重取后回退剩余首个视图", async () => {
    planViewMock.list
      .mockResolvedValueOnce(TWO_VIEWS)
      .mockResolvedValue([TWO_VIEWS[1]]);
    planViewMock.remove.mockResolvedValue(undefined);
    const { result } = renderPlanViews();

    await waitFor(() => expect(result.current.views).toHaveLength(2));
    expect(result.current.activeViewId).toBe(10);

    await act(async () => {
      await result.current.removeView(10);
    });

    expect(planViewMock.remove).toHaveBeenCalledWith(10);
    expect(result.current.views).toHaveLength(1);
    expect(result.current.activeViewId).toBe(11);
  });

  it("saveOverwrite 覆盖保存 draft → 重取携带已存配置后 isDirty 归零", async () => {
    const saved = view({ id: 10, type: "kanban", groupBy: "status" });
    planViewMock.list
      .mockResolvedValueOnce([TWO_VIEWS[0], view({ id: 11, type: "kanban" })])
      .mockResolvedValue([saved, TWO_VIEWS[1]]);
    planViewMock.update.mockResolvedValue(undefined);
    const { result } = renderPlanViews();

    await waitFor(() => expect(result.current.views).toHaveLength(2));
    expect(result.current.isDirty).toBe(false);

    act(() => {
      result.current.setDraft((prev) => ({ ...prev, groupBy: "status" }));
    });
    expect(result.current.isDirty).toBe(true);

    await act(async () => {
      await result.current.saveOverwrite();
    });

    expect(planViewMock.update).toHaveBeenCalledWith({
      id: 10,
      groupBy: "status",
      filterJson: '{"conditions":[]}',
      sortJson: "[]",
    });
    // 失效重取后经订阅通知重渲染（异步传播），waitFor 到位后 isDirty 归零
    await waitFor(() => expect(result.current.isDirty).toBe(false));
  });

  it("saveAsNew(name) → 新建视图写入并激活（activeViewId = 新视图 id）", async () => {
    const created = view({ id: 12, name: "我的视图", type: "table" });
    planViewMock.list
      .mockResolvedValueOnce(TWO_VIEWS)
      .mockResolvedValue([...TWO_VIEWS, created]);
    planViewMock.create.mockResolvedValue(created);
    const { result } = renderPlanViews();

    await waitFor(() => expect(result.current.views).toHaveLength(2));

    await act(async () => {
      await result.current.saveAsNew("我的视图");
    });

    expect(planViewMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 1,
        name: "我的视图",
        type: "table",
      }),
    );
    expect(result.current.views).toHaveLength(3);
    expect(result.current.activeViewId).toBe(12);
    expect(result.current.activeView?.name).toBe("我的视图");
  });

  it("reorderViews 重排 → reorder 通道收到 0..n-1 载荷且 views 按新序重排", async () => {
    planViewMock.list.mockResolvedValue(TWO_VIEWS);
    planViewMock.reorder.mockResolvedValue(undefined);
    const { result } = renderPlanViews();
    await waitFor(() => expect(result.current.views).toHaveLength(2));

    await act(async () => {
      await result.current.reorderViews([11, 10]);
    });

    expect(planViewMock.reorder).toHaveBeenCalledWith([
      { id: 11, sortOrder: 0 },
      { id: 10, sortOrder: 1 },
    ]);
    // setQueryData 乐观写入经订阅通知重渲染（异步传播），waitFor 到位
    await waitFor(() =>
      expect(result.current.views.map((v) => v.id)).toEqual([11, 10]),
    );
    expect(result.current.views.map((v) => v.sortOrder)).toEqual([0, 1]);
  });

  it("removeView 失败（mock reject）→ invalidateQueries + toast.error，激活视图不变", async () => {
    planViewMock.list.mockResolvedValue(TWO_VIEWS);
    planViewMock.remove.mockRejectedValue(new Error("PLAN_VIEW_LAST_ONE"));
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    const { result } = renderPlanViews();

    await waitFor(() => expect(result.current.views).toHaveLength(2));

    await act(async () => {
      await result.current.removeView(10);
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["planViews", 1],
    });
    expect(toastMock.error).toHaveBeenCalledWith("PLAN_VIEW_LAST_ONE");
    expect(result.current.views).toHaveLength(2);
    expect(result.current.activeViewId).toBe(10);
    invalidateSpy.mockRestore();
  });
});
