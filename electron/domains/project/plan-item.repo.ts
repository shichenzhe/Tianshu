/**
 * 计划事项仓储（项目模块三期 spec §3.2）：单表双视图聚合——
 * list（项目维度，计划 Tab 数据源）/ listMine（个人维度，任务 Tab 数据源）、
 * create（title trim + 枚举校验 + sortOrder 置目标状态列尾）、
 * update（局部更新）/ move（看板拖拽落点）/ remove。
 * tags/customFields 为 JSON 字符串列，读写经 parseJsonColumn/stringifyColumn 容错。
 * fields:list / fields:save 自定义字段定义（option 域复用，spec §3.2）。
 */
import { ipcMain } from "electron";
import prisma from "../../commons/prisma-client";
import {
  PLAN_FIELD_TYPES,
  PLAN_ITEM_NOT_FOUND,
  PLAN_PRIORITIES,
  PLAN_STATUSES,
  type PlanFieldDef,
  type PlanFieldType,
  type PlanItemCreateParams,
  type PlanItemMoveParams,
  type PlanItemRecord,
  type PlanItemUpdateParams,
  type PlanPriority,
  type PlanStatus,
} from "./plan-item.entity";

type PlanItemRow = NonNullable<
  Awaited<ReturnType<typeof prisma.planItem.findFirst>>
>;

/** option 域自定义字段的 type 键：planFields:<projectId> */
function planFieldsType(projectId: number): string {
  return `planFields:${projectId}`;
}

/** 字段类型枚举守卫：null（note 列可空）或非枚举值 → false（listFields 丢弃畸形行） */
function isPlanFieldType(value: string | null): value is PlanFieldType {
  return (
    value !== null && (PLAN_FIELD_TYPES as readonly string[]).includes(value)
  );
}

/** customFields JSON 列形状守卫：非 null 非数组的普通对象 */
function isPlainObject(
  parsed: unknown,
): parsed is Record<string, string | number> {
  return (
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
  );
}

