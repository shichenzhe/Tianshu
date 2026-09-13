/**
 * 计划视图仓储（子系统 A spec §主进程）：list（空则懒播种两条默认视图）、
 * create（重名自动 (n) 后缀、sortOrder 列尾）、update（局部键）、
 * remove（最后一个视图拒删）、reorder（批量）。
 * filterJson/sortJson 读取时解析失败静默降级默认值并 console.warn。
 */
import { ipcMain } from "electron";
import prisma from "../../commons/prisma-client";
import {
  PLAN_GROUP_BYS,
  PLAN_VIEW_LAST_ONE,
  PLAN_VIEW_TYPES,
  type PlanGroupBy,
  type PlanViewCreateParams,
  type PlanViewRecord,
  type PlanViewType,
  type PlanViewUpdateParams,
} from "./plan-view.entity";

type PlanViewRow = NonNullable<
  Awaited<ReturnType<typeof prisma.planView.findFirst>>
>;

/** JSON 列读取容错：畸形 JSON → fallback 并 warn */
function parseJsonOr(raw: string | null, fallback: string): string {
  if (raw === null) {
    return fallback;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      return raw;
    }
  } catch {
    // 落入下方降级
  }
  console.warn("planView JSON 列畸形已降级", raw);
  return fallback;
}

export default class PlanViewRepository {
  constructor() {
    this.registerHandlers();
  }

  private registerHandlers() {
    ipcMain.handle("planView:list", (_, projectId: number) =>
      this.list(projectId),
    );
    ipcMain.handle("planView:create", (_, params: PlanViewCreateParams) =>
      this.create(params),
    );
    ipcMain.handle("planView:update", (_, params: PlanViewUpdateParams) =>
      this.update(params),
    );
    ipcMain.handle("planView:delete", (_, id: number) => this.remove(id));
    ipcMain.handle(
      "planView:reorder",
      (_, items: Array<{ id: number; sortOrder: number }>) =>
        this.reorder(items),
    );
  }

  /** 项目全部视图（sortOrder asc + id asc）；空列表懒播种默认两条（单进程 IPC 串行下并发首载不会发生） */
  async list(projectId: number): Promise<PlanViewRecord[]> {
    let rows = await prisma.planView.findMany({
      where: { projectId },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });
    if (rows.length === 0) {
      await prisma.$transaction([
        prisma.planView.create({
          data: { projectId, name: "", type: "table", sortOrder: 0 },
        }),
        prisma.planView.create({
          data: { projectId, name: "", type: "kanban", sortOrder: 1 },
        }),
      ]);
      rows = await prisma.planView.findMany({
        where: { projectId },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      });
    }
    return rows.map((row) => this.toRecord(row));
  }

  /** 创建视图：type 枚举校验 + 重名自动 (n) 后缀 + sortOrder 列尾 */
  async create(params: PlanViewCreateParams): Promise<PlanViewRecord> {
    this.ensureEnumOrThrow(params.type, PLAN_VIEW_TYPES, "无效的视图类型");
    if (params.groupBy !== undefined && params.groupBy !== null) {
      this.ensureEnumOrThrow(params.groupBy, PLAN_GROUP_BYS, "无效的分组依据");
    }
    const name = params.name?.trim() ?? "";
    const row = await prisma.planView.create({
      data: {
        projectId: params.projectId,
        name: await this.uniqueName(params.projectId, name),
        type: params.type,
        groupBy: params.groupBy ?? null,
        filterJson: params.filterJson ?? "{}",
        sortJson: params.sortJson ?? "[]",
        sortOrder: await this.nextSortOrder(params.projectId),
      },
    });
    return this.toRecord(row);
  }

  /** 局部更新：仅写入传入键；type/groupBy 枚举校验；groupBy 传 null = 清除分组 */
  async update(params: PlanViewUpdateParams): Promise<void> {
    const row = await prisma.planView.findUnique({ where: { id: params.id } });
    if (!row) {
      throw new Error("视图不存在");
    }
    this.ensureEnumOrThrow(params.type, PLAN_VIEW_TYPES, "无效的视图类型");
    if (params.groupBy !== undefined && params.groupBy !== null) {
      this.ensureEnumOrThrow(params.groupBy, PLAN_GROUP_BYS, "无效的分组依据");
    }
    const data = this.buildUpdateData(params);
    await prisma.planView.update({ where: { id: params.id }, data });
  }

  /** 删除：最后一个视图拒删（单一不变量：项目至少保留一个视图） */
  async remove(id: number): Promise<void> {
    const row = await prisma.planView.findUnique({ where: { id } });
    if (!row) {
      return;
    }
    const count = await prisma.planView.count({
      where: { projectId: row.projectId },
    });
    if (count <= 1) {
      throw new Error(PLAN_VIEW_LAST_ONE);
    }
    await prisma.planView.delete({ where: { id } });
  }

  /** Tab 顺序批量更新 */
  async reorder(
    items: Array<{ id: number; sortOrder: number }>,
  ): Promise<void> {
    for (const item of items) {
      await prisma.planView.update({
        where: { id: item.id },
        data: { sortOrder: item.sortOrder },
      });
    }
  }

  /** 枚举校验（同 plan-item.repo 模式） */
  private ensureEnumOrThrow(
    value: string | undefined,
    allowed: readonly string[],
    message: string,
  ): void {
    if (value !== undefined && !allowed.includes(value)) {
      throw new Error(message);
    }
  }

  /** 重名 (n) 后缀：name 空串恒可用（默认视图语义不参与后缀）；后缀耗尽抛错兜底 */
  private async uniqueName(projectId: number, name: string): Promise<string> {
    if (name === "") {
      return name;
    }
    let candidate = name;
    for (let n = 2; n < 100; n += 1) {
      const exists = await prisma.planView.findFirst({
        where: { projectId, name: candidate },
        select: { id: true },
      });
      if (!exists) {
        return candidate;
      }
      candidate = `${name}(${n})`;
    }
    throw new Error("视图名冲突，请换一个名称");
  }

  private async nextSortOrder(projectId: number): Promise<number> {
    const last = await prisma.planView.findFirst({
      where: { projectId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    return (last?.sortOrder ?? -1) + 1;
  }

  private buildUpdateData(params: PlanViewUpdateParams) {
    return {
      ...(params.name !== undefined && { name: params.name.trim() }),
      ...(params.type !== undefined && { type: params.type }),
      ...(params.groupBy !== undefined && { groupBy: params.groupBy }),
      ...(params.filterJson !== undefined && {
        filterJson: params.filterJson,
      }),
      ...(params.sortJson !== undefined && { sortJson: params.sortJson }),
    };
  }

  private toRecord(row: PlanViewRow): PlanViewRecord {
    return {
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      type: row.type as PlanViewType,
      groupBy: (row.groupBy as PlanGroupBy | null) ?? null,
      filterJson: parseJsonOr(row.filterJson, "{}"),
      sortJson: parseJsonOr(row.sortJson, "[]"),
      sortOrder: row.sortOrder,
      createdAt: row.createdAt ? row.createdAt.toISOString() : "",
      updatedAt: row.updatedAt ? row.updatedAt.toISOString() : "",
    };
  }
}
