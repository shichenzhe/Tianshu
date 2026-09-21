/**
 * 项目仓储：项目 CRUD + 成员/能力挂载/动态流会话管理（项目模块一期 spec §4）；
 * 二期起挂接资产空间生命周期——create/remove/getDetail 维护
 * userData/projects/<id>/assets 目录与对应 workspace 行（二期 spec §3.2）
 */
import { app } from "electron";
import prisma from "../../commons/prisma-client";
import Log from "../../commons/Log";
import { handleUser } from "../../commons/ipc-user";
import fs from "node:fs/promises";
import path from "node:path";
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
import type { ProjectMemberItem } from "./project.entity";
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
type WorkspaceRow = NonNullable<
  Awaited<ReturnType<typeof prisma.workspace.findFirst>>
>;

export default class ProjectRepository {
  constructor() {
    this.registerHandlers();
  }

  /**
   * 注册IPC处理程序
   */
  private registerHandlers() {
    // userId 由 token 解出（commons/ipc-user）；ownerId 不再信任前端传参
    handleUser("project:list", (_, userId) => this.list(userId));
    handleUser("project:getDetail", (_, userId, id: number) =>
      this.getDetail(id, userId),
    );
    handleUser("project:create", (_, userId, params: ProjectCreateParams) =>
      this.create(params, userId),
    );
    handleUser("project:update", (_, userId, params: ProjectUpdateParams) =>
      this.update(params, userId),
    );
    handleUser("project:delete", (_, userId, id: number) =>
      this.remove(id, userId),
    );
    handleUser(
      "project:setBindings",
      (_, userId, projectId: number, items: ProjectBindingInput[]) =>
        this.setBindings(projectId, items, userId),
    );
    handleUser("project:listMembers", (_, userId, projectId: number) =>
      this.listMembers(projectId, userId),
    );
  }

  /** 项目对当前用户可见（owner 或成员）；不可见与不存在同报错 */
  private async assertProjectVisible(
    id: number,
    userId: number,
  ): Promise<ProjectRow> {
    const row = await prisma.project.findUnique({ where: { id } });
    if (row && row.ownerId === userId) {
      return row;
    }
    const member = row
      ? await prisma.projectMember.findFirst({
          where: { projectId: id, userId },
        })
      : null;
    if (!row || !member) {
      throw new Error(PROJECT_NOT_FOUND);
    }
    return row;
  }

