/**
 * openTaskSession 单测（批 5 D6：任务 → 专属会话直达）：
 * - 复用：["sessions","all"] 缓存命中既有任务会话 → 直接跳转零创建
 * - 新建：create（projectId/planItemId/title，不传 workspaceId——后端解析
 *   资产空间）→ 失效 ["sessions"] → 跳新会话
 * - 失败：toast 兜底恰一次，不失效缓存不跳转（错误已在函数内消化）
 * - 本地任务（projectId null）：防御性直接返回，无任何副作用
 * SessionApi/mapIpcError/sonner 均 mock；queryClient 用真实实例
 * （setQueryData 置缓存，invalidateQueries spy 观察失效）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

const createMock = vi.hoisted(() => vi.fn());
const archiveMock = vi.hoisted(() => vi.fn());
vi.mock("@/domains/ai/api/session.api", () => ({
  default: { create: createMock, archive: archiveMock },
}));
vi.mock("@/domains/ai/chat/lib/error-message", () => ({
  mapIpcError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
const toastMock = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

import { openTaskSession } from "../../src-react/domains/project/lib/task-session";
import type { PlanItemRecord } from "../../electron/domains/project/plan-item.entity";

type NavigateFn = ReturnType<typeof vi.fn>;

/** 项目任务夹具（planItem 最小字段） */
const PLAN_ITEM: Pick<PlanItemRecord, "id" | "projectId" | "title"> = {
  id: 55,
  projectId: 11,
  title: "调研竞品",
};

/** 带可选会话缓存的 QueryClient（与真实消费方同 key） */
function makeClient(
  cached?: Array<{ id: number; planItemId?: number | null }>,
) {
  const client = new QueryClient();
  if (cached) {
    client.setQueryData(["sessions", "all"], cached);
  }
  return client;
}

beforeEach(() => {
  createMock.mockReset();
  archiveMock.mockReset().mockResolvedValue(undefined);
  toastMock.error.mockReset();
});

describe("openTaskSession（推进 → 任务专属会话）", () => {
  it("缓存命中既有任务会话 → 直接跳转，不创建不失效", async () => {
    const navigate: NavigateFn = vi.fn();
    const client = makeClient([
      { id: 8, planItemId: null },
      { id: 9, planItemId: 55 },
    ]);
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    await openTaskSession(client, navigate, PLAN_ITEM);

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/module/ai?session=9");
    expect(createMock).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("缓存未命中 → create（projectId/planItemId/title，不传 workspaceId）→ 失效 sessions → 跳新会话", async () => {
    const navigate: NavigateFn = vi.fn();
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    createMock.mockResolvedValue({ id: 12 });

    await openTaskSession(client, navigate, PLAN_ITEM);

    expect(createMock).toHaveBeenCalledWith({
      projectId: 11,
      planItemId: 55,
      title: "调研竞品",
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["sessions"] });
    expect(navigate).toHaveBeenCalledWith("/module/ai?session=12");
  });

  it("create 失败 → toast 兜底恰一次，不失效不跳转", async () => {
    const navigate: NavigateFn = vi.fn();
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    createMock.mockRejectedValue(new Error("PROJECT_NOT_FOUND"));

    await openTaskSession(client, navigate, PLAN_ITEM);

    expect(toastMock.error).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("本地任务（projectId null）→ 防御性直接返回，无副作用", async () => {
    const navigate: NavigateFn = vi.fn();
    const client = makeClient();

    await openTaskSession(client, navigate, {
      id: 77,
      projectId: null,
      title: "本地任务",
    });

    expect(createMock).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("create 复用返回归档会话（D9）→ 先撤销归档再失效跳转", async () => {
    const navigate: NavigateFn = vi.fn();
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    createMock.mockResolvedValue({ id: 12, archivedAt: "2026-09-01" });

    await openTaskSession(client, navigate, PLAN_ITEM);

    // 后端查重不看归档——撤销归档使 listAll 可见/ChatView 落点正常
    expect(archiveMock).toHaveBeenCalledWith(12, false);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["sessions"] });
    expect(navigate).toHaveBeenCalledWith("/module/ai?session=12");
  });

  it("撤销归档失败（D9）→ toast 兜底，不失效不跳转", async () => {
    const navigate: NavigateFn = vi.fn();
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    createMock.mockResolvedValue({ id: 12, archivedAt: "2026-09-01" });
    archiveMock.mockRejectedValue(new Error("SESSION_NOT_FOUND"));

    await openTaskSession(client, navigate, PLAN_ITEM);

    expect(toastMock.error).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("create 返回未归档会话 → 不调撤销归档（直通失效跳转）", async () => {
    const navigate: NavigateFn = vi.fn();
    const client = makeClient();
    createMock.mockResolvedValue({ id: 13, archivedAt: null });

    await openTaskSession(client, navigate, PLAN_ITEM);

    expect(archiveMock).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/module/ai?session=13");
  });
});