/** JSON 字符串列解析：畸形 JSON / 非预期形状 / null → fallback（渲染层容错，spec §4） */
function parseJsonColumn<T>(
  raw: string | null,
  fallback: T,
  shape: (parsed: unknown) => boolean,
): T {
  try {
    const parsed = JSON.parse(raw ?? JSON.stringify(fallback));
    return shape(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

export default class PlanItemRepository {
  constructor() {
    this.registerHandlers();
  }

  /**
   * 注册IPC处理程序（8 通道：事项 6 + 自定义字段定义 2）
   */
  private registerHandlers() {
    ipcMain.handle("planItem:list", (_, projectId: number) =>
      this.list(projectId),
    );
    ipcMain.handle("planItem:listMine", (_, userId: number) =>
      this.listMine(userId),
    );
    ipcMain.handle("planItem:create", (_, params: PlanItemCreateParams) =>
      this.create(params),
    );
    ipcMain.handle("planItem:update", (_, params: PlanItemUpdateParams) =>
      this.update(params),
    );
    ipcMain.handle("planItem:delete", (_, id: number) => this.remove(id));
    ipcMain.handle("planItem:move", (_, params: PlanItemMoveParams) =>
      this.move(params),
    );
    ipcMain.handle("planItem:fields:list", (_, projectId: number) =>
      this.listFields(projectId),
    );
    ipcMain.handle(
      "planItem:fields:save",
      (_, projectId: number, fields: PlanFieldDef[]) =>
        this.saveFields(projectId, fields),
    );
  }

  /**
   * 项目全部事项（计划 Tab 数据源）：sortOrder asc + updatedAt desc
   * @param projectId 项目 id（本地任务 projectId null 不可见）
   */
  async list(projectId: number): Promise<PlanItemRecord[]> {
    const rows = await prisma.planItem.findMany({
      where: { projectId },
      orderBy: [{ sortOrder: "asc" }, { updatedAt: "desc" }],
    });
    return rows.map((row) => this.toRecord(row));
  }

  /**
   * 个人聚合（任务 Tab 数据源）：指派给我 OR 我创建（含本地/项目行），updatedAt desc
   * @param userId 当前用户 id
   */
  async listMine(userId: number): Promise<PlanItemRecord[]> {
    const rows = await prisma.planItem.findMany({
      where: { OR: [{ assigneeId: userId }, { createdById: userId }] },
      orderBy: { updatedAt: "desc" },
    });
    return rows.map((row) => this.toRecord(row));
  }

  /**
   * 创建事项：title trim 非空 + 枚举校验，sortOrder 置目标状态列尾（max+1）；
   * 本地任务（projectId 缺省）与项目任务按 projectId 值分列独立计数
   * @param params 创建参数
   */
  async create(params: PlanItemCreateParams): Promise<PlanItemRecord> {
    const title = params.title.trim();
    if (!title) {
      throw new Error("标题不能为空");
    }
    this.ensureEnumOrThrow(params.status, PLAN_STATUSES, "无效的状态");
    this.ensureEnumOrThrow(params.priority, PLAN_PRIORITIES, "无效的优先级");
    const status = params.status ?? "not_started";
    const row = await prisma.planItem.create({
      data: {
        title,
        projectId: params.projectId ?? null,
        status,
        priority: params.priority ?? "P1",
        assigneeId: params.assigneeId ?? null,
        tags: this.stringifyColumn(params.tags),
        customFields: this.stringifyColumn(params.customFields),
        sortOrder: await this.nextSortOrder(params.projectId ?? null, status),
        createdById: params.createdById,
      },
    });
    return this.toRecord(row);
  }

  /**
   * 局部更新：仅写入传入键（未传字段不覆盖）；title trim 非空 + 枚举校验
   * @param params 更新参数
   */
  async update(params: PlanItemUpdateParams): Promise<void> {
    const row = await prisma.planItem.findUnique({ where: { id: params.id } });
    if (!row) {
      throw new Error(PLAN_ITEM_NOT_FOUND);
    }
    this.ensureUpdatable(params);
    await prisma.planItem.update({
      where: { id: params.id },
      data: this.buildUpdateData(params),
    });
  }

  /**
   * 删除事项
   * @param id 事项 id
   */
  async remove(id: number): Promise<void> {
    await prisma.planItem.delete({ where: { id } });
  }

  /**
   * 看板拖拽落点持久化：目标状态列 + 列内新序（存在性 + 枚举校验）
   * @param params 落点参数
   */
  async move(params: PlanItemMoveParams): Promise<void> {
    const row = await prisma.planItem.findUnique({ where: { id: params.id } });
    if (!row) {
      throw new Error(PLAN_ITEM_NOT_FOUND);
    }
    this.ensureEnumOrThrow(params.status, PLAN_STATUSES, "无效的状态");
    await prisma.planItem.update({
      where: { id: params.id },
      data: { status: params.status, sortOrder: params.sortOrder },
    });
  }

  /**
   * 项目自定义字段定义：option 域 planFields:<projectId> 行
   * （value=字段名，note=类型），name asc；note 缺失/非枚举的畸形行丢弃
   * @param projectId 项目 id
   */
  async listFields(projectId: number): Promise<PlanFieldDef[]> {
    const rows = await prisma.option.findMany({
      where: { type: planFieldsType(projectId) },
      orderBy: { value: "asc" },
    });
    return rows.flatMap((row) =>
      isPlanFieldType(row.note) ? [{ name: row.value, type: row.note }] : [],
    );
  }

  /**
   * 保存自定义字段定义（全量替换）：校验 → deleteMany + createMany 重建
   * option 行；消失字段名（删除或重命名导致）同步清理该项目全部
   * planItem 行的 customFields 键（失败收集，收尾汇总抛出，调用方 toast）
   * @param projectId 项目 id
   * @param fields 字段定义全集
   */
  async saveFields(projectId: number, fields: PlanFieldDef[]): Promise<void> {
    const normalized = this.normalizeFieldsOrThrow(fields);
    const type = planFieldsType(projectId);
    const existingRows = await prisma.option.findMany({
      where: { type },
      select: { value: true },
    });
    const keptNames = new Set(normalized.map((field) => field.name));
    const removedNames = existingRows
      .map((row) => row.value)
      .filter((name) => !keptNames.has(name));
    await prisma.option.deleteMany({ where: { type } });
    if (normalized.length > 0) {
      await prisma.option.createMany({
        data: normalized.map((field) => ({
          type,
          name: field.name,
          value: field.name,
          note: field.type,
        })),
      });
    }
    await this.cleanRemovedFieldValues(projectId, removedNames);
  }

  /** 枚举值校验：undefined 跳过（走缺省值），非枚举值抛中文错误（裸 IPC 容错，spec §4） */
  private ensureEnumOrThrow(
    value: string | undefined,
    allowed: readonly string[],
    message: string,
  ): void {
    if (value !== undefined && !allowed.includes(value)) {
      throw new Error(message);
    }
  }

  /** 局部更新参数校验：title trim 非空 + status/priority 枚举 */
  private ensureUpdatable(params: PlanItemUpdateParams): void {
    if (params.title !== undefined && !params.title.trim()) {
      throw new Error("标题不能为空");
    }
    this.ensureEnumOrThrow(params.status, PLAN_STATUSES, "无效的状态");
    this.ensureEnumOrThrow(params.priority, PLAN_PRIORITIES, "无效的优先级");
  }

  /**
   * 字段定义校验（裸 IPC 容错，spec §4）：name trim 非空、type 三枚举、
   * trim 后项目内不重名；返回 trim 后定义（存库以 trim 名对齐 value 列）
   */
  private normalizeFieldsOrThrow(fields: PlanFieldDef[]): PlanFieldDef[] {
    const seen = new Set<string>();
    const normalized: PlanFieldDef[] = [];
    for (const field of fields) {
      const name = field.name.trim();
      if (!name) {
        throw new Error("字段名不能为空");
      }
      if (!isPlanFieldType(field.type)) {
        throw new Error("无效的字段类型");
      }
      if (seen.has(name)) {
        throw new Error("字段名重复");
      }
      seen.add(name);
      normalized.push({ name, type: field.type });
    }
    return normalized;
  }

  /**
   * 清理消失字段的项目内行值：该项目全部行逐行删键回写；
   * 单行失败收集不中断，收尾有失败则抛汇总（调用方 toast），成功静默
   */
  private async cleanRemovedFieldValues(
    projectId: number,
    removedNames: string[],
  ): Promise<void> {
    if (removedNames.length === 0) {
      return;
    }
    const rows = await prisma.planItem.findMany({
      where: { projectId },
      select: { id: true, customFields: true },
    });
    const failedIds: number[] = [];
    for (const row of rows) {
      try {
        await this.removeRowFieldKeys(row.id, row.customFields, removedNames);
      } catch {
        failedIds.push(row.id);
      }
    }
    if (failedIds.length > 0) {
      throw new Error(`清理字段值失败 ${failedIds.length} 条`);
    }
  }

  /** 单行 customFields 删键回写：行不含任何消失键（含空列/畸形 JSON）时不写库 */
  private async removeRowFieldKeys(
    rowId: number,
    raw: string | null,
    removedNames: string[],
  ): Promise<void> {
    const fields = parseJsonColumn<Record<string, string | number>>(
      raw,
      {},
      isPlainObject,
    );
    const hits = Object.keys(fields).filter((key) =>
      removedNames.includes(key),
    );
    if (hits.length === 0) {
      return;
    }
    hits.forEach((key) => delete fields[key]);
    await prisma.planItem.update({
      where: { id: rowId },
      data: { customFields: JSON.stringify(fields) },
    });
  }

  /** 组装局部更新 data：只含传入键（assigneeId null = 显式清空指派） */
  private buildUpdateData(
    params: PlanItemUpdateParams,
  ): Record<string, unknown> {
    return {
      ...(params.title !== undefined && { title: params.title.trim() }),
      ...(params.status !== undefined && { status: params.status }),
      ...(params.priority !== undefined && { priority: params.priority }),
      ...(params.assigneeId !== undefined && { assigneeId: params.assigneeId }),
      ...(params.tags !== undefined && {
        tags: this.stringifyColumn(params.tags),
      }),
      ...(params.customFields !== undefined && {
        customFields: this.stringifyColumn(params.customFields),
      }),
    };
  }

  /** JSON 列写入序列化：undefined 不写该列（留空），否则 JSON.stringify */
  private stringifyColumn(value: unknown): string | undefined {
    return value !== undefined ? JSON.stringify(value) : undefined;
  }

  /** 目标状态列下一个列内序：取该列（projectId 精确匹配，null 为本地任务列）最大值 +1 */
  private async nextSortOrder(
    projectId: number | null,
    status: PlanStatus,
  ): Promise<number> {
    const last = await prisma.planItem.findFirst({
      where: { projectId, status },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    return (last?.sortOrder ?? 0) + 1;
  }

  /** planItem 行 → PlanItemRecord（JSON 列解析容错；DateTime → ISO） */
  private toRecord(row: PlanItemRow): PlanItemRecord {
    return {
      id: row.id,
      projectId: row.projectId,
      title: row.title,
      status: row.status as PlanStatus,
      priority: row.priority as PlanPriority,
      assigneeId: row.assigneeId,
      tags: parseJsonColumn(row.tags, [], Array.isArray),
      customFields: parseJsonColumn(row.customFields, {}, isPlainObject),
      sortOrder: row.sortOrder,
      createdById: row.createdById,
      createdAt: this.toIso(row.createdAt),
      updatedAt: this.toIso(row.updatedAt),
    };
  }

  /** DateTime → ISO 字符串；缺省值兜底空串 */
  private toIso(date: Date | null | undefined): string {
    return date ? date.toISOString() : "";
  }
}