  /** 写操作校验：仅 owner 可改 */
  private async assertProjectOwned(
    id: number,
    userId: number,
  ): Promise<ProjectRow> {
    const row = await this.assertProjectVisible(id, userId);
    if (row.ownerId !== userId) {
      throw new Error(PROJECT_NOT_FOUND);
    }
    return row;
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
   * 项目详情：项目 + 资产空间（自愈） + 能力挂载 + 动态流会话
   * @param id 项目 id
   */
  async getDetail(id: number, userId: number): Promise<ProjectDetail> {
    await this.assertProjectVisible(id, userId);
    const row = await prisma.project.findUnique({ where: { id } });
    const session = await prisma.session.findFirst({
      where: { projectId: id },
    });
    if (!row || !session) {
      throw new Error(PROJECT_NOT_FOUND);
    }
    const workspace = await this.ensureAssetWorkspace(row);
    const bindings = await this.listBindingItems(id);
    return {
      project: this.toRecord(row, session.id),
      assetWorkspaceId: workspace.id,
      bindings,
      // 响应内立即反映重绑后的资产空间（自愈当次即一致）
      session: this.toSession({ ...session, workspaceId: workspace.id }),
    };
  }

  /**
   * 创建项目：重名检查 → project + owner 成员 + 初始挂载 + 资产空间 + 动态流会话（含欢迎消息）
   * @param params 创建参数
   */
  async create(
    params: ProjectCreateParams,
    userId: number,
  ): Promise<ProjectRecord> {
    // v12 多用户隔离：ownerId 以 token 解出的用户为准，忽略前端传参
    const owned: ProjectCreateParams = { ...params, ownerId: userId };
    await this.ensureNameAvailable(userId, owned.name);
    const row = await prisma.project.create({
      data: {
        name: owned.name,
        systemPrompt: owned.systemPrompt,
        templateKey: owned.templateKey,
        ownerId: userId,
      },
    });
    await this.createOwnerAndBindings(row.id, userId, owned);
    const workspace = await this.ensureAssetWorkspace(row);
    const session = await this.createProjectSession(
      row.id,
      owned,
      workspace.id,
      userId,
    );
    return this.toRecord(row, session.id);
  }

  /**
   * 删除项目：先清资产空间（目录树 + workspace 行），再级联清
   * 附件关联 → 定时任务 → 计划事项 → planView → message → session → member →
   * binding → project（附件关联表无 projectId 列，按事项 id 集先删；
   * 双语义：删项目时文件实体随资产目录树一并销毁，仅删除单个计划事项
   * 路径的附件关联解绑会保留文件实体在资产空间）
   * @param id 项目 id
   */
  async remove(id: number, userId: number): Promise<void> {
    await this.assertProjectOwned(id, userId);
    await this.removeAssetWorkspace(id);
    // 级联清计划事项附件关联（v6 附件表无 projectId 列，按事项 id 集删；
    // 文件实体已随上面的资产目录树销毁——"保留在资产空间"仅是删除单个
    // 事项/解绑附件路径的语义，此处不再成立）
    const itemIds = await prisma.planItem.findMany({
      where: { projectId: id },
      select: { id: true },
    });
    await prisma.planItemAttachment.deleteMany({
      where: { planItemId: { in: itemIds.map((item) => item.id) } },
    });
    // 级联清项目定时任务（子系统 E）
    await prisma.automationTask.deleteMany({ where: { projectId: id } });
    // 级联清项目计划事项（projectId 精确匹配，本地任务 null 不受影响，三期 spec §3.1）
    await prisma.planItem.deleteMany({ where: { projectId: id } });
    // 级联清项目视图配置（子系统 A）
    await prisma.planView.deleteMany({ where: { projectId: id } });
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
  async update(params: ProjectUpdateParams, userId: number): Promise<void> {
    const row = await this.assertProjectOwned(params.id, userId);
    // 显式判空：name 缺席跳过校验；空串绕过重名校验（truthiness 漏洞）
    if (
      params.name !== undefined &&
      params.name.length > 0 &&
      params.name !== row.name
    ) {
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
    userId: number,
  ): Promise<void> {
    await this.assertProjectOwned(projectId, userId);
    await this.replaceBindings(projectId, items);
  }

  /** 挂载全量替换实现（创建流程内部复用，免权限校验） */
  private async replaceBindings(
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
   * 项目成员列表（joinedAt asc，owner 在前不保证——按加入序），
   * join user 取昵称（缺昵称回退用户名）
   */
  async listMembers(
    projectId: number,
    userId: number,
  ): Promise<ProjectMemberItem[]> {
    await this.assertProjectVisible(projectId, userId);
    const members = await prisma.projectMember.findMany({
      where: { projectId },
      orderBy: { joinedAt: "asc" },
    });
    const users = await prisma.user.findMany({
      where: { id: { in: members.map((m) => m.userId) } },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return members.map((m) => {
      const user = byId.get(m.userId);
      return {
        userId: m.userId,
        nickname: user?.nickname || user?.username || "",
        username: user?.username ?? "",
        role: m.role,
      };
    });
  }

  /**
   * 项目提示词上下文（项目模块一期）：project 行 + 三源挂载名/prompt 集合，
   * 供 ChatService 组装项目会话 system base（project-prompt.buildProjectSystemBase）
   * @param projectId 项目 id；项目行缺失返回 null（调用方回退助手 prompt）
   */
  async getPromptContext(
    projectId: number,
  ): Promise<ProjectPromptContext | null> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    });
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
            // 仅启用行（二期 §3.7 声明与实际一致）：禁用 server 的工具未注册
            // 进 registry，软约束声明不得将其列为可用能力
            where: { id: { in: idsByType.mcpServer }, enabled: true },
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
    userId: number,
    params: ProjectCreateParams,
  ): Promise<void> {
    await prisma.projectMember.create({
      data: { projectId, userId, role: "owner" },
    });
    const bindings = params.bindings ?? [];
    if (bindings.length > 0) {
      await this.replaceBindings(projectId, bindings);
    }
  }

  /**
   * 确保项目资产空间存在（幂等）：缺失时补建目录 + workspace 行，
   * 并把项目会话重绑到资产空间。二期新建项目与一期旧项目自愈共用
   * （升级后首个 getDetail 即完成迁移，无需 SQL 数据脚本，二期 §3.2）；
   * 三期资产仓储经构造注入复用，故为公开方法
   * @param project 项目行
   */
  async ensureAssetWorkspace(project: ProjectRow): Promise<WorkspaceRow> {
    const existing = await prisma.workspace.findFirst({
      where: { projectId: project.id },
    });
    if (existing) {
      return existing;
    }
    const directoryPath = this.assetsDirOf(project.id);
    await this.ensureAssetsDir(directoryPath);
    const workspace = await prisma.workspace.create({
      data: {
        name: `资产 · ${project.name}`,
        directoryPath,
        projectId: project.id,
        // v12 多用户隔离：资产空间随项目 owner
        userId: project.ownerId,
      },
    });
    await this.rebindProjectSessions(project.id, workspace.id);
    return workspace;
  }

  /** 建资产目录；失败转中文错误（附 cause，不落脏 workspace 行） */
  private async ensureAssetsDir(directoryPath: string): Promise<void> {
    try {
      await fs.mkdir(directoryPath, { recursive: true });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(`资产目录创建失败（${directoryPath}）：${cause}`, {
        cause: error,
      });
    }
  }

  /** 项目会话整体重绑资产空间（updateMany：一期异常数据容错多行） */
  private async rebindProjectSessions(
    projectId: number,
    workspaceId: number,
  ): Promise<void> {
    await prisma.session.updateMany({
      where: { projectId },
      data: { workspaceId },
    });
  }

  /**
   * 删除项目资产空间：rm 整个 projects/<id> 目录树（比只删 assets 干净）
   * + workspace 行。fs 失败仅记日志不抛出——项目 DB 级联必须完成，
   * 残留目录留待用户手动清理（记 concern，二期 §4 异常兜底）
   * @param projectId 项目 id
   */
  private async removeAssetWorkspace(projectId: number): Promise<void> {
    const workspace = await prisma.workspace.findFirst({
      where: { projectId },
    });
    if (!workspace) {
      return;
    }
    try {
      await fs.rm(this.projectRootDir(projectId, workspace.directoryPath), {
        recursive: true,
        force: true,
      });
    } catch (error) {
      Log.error(`删除项目资产目录失败（projectId=${projectId}）`, error);
    }
    await prisma.workspace.delete({ where: { id: workspace.id } });
  }

  /** 资产目录：userData/projects/<id>/assets（物理布局即目录树） */
  private assetsDirOf(projectId: number): string {
    return path.join(
      app.getPath("userData"),
      "projects",
      String(projectId),
      "assets",
    );
  }

  /** 项目根目录：优先取 workspace 行记录目录的父级，缺记录按约定路径兜底 */
  private projectRootDir(
    projectId: number,
    directoryPath: string | null,
  ): string {
    return directoryPath
      ? path.dirname(directoryPath)
      : path.dirname(this.assetsDirOf(projectId));
  }

  /**
   * 建动态流会话：挂项目资产空间，非空欢迎消息落首条消息。
   * 模型继承「全局最近一次选择」（二期口径：资产空间是新建空空间，
   * 按空间查恒取不到值——spec §2；hasModel 门控沿用一期用户反馈）
   */
  private async createProjectSession(
    projectId: number,
    params: ProjectCreateParams,
    workspaceId: number,
    userId: number,
  ): Promise<SessionRow> {
    const latest = await prisma.session.findFirst({
      where: { currentModelId: { not: null }, userId },
      orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
      select: { currentModelId: true },
    });
    const session = await prisma.session.create({
      data: {
        projectId,
        workspaceId,
        title: params.name,
        currentModelId: latest?.currentModelId ?? undefined,
        userId,
      },
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
