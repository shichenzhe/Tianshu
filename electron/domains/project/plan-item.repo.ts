/**
 * 计划事项仓储（项目模块三期 spec §3.2）：单表双视图聚合——
 * list（项目维度，计划 Tab 数据源）/ listMine（个人维度，任务 Tab 数据源）、
 * create（title trim + 枚举校验 + 排期/来源透传 + 处理人成员资格校验 +
 * sortOrder 置目标状态列尾）、
 * update（局部更新；status 变更重算目标列 sortOrder；处理人须为项目成员）/
 * move（看板拖拽落点）/ remove。
 * tags/customFields 为 JSON 字符串列，读写经 parseJsonColumn/stringifyColumn 容错。
 * fields:list / fields:save 自定义字段定义（option 域复用，spec §3.2）。
 * attachments:list|create|delete 附件关联三通道 + remove 级联清关联
 * （文件实体保留在项目资产空间，v6）。
 * appendAiSummary AI 进展摘要追加（工具专用通道，只增不改；v8，子系统 F）。
 */
import { handleUser } from "../../commons/ipc-user";
import prisma from "../../commons/prisma-client";
import { PROJECT_NOT_FOUND } from "./project.entity";
import {
  appendAiSummaryLine,
  PLAN_FIELD_TYPES,
  PLAN_ITEM_NOT_FOUND,
  PLAN_PRIORITIES,
  PLAN_SOURCES,
  PLAN_STATUSES,
  type PlanFieldDef,
  type PlanFieldType,
  type PlanItemAttachmentRecord,
  type PlanItemCreateParams,
  type PlanItemMoveParams,
  type PlanItemRecord,
  type PlanItemSource,
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
   * 注册IPC处理程序（11 通道：事项 6 + 自定义字段定义 2 + 附件 3）
   */
  private registerHandlers() {
    // userId 由 token 解出（commons/ipc-user）；listMine/create 的用户身份不再信任前端传参
    handleUser("planItem:list", (_, userId, projectId: number) =>
      this.list(projectId, userId),
    );
    handleUser("planItem:listMine", (_, userId) => this.listMine(userId));
    handleUser("planItem:create", (_, userId, params: PlanItemCreateParams) =>
      this.create(params, userId),
    );
    handleUser("planItem:update", (_, userId, params: PlanItemUpdateParams) =>
      this.update(params, userId),
    );
    handleUser("planItem:delete", (_, userId, id: number) =>
      this.remove(id, userId),
    );
    handleUser("planItem:move", (_, userId, params: PlanItemMoveParams) =>
      this.move(params, userId),
    );
    handleUser("planItem:fields:list", (_, userId, projectId: number) =>
      this.listFields(projectId, userId),
    );
    handleUser(
      "planItem:fields:save",
      (_, userId, projectId: number, fields: PlanFieldDef[]) =>
        this.saveFields(projectId, fields, userId),
    );
    handleUser("planItem:attachments:list", (_, userId, planItemId: number) =>
      this.listAttachments(planItemId, userId),
    );
    handleUser(
      "planItem:attachments:create",
      (
        _,
        userId,
        planItemId: number,
        input: { fileName: string; assetPath: string },
      ) => this.createAttachment(planItemId, input, userId),
    );
    handleUser("planItem:attachments:delete", (_, userId, id: number) =>
      this.removeAttachment(id, userId),
    );
  }

  /** 项目对当前用户可见（owner 或成员）；不可见与不存在同报错 */
  private async assertProjectVisible(
    projectId: number,
    userId: number,
  ): Promise<void> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    });
    if (project && project.ownerId === userId) {
      return;
    }
    const member = project
      ? await prisma.projectMember.findFirst({
          where: { projectId, userId },
        })
      : null;
    if (!member) {
      throw new Error(PROJECT_NOT_FOUND);
    }
  }

  /** 事项行对当前用户可操作：项目事项=项目可见；本地任务（projectId null）=创建者 */
  private async assertItemOperable(
    row: { projectId: number | null; createdById: number },
    userId: number,
  ): Promise<void> {
    if (row.projectId !== null) {
      await this.assertProjectVisible(row.projectId, userId);
      return;
    }
    if (row.createdById !== userId) {
      throw new Error(PLAN_ITEM_NOT_FOUND);
    }
  }

  /**
   * 项目全部事项（计划 Tab 数据源）：sortOrder asc + updatedAt desc
   * @param projectId 项目 id（本地任务 projectId null 不可见）
   */
  async list(projectId: number, userId: number): Promise<PlanItemRecord[]> {
    await this.assertProjectVisible(projectId, userId);
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
   * 创建事项：title trim 非空 + 枚举校验（status/priority/source），
   * 指派时校验处理人是该项目成员；sortOrder 置目标状态列尾（max+1），
   * startDate/dueDate ISO 透传、source 缺省 manual；
   * 本地任务（projectId 缺省）与项目任务按 projectId 值分列独立计数
   * @param params 创建参数
   */
  async create(
    params: PlanItemCreateParams,
    userId: number,
  ): Promise<PlanItemRecord> {
    const title = params.title.trim();
    if (!title) {
      throw new Error("标题不能为空");
    }
    this.ensureEnumOrThrow(params.status, PLAN_STATUSES, "无效的状态");
    this.ensureEnumOrThrow(params.priority, PLAN_PRIORITIES, "无效的优先级");
    this.ensureEnumOrThrow(params.source, PLAN_SOURCES, "无效的来源");
    if (params.projectId != null) {
      await this.assertProjectVisible(params.projectId, userId);
    }
    await this.ensureAssigneeIsMember(
      params.projectId ?? null,
      params.assigneeId,
    );
    const status = params.status ?? "not_started";
    const row = await prisma.planItem.create({
      data: {
        title,
        description: params.description ?? null,
        projectId: params.projectId ?? null,
        status,
        priority: params.priority ?? "P1",
        assigneeId: params.assigneeId ?? null,
        startDate: this.toDateOrNull(params.startDate),
        dueDate: this.toDateOrNull(params.dueDate),
        source: params.source ?? "manual",
        tags: this.stringifyColumn(params.tags),
        customFields: this.stringifyColumn(params.customFields),
        sortOrder: await this.nextSortOrder(params.projectId ?? null, status),
        // v12 多用户隔离：创建人以 token 解出的用户为准，忽略前端传参
        createdById: userId,
      },
    });
    return this.toRecord(row);
  }

  /**
   * 局部更新：仅写入传入键（未传字段不覆盖）；title trim 非空 + 枚举校验；
   * 指派时校验处理人是该项目成员；status 变更时重算目标状态列尾
   * sortOrder（nextSortOrder），避免沿用旧列序号——关闭弹窗编辑等裸
   * update 路径绕过 move 通道造成的落列错位
   * @param params 更新参数
   */
  async update(params: PlanItemUpdateParams, userId: number): Promise<void> {
    const row = await prisma.planItem.findUnique({ where: { id: params.id } });
    if (!row) {
      throw new Error(PLAN_ITEM_NOT_FOUND);
    }
    await this.assertItemOperable(row, userId);
    this.ensureUpdatable(params);
    await this.ensureAssigneeIsMember(row.projectId, params.assigneeId);
    const data = this.buildUpdateData(params);
    if (params.status !== undefined && params.status !== row.status) {
      data.sortOrder = await this.nextSortOrder(row.projectId, params.status);
    }
    await prisma.planItem.update({ where: { id: params.id }, data });
  }

  /**
   * 删除事项：级联删附件关联行（文件实体保留在项目资产空间）
   * @param id 事项 id
   */
  async remove(id: number, userId: number): Promise<void> {
    const row = await prisma.planItem.findUnique({ where: { id } });
    if (!row) {
      throw new Error(PLAN_ITEM_NOT_FOUND);
    }
    await this.assertItemOperable(row, userId);
    await prisma.planItemAttachment.deleteMany({ where: { planItemId: id } });
    await prisma.planItem.delete({ where: { id } });
  }

  /**
   * 看板拖拽落点持久化：目标状态列 + 列内新序（存在性 + 枚举校验）
   * @param params 落点参数
   */
  async move(params: PlanItemMoveParams, userId: number): Promise<void> {
    const row = await prisma.planItem.findUnique({ where: { id: params.id } });
    if (!row) {
      throw new Error(PLAN_ITEM_NOT_FOUND);
    }
    await this.assertItemOperable(row, userId);
    this.ensureEnumOrThrow(params.status, PLAN_STATUSES, "无效的状态");
    await prisma.planItem.update({
      where: { id: params.id },
      data: { status: params.status, sortOrder: params.sortOrder },
    });
  }

  /** AI 追加进展（工具专用通道；只增不改，格式与 plan_append_summary 工具
      共用 entity 纯函数 appendAiSummaryLine） */
  async appendAiSummary(id: number, text: string): Promise<string | null> {
    const row = await prisma.planItem.findUnique({ where: { id } });
    if (!row) {
      return null;
    }
    const { next } = appendAiSummaryLine(row.aiSummary, text, new Date());
    await prisma.planItem.update({ where: { id }, data: { aiSummary: next } });
    return next;
  }

  /**
   * 事项附件关联列表（id asc）
   * @param planItemId 事项 id
   */
  async listAttachments(
    planItemId: number,
    userId: number,
  ): Promise<PlanItemAttachmentRecord[]> {
    await this.assertAttachmentVisible(planItemId, userId);
    const rows = await prisma.planItemAttachment.findMany({
      where: { planItemId },
      orderBy: { id: "asc" },
    });
    return rows.map((row) => this.toAttachmentRecord(row));
  }

  /**
   * 建附件关联（上传/挑选同构：一行关联记录）
   * @param planItemId 事项 id
   * @param input 展示名 + 项目 workspace 相对路径（trim 后均不得为空）
   */
  async createAttachment(
    planItemId: number,
    input: { fileName: string; assetPath: string },
    userId: number,
  ): Promise<PlanItemAttachmentRecord> {
    await this.assertAttachmentVisible(planItemId, userId);
    const fileName = input.fileName.trim();
    const assetPath = input.assetPath.trim();
    if (!fileName || !assetPath) {
      throw new Error("附件名与路径不能为空");
    }
    const row = await prisma.planItemAttachment.create({
      data: { planItemId, fileName, assetPath },
    });
    return this.toAttachmentRecord(row);
  }

  /**
   * 删附件关联（文件实体保留在资产空间）
   * @param id 附件关联行 id
   */
  async removeAttachment(id: number, userId: number): Promise<void> {
    const binding = await prisma.planItemAttachment.findUnique({
      where: { id },
    });
    if (binding) {
      await this.assertAttachmentVisible(binding.planItemId, userId);
    }
    await prisma.planItemAttachment.delete({ where: { id } });
  }

  /** 附件按所属事项守门（项目事项=项目可见；本地任务=创建者） */
  private async assertAttachmentVisible(
    planItemId: number,
    userId: number,
  ): Promise<void> {
    const item = await prisma.planItem.findUnique({
      where: { id: planItemId },
    });
    if (!item) {
      throw new Error(PLAN_ITEM_NOT_FOUND);
    }
    await this.assertItemOperable(item, userId);
  }

  /**
   * 项目自定义字段定义：option 域 planFields:<projectId> 行
   * （value=字段名，note=类型），name asc；note 缺失/非枚举的畸形行丢弃
   * @param projectId 项目 id
   */
  async listFields(projectId: number, userId: number): Promise<PlanFieldDef[]> {
    await this.assertProjectVisible(projectId, userId);
    const rows = await prisma.option.findMany({
      where: { type: planFieldsType(projectId), userId },
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
  async saveFields(
    projectId: number,
    fields: PlanFieldDef[],
    userId: number,
  ): Promise<void> {
    await this.assertProjectVisible(projectId, userId);
    const normalized = this.normalizeFieldsOrThrow(fields);
    const type = planFieldsType(projectId);
    const existingRows = await prisma.option.findMany({
      where: { type, userId },
      select: { value: true },
    });
    const keptNames = new Set(normalized.map((field) => field.name));
    const removedNames = existingRows
      .map((row) => row.value)
      .filter((name) => !keptNames.has(name));
    await prisma.option.deleteMany({ where: { type, userId } });
    if (normalized.length > 0) {
      await prisma.option.createMany({
        data: normalized.map((field) => ({
          type,
          name: field.name,
          value: field.name,
          note: field.type,
          userId,
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

  /** 局部更新参数校验：title trim 非空 + status/priority/source 枚举 */
  private ensureUpdatable(params: PlanItemUpdateParams): void {
    if (params.title !== undefined && !params.title.trim()) {
      throw new Error("标题不能为空");
    }
    this.ensureEnumOrThrow(params.status, PLAN_STATUSES, "无效的状态");
    this.ensureEnumOrThrow(params.priority, PLAN_PRIORITIES, "无效的优先级");
    this.ensureEnumOrThrow(params.source, PLAN_SOURCES, "无效的来源");
  }

  /** 指派校验：assigneeId 非空时必须是该项目成员（本地任务无项目，跳过校验） */
  private async ensureAssigneeIsMember(
    projectId: number | null,
    assigneeId: number | null | undefined,
  ): Promise<void> {
    if (projectId === null || assigneeId === undefined || assigneeId === null) {
      return;
    }
    const member = await prisma.projectMember.findFirst({
      where: { projectId, userId: assigneeId },
    });
    if (!member) {
      throw new Error("处理人必须是项目成员");
    }
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

  /**
   * 组装局部更新 data：只含传入键（assigneeId null = 显式清空指派；
   * startDate/dueDate 传 null/空串 = 清空日期，未传不写该列）
   */
  private buildUpdateData(
    params: PlanItemUpdateParams,
  ): Record<string, unknown> {
    return {
      ...(params.title !== undefined && { title: params.title.trim() }),
      ...(params.description !== undefined && {
        description: params.description,
      }),
      ...(params.status !== undefined && { status: params.status }),
      ...(params.priority !== undefined && { priority: params.priority }),
      ...(params.assigneeId !== undefined && { assigneeId: params.assigneeId }),
      ...(params.tags !== undefined && {
        tags: this.stringifyColumn(params.tags),
      }),
      ...(params.customFields !== undefined && {
        customFields: this.stringifyColumn(params.customFields),
      }),
      ...(params.source !== undefined && { source: params.source }),
      ...(params.startDate !== undefined && {
        startDate: this.toDateOrNull(params.startDate),
      }),
      ...(params.dueDate !== undefined && {
        dueDate: this.toDateOrNull(params.dueDate),
      }),
    };
  }

  /** JSON 列写入序列化：undefined 不写该列（留空），否则 JSON.stringify */
  private stringifyColumn(value: unknown): string | undefined {
    return value !== undefined ? JSON.stringify(value) : undefined;
  }

  /** ISO 字符串 → Date；空串/null → null（清空）；undefined 不写该列；非法串抛中文错误 */
  private toDateOrNull(
    value: string | null | undefined,
  ): Date | null | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (value === null || value === "") {
      return null;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new Error("无效的日期格式");
    }
    return date;
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
      description: row.description ?? "",
      aiSummary: row.aiSummary ?? "",
      status: row.status as PlanStatus,
      priority: row.priority as PlanPriority,
      assigneeId: row.assigneeId,
      tags: parseJsonColumn(row.tags, [], Array.isArray),
      customFields: parseJsonColumn(row.customFields, {}, isPlainObject),
      startDate: this.toIso(row.startDate),
      dueDate: this.toIso(row.dueDate),
      source: row.source as PlanItemSource,
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

  /** planItemAttachment 行 → PlanItemAttachmentRecord（DateTime → ISO） */
  private toAttachmentRecord(row: {
    id: number;
    planItemId: number;
    fileName: string;
    assetPath: string;
    createdAt: Date;
  }): PlanItemAttachmentRecord {
    return { ...row, createdAt: row.createdAt.toISOString() };
  }
}
