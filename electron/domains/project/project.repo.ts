/**
 * 项目仓储：项目 CRUD + 成员/能力挂载/动态流会话管理（项目模块一期 spec §4）
 */
import { ipcMain } from "electron";
import prisma from "../../commons/prisma-client";
import {
  PROJECT_NAME_EXISTS,
  PROJECT_NOT_FOUND,
  ProjectBindingInput,
  ProjectBindingItem,
  ProjectBindingType,
  ProjectCreateParams,
  ProjectDetail,
  ProjectRecord,
  ProjectUpdateParams,
} from "./project.entity";
import type { ProjectPromptContext } from "./project-prompt";
import type {
  SessionMode,
  SessionRecord,
} from "../../../src-react/domains/ai/api/session.api";

/** 能力挂载类型 → 源实体表 */
const ITEM_TABLES: Record<
  ProjectBindingType,
  "assistant" | "skillRecord" | "mcpServer"
> = {
  assistant: "assistant",
  skill: "skillRecord",
  mcpServer: "mcpServer",
};

type ProjectRow = NonNullable<
  Awaited<ReturnType<typeof prisma.project.findFirst>>
>;
type ProjectBindingRow = NonNullable<
  Awaited<ReturnType<typeof prisma.projectBinding.findFirst>>
>;
type SessionRow = NonNullable<
  Awaited<ReturnType<typeof prisma.session.findFirst>>
>;

export default class ProjectRepository {
  constructor() {
    this.registerHandlers();
  }

  /**
   * 注册IPC处理程序
   */
  private registerHandlers() {
    ipcMain.handle("project:list", (_, ownerId: number) => this.list(ownerId));
    ipcMain.handle("project:getDetail", (_, id: number) => this.getDetail(id));
    ipcMain.handle("project:create", (_, params: ProjectCreateParams) =>
      this.create(params),
    );
    ipcMain.handle("project:update", (_, params: ProjectUpdateParams) =>
      this.update(params),
    );
    ipcMain.handle("project:delete", (_, id: number) => this.remove(id));
    ipcMain.handle(
      "project:setBindings",
      (_, projectId: number, items: ProjectBindingInput[]) =>
        this.setBindings(projectId, items),
    );
  }

  /**
   * 项目列表：按更新时间倒序，逐行补动态流会话 id
   * @param ownerId 创建人用户 id
   */
  async list(ownerId: number): Promise<ProjectRecord[]> {
    const rows = await prisma.project.findMany({
      where: { ownerId },
      orderBy: { updatedAt: "desc" },
    });
    return Promise.all(rows.map((row) => this.toRecordWithSession(row)));
  }

  /**
   * 项目详情：项目 + 能力挂载 + 动态流会话
   * @param id 项目 id
   */
  async getDetail(id: number): Promise<ProjectDetail> {
    const row = await prisma.project.findUnique({ where: { id } });
    const session = await prisma.session.findFirst({
      where: { projectId: id },
    });
    if (!row || !session) {
      throw new Error(PROJECT_NOT_FOUND);
    }
    const bindings = await this.listBindingItems(id);
    return {
      project: this.toRecord(row, session.id),
      bindings,
      session: this.toSession(session),
    };
  }

  /**
   * 创建项目：重名检查 → project + owner 成员 + 初始挂载 + 动态流会话（含欢迎消息）
   * @param params 创建参数
   */
  async create(params: ProjectCreateParams): Promise<ProjectRecord> {
    await this.ensureNameAvailable(params.ownerId, params.name);
    const row = await prisma.project.create({
      data: {
        name: params.name,
        systemPrompt: params.systemPrompt,
        templateKey: params.templateKey,
        ownerId: params.ownerId,
      },
    });
    await this.createOwnerAndBindings(row.id, params);
    const session = await this.createProjectSession(row.id, params);
    return this.toRecord(row, session.id);
  }

  /**
   * 删除项目：级联清 message → session → member → binding → project
   * @param id 项目 id
   */
  async remove(id: number): Promise<void> {
    const sessions = await prisma.session.findMany({
      where: { projectId: id },
      select: { id: true },
    });
    await prisma.message.deleteMany({
      where: { sessionId: { in: sessions.map((s) => s.id) } },
    });
    await prisma.session.deleteMany({ where: { projectId: id } });
    await prisma.projectMember.deleteMany({ where: { projectId: id } });
    await prisma.projectBinding.deleteMany({ where: { projectId: id } });
    await prisma.project.delete({ where: { id } });
  }

