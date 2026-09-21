/**
 * 计划事项 API 轻量单测（Task 4）：8 静态方法的 IPC 通道名 + 参数透传断言，
 * 外加 3 个 React Query key 工厂返回值（后续任务消费的缓存键）。
 * 依赖经 vi.mock 替换（@/lib/ipc 的 invoke），vi.hoisted 使 mock 引用
 * 在 vi.mock 工厂执行前初始化（沿用 plan-item-repo.test.ts 模式）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ invoke: invokeMock }));

import PlanItemApi, {
  PLAN_FIELDS_KEY,
  PLAN_ITEMS_KEY,
  PLAN_ITEMS_MINE_KEY,
  PLAN_ITEM_ATTACHMENTS_KEY,
} from "@/domains/project/api/plan-item.api";

describe("PlanItemApi", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("list 走 planItem:list 并透传项目 id", async () => {
    invokeMock.mockResolvedValue([]);
    await PlanItemApi.list(7);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith("planItem:list", 7);
  });

  it("listMine 走 planItem:listMine（userId 由 IPC 层 token 注入，不透传）", async () => {
    invokeMock.mockResolvedValue([]);
    await PlanItemApi.listMine();
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith("planItem:listMine");
  });

  it("create 走 planItem:create 并透传创建参数", async () => {
    const params = {
      createdById: 3,
      title: "联调环境",
      projectId: 7,
      status: "in_progress",
      priority: "P0",
      tags: ["后端"],
    } as const;
    await PlanItemApi.create(params);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith(
      "planItem:create",
      params,
    );
  });

  it("update 走 planItem:update 并透传局部更新参数", async () => {
    const params = { id: 12, status: "done" } as const;
    await PlanItemApi.update(params);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith(
      "planItem:update",
      params,
    );
  });

  it("remove 走 planItem:delete 并透传事项 id", async () => {
    await PlanItemApi.remove(12);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith("planItem:delete", 12);
  });

  it("move 走 planItem:move 并透传拖拽落点参数", async () => {
    const params = { id: 12, status: "paused", sortOrder: 3 } as const;
    await PlanItemApi.move(params);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith("planItem:move", params);
  });

  it("listFields 走 planItem:fields:list 并透传项目 id", async () => {
    invokeMock.mockResolvedValue([]);
    await PlanItemApi.listFields(7);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith(
      "planItem:fields:list",
      7,
    );
  });

  it("saveFields 走 planItem:fields:save 并透传项目 id 与字段定义全集", async () => {
    const fields = [
      { name: "工时", type: "number" },
      { name: "上线日", type: "date" },
    ] as const;
    await PlanItemApi.saveFields(7, fields);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith(
      "planItem:fields:save",
      7,
      fields,
    );
  });

  it("listAttachments 走 planItem:attachments:list 并透传事项 id", async () => {
    invokeMock.mockResolvedValue([]);
    await PlanItemApi.listAttachments(12);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith(
      "planItem:attachments:list",
      12,
    );
  });

  it("createAttachment 走 planItem:attachments:create 并透传事项 id 与附件输入", async () => {
    const input = { fileName: "a.pdf", assetPath: "attachments/a.pdf" };
    await PlanItemApi.createAttachment(12, input);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith(
      "planItem:attachments:create",
      12,
      input,
    );
  });

  it("removeAttachment 走 planItem:attachments:delete 并透传关联 id", async () => {
    await PlanItemApi.removeAttachment(31);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith(
      "planItem:attachments:delete",
      31,
    );
  });

  it("invoke 返回值原样透传给调用方", async () => {
    const rows = [{ id: 1, title: "联调" }];
    invokeMock.mockResolvedValue(rows);
    await expect(PlanItemApi.list(7)).resolves.toBe(rows);
  });
});

describe("计划事项 query key 工厂", () => {
  it("PLAN_ITEMS_KEY 以项目 id 区分计划 Tab 列表缓存", () => {
    expect(PLAN_ITEMS_KEY(7)).toEqual(["planItems", 7]);
  });

  it("PLAN_ITEMS_MINE_KEY 以用户 id 区分任务 Tab 聚合缓存", () => {
    expect(PLAN_ITEMS_MINE_KEY(3)).toEqual(["planItemsMine", 3]);
  });

  it("PLAN_FIELDS_KEY 以项目 id 区分自定义字段定义缓存", () => {
    expect(PLAN_FIELDS_KEY(7)).toEqual(["planFields", 7]);
  });

  it("PLAN_ITEM_ATTACHMENTS_KEY 以事项 id 区分附件关联缓存", () => {
    expect(PLAN_ITEM_ATTACHMENTS_KEY(12)).toEqual(["planItemAttachments", 12]);
  });
});