  /**
   * 更新项目基础字段；改名时校验同用户重名
   * @param params 更新参数
   */
  async update(params: ProjectUpdateParams): Promise<void> {
    const row = await prisma.project.findUnique({ where: { id: params.id } });
    if (!row) {
      throw new Error(PROJECT_NOT_FOUND);
    }
    if (params.name && params.name !== row.name) {
      await this.ensureNameAvailable(row.ownerId, params.name, params.id);
    }
    await prisma.project.update({
      where: { id: params.id },
      data: { name: params.name, systemPrompt: params.systemPrompt },
    });
  }

  /**
   * 能力挂载全量替换：先清空再批量写入
   * @param projectId 项目 id
   * @param items 挂载列表（空数组即清空）
   */
  async setBindings(
    projectId: number,
    items: ProjectBindingInput[],
  ): Promise<void> {
    await prisma.projectBinding.deleteMany({ where: { projectId } });
    if (items.length > 0) {
      await prisma.projectBinding.createMany({
        data: items.map((item) => ({
          projectId,
          itemType: item.itemType,
          itemId: item.itemId,
        })),
      });
    }
  }

  /**
   * 项目提示词上下文（项目模块一期）：project 行 + 三源挂载名/prompt 集合，
   * 供 ChatService 组装项目会话 system base（project-prompt.buildProjectSystemBase）
   * @param projectId 项目 id；项目行缺失返回 null（调用方回退助手 prompt）
   */
  async getPromptContext(
    projectId: number,
  ): Promise<ProjectPromptContext | null> {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      return null;
    }
    const bindings = await prisma.projectBinding.findMany({
      where: { projectId },
      orderBy: { id: "asc" },
    });
    const idsByType = this.groupBindingIds(bindings);
    const [assistantRows, skillRows, mcpRows] = await Promise.all([
      idsByType.assistant.length > 0
        ? prisma.assistant.findMany({
            where: { id: { in: idsByType.assistant } },
            select: { id: true, systemPrompt: true },
          })
        : [],
      idsByType.skill.length > 0
        ? prisma.skillRecord.findMany({
            where: { id: { in: idsByType.skill } },
            select: { id: true, name: true },
          })
        : [],
      idsByType.mcpServer.length > 0
        ? prisma.mcpServer.findMany({
            where: { id: { in: idsByType.mcpServer } },
            select: { id: true, name: true },
          })
        : [],
    ]);
    return {
      projectName: project.name,
      systemPrompt: project.systemPrompt,
      boundAssistantPrompts: this.orderByIds(
        idsByType.assistant,
        assistantRows,
      ).map((row) => row.systemPrompt),
      boundSkillNames: this.orderByIds(idsByType.skill, skillRows).map(
        (row) => row.name,
      ),
      boundConnectorNames: this.orderByIds(idsByType.mcpServer, mcpRows).map(
        (row) => row.name,
      ),
    };
  }

  /** 挂载行按类型分组取源 id（保持挂载写入顺序） */
  private groupBindingIds(
    bindings: ProjectBindingRow[],
  ): Record<ProjectBindingType, number[]> {
    const idsByType: Record<ProjectBindingType, number[]> = {
      assistant: [],
      skill: [],
      mcpServer: [],
    };
    for (const row of bindings) {
      idsByType[row.itemType as ProjectBindingType].push(row.itemId);
    }
    return idsByType;
  }

  /** findMany in-查询不保序：按挂载 id 顺序重排源实体行（已删源自然出队） */
  private orderByIds<T extends { id: number }>(ids: number[], rows: T[]): T[] {
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
  }

  /** 同用户下项目名唯一校验（excludeId 用于改名时排除自身） */
  private async ensureNameAvailable(
    ownerId: number,
    name: string,
    excludeId?: number,
  ): Promise<void> {
    const duplicate = await prisma.project.findFirst({
      where: {
        ownerId,
        name,
        ...(excludeId !== undefined && { NOT: { id: excludeId } }),
      },
    });
    if (duplicate) {
      throw new Error(PROJECT_NAME_EXISTS);
    }
  }

  /** 建 owner 成员行 + 初始能力挂载 */
  private async createOwnerAndBindings(
    projectId: number,
    params: ProjectCreateParams,
  ): Promise<void> {
    await prisma.projectMember.create({
      data: { projectId, userId: params.ownerId, role: "owner" },
    });
    const bindings = params.bindings ?? [];
    if (bindings.length > 0) {
      await this.setBindings(projectId, bindings);
    }
  }

  /** 建动态流会话：挂默认工作空间（最早创建），非空欢迎消息落首条消息 */
  private async createProjectSession(
    projectId: number,
    params: ProjectCreateParams,
  ): Promise<SessionRow> {
    const workspace = await prisma.workspace.findFirst({
      orderBy: { createdAt: "asc" },
    });
    if (!workspace) {
      throw new Error("默认工作空间不存在，无法创建项目会话");
    }
    const session = await prisma.session.create({
      data: { projectId, workspaceId: workspace.id, title: params.name },
    });
    if (params.welcomeMessage) {
      await this.appendWelcomeMessage(session.id, params.welcomeMessage);
    }
    return session;
  }

  /** 欢迎消息：assistant 首条文本块 + 刷新会话 lastMessageAt */
  private async appendWelcomeMessage(
    sessionId: number,
    text: string,
  ): Promise<void> {
    await prisma.message.create({
      data: {
        sessionId,
        role: "assistant",
        blocks: JSON.stringify([{ type: "text", text }]),
      },
    });
    await prisma.session.update({
      where: { id: sessionId },
      data: { lastMessageAt: new Date() },
    });
  }

  /** 逐行补动态流会话 id（项目创建即建会话，缺失兜底 0） */
  private async toRecordWithSession(row: ProjectRow): Promise<ProjectRecord> {
    const session = await prisma.session.findFirst({
      where: { projectId: row.id },
    });
    return this.toRecord(row, session?.id ?? 0);
  }

  /** 能力挂载列表：逐行回查源实体取显示名与存在性 */
  private async listBindingItems(
    projectId: number,
  ): Promise<ProjectBindingItem[]> {
    const rows = await prisma.projectBinding.findMany({ where: { projectId } });
    return Promise.all(rows.map((row) => this.toBindingItem(row)));
  }

  /** 单条挂载：源实体被删时绑定表未存名字，以 #id 兜底并标 valid=false */
  private async toBindingItem(
    row: ProjectBindingRow,
  ): Promise<ProjectBindingItem> {
    const itemType = row.itemType as ProjectBindingType;
    const source = await this.findBindingSource(itemType, row.itemId);
    return {
      id: row.id,
      itemType,
      itemId: row.itemId,
      itemName: source?.name ?? `#${row.itemId}`,
      valid: source != null,
    };
  }

  /** 回查挂载源实体（存在则取显示名） */
  private async findBindingSource(
    itemType: ProjectBindingType,
    itemId: number,
  ): Promise<{ name: string } | null> {
    const table = ITEM_TABLES[itemType];
    if (table === "assistant") {
      return prisma.assistant.findUnique({
        where: { id: itemId },
        select: { name: true },
      });
    }
    if (table === "skillRecord") {
      return prisma.skillRecord.findUnique({
        where: { id: itemId },
        select: { name: true },
      });
    }
    return prisma.mcpServer.findUnique({
      where: { id: itemId },
      select: { name: true },
    });
  }

  /** project 行 → ProjectRecord（DateTime → ISO；sessionId 由调用方补齐） */
  private toRecord(row: ProjectRow, sessionId: number): ProjectRecord {
    return {
      id: row.id,
      name: row.name,
      systemPrompt: row.systemPrompt,
      templateKey: row.templateKey,
      ownerId: row.ownerId,
      sessionId,
      createdAt: this.toIso(row.createdAt),
      updatedAt: this.toIso(row.updatedAt),
    };
  }

  /** session 行 → SessionRecord（语义同 ai/chat/session.repo 的 toSession，P3 mode null 归一 "agent"） */
  private toSession(row: SessionRow): SessionRecord {
    return {
      ...row,
      assistantId: row.assistantId ?? undefined,
      currentModelId: row.currentModelId ?? undefined,
      mode: (row.mode as SessionMode | null) ?? "agent",
      lastMessageAt: row.lastMessageAt?.toISOString() ?? undefined,
      pinnedAt: row.pinnedAt?.toISOString() ?? undefined,
      archivedAt: row.archivedAt?.toISOString() ?? undefined,
      createdAt: this.toIso(row.createdAt),
      updatedAt: this.toIso(row.updatedAt),
    };
  }

  /** DateTime → ISO 字符串；缺省值兜底空串 */
  private toIso(date: Date | null | undefined): string {
    return date ? date.toISOString() : "";
  }
}
