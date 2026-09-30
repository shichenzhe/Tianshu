import { dialog, shell } from "electron";
import prisma from "../../../commons/prisma-client";
import Log from "../../../commons/Log";
import { handleUser } from "../../../commons/ipc-user";
import fs from "node:fs/promises";
import path from "node:path";

import {
  readWorkspaceFile,
  resolveFilePath,
  type WorkspaceFileContent,
} from "./workspace-files";
import {
  aggregateArtifacts,
  type ArtifactMessageRow,
} from "./artifact-aggregate";
import type { ArtifactListItem } from "../../../../src-react/domains/ai/api/artifact.api";
import { classifyFileType } from "../library/library.utils";
import { PROJECT_NOT_FOUND } from "../../project/project.entity";
import type {
  MessageRecord,
  SearchMessageResult,
  SessionCreateParams,
  SessionMode,
  SessionRecord,
} from "../../../../src-react/domains/ai/api/session.api";
import type {
  WorkspaceCreateParams,
  WorkspaceRecord,
  WorkspaceUpdateParams,
} from "../../../../src-react/domains/ai/api/workspace.api";

type WorkspaceRow = NonNullable<
  Awaited<ReturnType<typeof prisma.workspace.findFirst>>
>;
export type SessionRow = NonNullable<
  Awaited<ReturnType<typeof prisma.session.findFirst>>
>;
type MessageRow = NonNullable<
  Awaited<ReturnType<typeof prisma.message.findFirst>>
>;

export interface AppendMessageParams {
  sessionId: number;
  role: "user" | "assistant" | "system";
  blocks: string;
  modelId?: number;
  assistantId?: number;
  error?: string;
  /** 生成耗时毫秒(assistant 轮) */
  durationMs?: number;
}

export class SessionRepository {
  constructor() {
    this.registerIpcHandlers();
  }

  private toWorkspace(row: WorkspaceRow): WorkspaceRecord {
    return {
      ...row,
      icon: row.icon ?? undefined,
      directoryPath: row.directoryPath ?? undefined,
      defaultModelId: row.defaultModelId ?? undefined,
      writeApprovedAt: row.writeApprovedAt?.toISOString() ?? undefined,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toSession(row: SessionRow): SessionRecord {
    return {
      ...row,
      assistantId: row.assistantId ?? undefined,
      currentModelId: row.currentModelId ?? undefined,
      // P3：DB null（agent 缺省不落盘）归一为显式 "agent"
      mode: (row.mode as SessionMode | null) ?? "agent",
      lastMessageAt: row.lastMessageAt?.toISOString() ?? undefined,
      pinnedAt: row.pinnedAt?.toISOString() ?? undefined,
      archivedAt: row.archivedAt?.toISOString() ?? undefined,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toMessage(row: MessageRow): MessageRecord {
    return {
      ...row,
      role: row.role as MessageRecord["role"],
      modelId: row.modelId ?? undefined,
      assistantId: row.assistantId ?? undefined,
      error: row.error ?? undefined,
      durationMs: row.durationMs ?? undefined,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private registerIpcHandlers() {
    // userId 由 token 解出（commons/ipc-user），业务参数依次排在其后
    handleUser("workspace:list", (_, userId) => this.listWorkspaces(userId));
    handleUser("workspace:create", (_, userId, p: WorkspaceCreateParams) =>
      this.createWorkspace(p, userId),
    );
    handleUser("workspace:update", (_, userId, p: WorkspaceUpdateParams) =>
      this.updateWorkspace(p, userId),
    );
    handleUser("workspace:delete", (_, userId, id: number) =>
      this.deleteWorkspace(id, userId),
    );
    handleUser("session:listByWorkspace", (_, userId, workspaceId: number) =>
      this.listSessions(workspaceId, userId),
    );
    handleUser("session:create", (_, userId, p: SessionCreateParams) =>
      this.createSession(p, userId),
    );
    handleUser("session:rename", (_, userId, id: number, title: string) =>
      this.renameSession(id, title, userId),
    );
    handleUser("session:delete", (_, userId, id: number) =>
      this.deleteSession(id, userId),
    );
    handleUser(
      "session:setModel",
      (_, userId, id: number, modelId: number | null) =>
        this.setSessionModel(id, modelId, userId),
    );
    handleUser(
      "session:setAssistant",
      (_, userId, id: number, assistantId: number | null) =>
        this.setSessionAssistant(id, assistantId, userId),
    );
    handleUser("session:setMode", (_, userId, id: number, mode: SessionMode) =>
      this.setSessionMode(id, mode, userId),
    );
    handleUser("session:listAll", (_, userId) => this.listAllSessions(userId));
    handleUser("session:pin", (_, userId, id: number, pinned: boolean) =>
      this.pinSession(id, pinned, userId),
    );
    handleUser("session:archive", (_, userId, id: number, archived: boolean) =>
      this.archiveSession(id, archived, userId),
    );
    handleUser("session:searchByTitle", (_, userId, keyword: string) =>
      this.searchSessionsByTitle(keyword, userId),
    );
    handleUser("workspace:openDirectory", (_, userId, workspaceId: number) =>
      this.openWorkspaceDirectory(workspaceId, userId),
    );
    // 双通道差异：workspace:readFile（产物面板预览）fullAccess 语义——绝对路径
    // 直接用，服务会话内 write_file 记录的任意路径；既有 file:readWorkspaceFile
    // （chat.service.ts，AI 工具读取）走 resolveSafePath 沙箱校验。两通道有意
    // 不同，后续可将读取上限/NUL 逻辑整合进 file-tools.ts。
    handleUser(
      "workspace:readFile",
      (_, userId, workspaceId: number, relPath: string) =>
        this.readWorkspaceFileById(workspaceId, relPath, userId),
    );
    handleUser(
      "workspace:revealFile",
      (_, userId, workspaceId: number, relPath: string) =>
        this.revealWorkspaceFile(workspaceId, relPath, userId),
    );
    handleUser("workspace:listArtifacts", (_, userId) =>
      this.listArtifacts(userId),
    );
    handleUser(
      "workspace:toggleArtifactFavorite",
      (_, userId, workspaceId: number, relPath: string) =>
        this.toggleArtifactFavorite(userId, workspaceId, relPath),
    );
    handleUser(
      "workspace:exportFile",
      (_, userId, workspaceId: number, relPath: string) =>
        this.exportWorkspaceFile(workspaceId, relPath, userId),
    );
    handleUser("message:listBySession", (_, userId, sessionId: number) =>
      this.listMessages(sessionId, userId),
    );
    handleUser("message:search", (_, userId, keyword: string) =>
      this.searchMessages(keyword, userId),
    );
  }

  /** 校验工作空间归当前用户（不存在与他人所有同报错，不泄露存在性） */
  async assertWorkspaceOwned(id: number, userId: number): Promise<void> {
    const row = await prisma.workspace.findFirst({ where: { id, userId } });
    if (!row) {
      throw new Error("WORKSPACE_NOT_FOUND");
    }
  }

  /** 校验会话归当前用户（v12 起 session 冗余 userId）；chat.service 流式链路共用 */
  async assertSessionOwned(id: number, userId: number): Promise<void> {
    const row = await prisma.session.findFirst({ where: { id, userId } });
    if (!row) {
      throw new Error("SESSION_NOT_FOUND");
    }
  }

  /** 校验模型经 provider 链归当前用户（防把他人的 provider key 设进自己会话） */
  private async assertModelOwnedByUser(
    modelId: number,
    userId: number,
  ): Promise<void> {
    // model 与 provider 无 Prisma relation（裸列 providerId），两步查询
    const model = await prisma.model.findUnique({
      where: { id: modelId },
      select: { providerId: true },
    });
    const provider = model
      ? await prisma.provider.findUnique({
          where: { id: model.providerId },
          select: { userId: true },
        })
      : null;
    if (!provider || provider.userId !== userId) {
      throw new Error("MODEL_NOT_FOUND");
    }
  }

  /** 校验助手归当前用户（builtin 已按用户播种，直接比对 userId） */
  private async assertAssistantOwnedByUser(
    assistantId: number,
    userId: number,
  ): Promise<void> {
    const row = await prisma.assistant.findFirst({
      where: { id: assistantId, userId },
    });
    if (!row) {
      throw new Error("ASSISTANT_NOT_FOUND");
    }
  }

  /**
   * AI 侧边栏空间列表：过滤项目资产空间（projectId 非空不进分组树，二期 §3.2）。
   * 用户首次进入无空间时补建默认工作空间（原启动期 ensureDefaultWorkspace
   * 因多用户隔离改为按用户补建）
   */
  async listWorkspaces(userId: number): Promise<WorkspaceRecord[]> {
    const ownedCount = await prisma.workspace.count({
      where: { userId },
    });
    if (ownedCount === 0) {
      await prisma.workspace.create({
        data: { name: "默认工作空间", userId },
      });
    }
    return (
      await prisma.workspace.findMany({
        where: { projectId: null, userId },
        orderBy: { createdAt: "asc" },
      })
    ).map((row) => this.toWorkspace(row));
  }

  async getWorkspace(id: number): Promise<WorkspaceRow | null> {
    return prisma.workspace.findUnique({ where: { id } });
  }

  async createWorkspace(
    p: WorkspaceCreateParams,
    userId: number,
  ): Promise<WorkspaceRecord> {
    const row = await prisma.workspace.create({
      data: {
        name: p.name,
        icon: p.icon,
        defaultModelId: p.defaultModelId,
        // 「打开本地空间」一步建绑（其余入口不传 = 不设置）
        directoryPath: p.directoryPath,
        userId,
      },
    });
    return this.toWorkspace(row);
  }

  async updateWorkspace(
    p: WorkspaceUpdateParams,
    userId: number,
  ): Promise<WorkspaceRecord> {
    await this.assertWorkspaceOwned(p.id, userId);
    // v12 隔离：默认模型经 provider 链校验归属
    if (p.defaultModelId != null) {
      await this.assertModelOwnedByUser(p.defaultModelId, userId);
    }
    const row = await prisma.workspace.update({
      where: { id: p.id },
      data: { name: p.name, icon: p.icon, defaultModelId: p.defaultModelId },
    });
    return this.toWorkspace(row);
  }

  /**
   * P1 工作空间目录绑定/解绑：null 为解绑（历史消息保留，仅收回 AI 文件入口）。
   * directoryPath 已由调用方（ChatService）归一化；独立于 workspace:update 通道
   */
  async updateWorkspaceBoundDirectory(
    id: number,
    directoryPath: string | null,
    userId: number,
  ): Promise<WorkspaceRecord> {
    await this.assertWorkspaceOwned(id, userId);
    const row = await prisma.workspace.update({
      where: { id },
      data: { directoryPath },
    });
    return this.toWorkspace(row);
  }

  async deleteWorkspace(id: number, userId: number): Promise<void> {
    await this.assertWorkspaceOwned(id, userId);
    const sessions = await prisma.session.findMany({
      where: { workspaceId: id },
      select: { id: true },
    });
    await prisma.message.deleteMany({
      where: { sessionId: { in: sessions.map((s) => s.id) } },
    });
    await prisma.session.deleteMany({ where: { workspaceId: id } });
    await prisma.workspace.delete({ where: { id } });
  }

  async listSessions(
    workspaceId: number,
    userId: number,
  ): Promise<SessionRecord[]> {
    await this.assertWorkspaceOwned(workspaceId, userId);
    return (
      await prisma.session.findMany({
        // 项目会话不进 AI 任务树（项目模块一期会话隔离）
        where: { workspaceId, archivedAt: null, projectId: null },
        orderBy: { lastMessageAt: "desc" },
      })
    ).map((row) => this.toSession(row));
  }

  async getSession(id: number): Promise<SessionRow | null> {
    return prisma.session.findUnique({ where: { id } });
  }

  async createSession(
    p: SessionCreateParams,
    userId: number,
  ): Promise<SessionRecord> {
    // 任务会话复用（一期统一 D1：一任务一会话）——已有会话绑定该事项
    // 直接返回既有会话（复用语义不报错，并发双击兜底）
    if (p.planItemId != null) {
      const existing = await this.findSessionByPlanItem(p.planItemId, userId);
      if (existing) {
        return this.toSession(existing);
      }
    }
    // 项目会话 workspaceId 强制取项目资产空间（D1：防前端传错/未传；与
    // project.repo 解析口径一致——直接查 workspace 表避免循环依赖）
    const workspaceId =
      p.projectId != null
        ? await this.resolveProjectWorkspaceId(p.projectId, userId)
        : (p.workspaceId ?? null);
    // 两键皆空：无目标空间可挂（projectId 与 workspaceId 至少其一非空）
    if (workspaceId == null) {
      throw new Error("WORKSPACE_NOT_FOUND");
    }
    // 归属校验；会话 userId 冗余列随工作空间写入
    await this.assertWorkspaceOwned(workspaceId, userId);
    // v12 隔离：显式指定助手时校验归属
    if (p.assistantId != null) {
      await this.assertAssistantOwnedByUser(p.assistantId, userId);
    }
    const row = await this.createSessionRow(p, workspaceId, userId);
    return this.toSession(row);
  }

  /** 任务会话查重（D1：planItemId 一任务一会话；查询携 userId 隔离） */
  private async findSessionByPlanItem(
    planItemId: number,
    userId: number,
  ): Promise<SessionRow | null> {
    return prisma.session.findFirst({ where: { planItemId, userId } });
  }

  /** 项目资产空间解析：workspace.projectId 命中行（查不到即项目不可见，同报错） */
  private async resolveProjectWorkspaceId(
    projectId: number,
    userId: number,
  ): Promise<number> {
    const workspace = await prisma.workspace.findFirst({
      where: { projectId, userId },
    });
    if (!workspace) {
      throw new Error(PROJECT_NOT_FOUND);
    }
    return workspace.id;
  }

  /**
   * 会话落库：projectId/planItemId/title 透传；新会话继承同工作空间最近
   * 一次选择的模型（用户反馈：默认丢失上次选择；v12 隔离：继承源自本人
   * 会话）。title 缺省「新会话」（普通会话行为不变；任务会话由推进入口
   * 传任务标题，非默认标题亦不参与首条消息自动改名）
   */
  private async createSessionRow(
    p: SessionCreateParams,
    workspaceId: number,
    userId: number,
  ): Promise<SessionRow> {
    const latest = await prisma.session.findFirst({
      where: { workspaceId, currentModelId: { not: null }, userId },
      orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
      select: { currentModelId: true },
    });
    return prisma.session.create({
      data: {
        workspaceId,
        projectId: p.projectId ?? null,
        planItemId: p.planItemId ?? null,
        assistantId: p.assistantId,
        scenario: p.scenario ?? null,
        currentModelId: latest?.currentModelId ?? undefined,
        title: p.title ?? "新会话",
        userId,
      },
    });
  }

  /**
   * v5：全部未归档任务（标准侧边栏分组树数据源）；一期统一：项目/任务
   * 会话一并返回（D4——侧边栏项目分组数据源，批 2 做分组渲染）
   */
  async listAllSessions(userId: number): Promise<SessionRecord[]> {
    return (
      await prisma.session.findMany({
        where: { archivedAt: null, userId },
        orderBy: { lastMessageAt: "desc" },
      })
    ).map((row) => this.toSession(row));
  }

  /**
   * /compact 会话压缩(v8):summary 为空串/null 即清压缩态;
   * upToId 为覆盖到的最后一条消息 id(后续上下文只取其后)
   */
  async updateSummary(
    id: number,
    summary: string | null,
    compactedUpToId: number | null,
  ): Promise<void> {
    await prisma.session.update({
      where: { id },
      data: { summary, compactedUpToId },
    });
  }

  /** v5 置顶：置 true 记时间戳（前端按其倒序排列），false 清空 */
  async pinSession(id: number, pinned: boolean, userId: number): Promise<void> {
    await this.assertSessionOwned(id, userId);
    await prisma.session.update({
      where: { id },
      data: { pinnedAt: pinned ? new Date() : null },
    });
  }

  /** v5 归档：归档任务从列表/搜索消失，撤销即清空 */
  async archiveSession(
    id: number,
    archived: boolean,
    userId: number,
  ): Promise<void> {
    await this.assertSessionOwned(id, userId);
    await prisma.session.update({
      where: { id },
      data: { archivedAt: archived ? new Date() : null },
    });
  }

  /**
   * v5 任务标题搜索：空关键词退化为最近任务（spec §4.1）；一期统一
   * （D4）：项目/任务会话可被搜到——验收标准 1「标题搜索可命中」
   */
  async searchSessionsByTitle(
    keyword: string,
    userId: number,
  ): Promise<SessionRecord[]> {
    const trimmed = keyword.trim();
    const where = trimmed
      ? { title: { contains: trimmed }, archivedAt: null, userId }
      : { archivedAt: null, userId };
    return (
      await prisma.session.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        take: 20,
      })
    ).map((row) => this.toSession(row));
  }

  /** v5 打开空间绑定目录（上下文菜单「打开文件夹」） */
  async openWorkspaceDirectory(
    workspaceId: number,
    userId: number,
  ): Promise<void> {
    await this.assertWorkspaceOwned(workspaceId, userId);
    const workspace = await this.getWorkspace(workspaceId);
    if (workspace?.directoryPath) {
      await shell.openPath(workspace.directoryPath);
    }
  }

  /** 产物面板：读工作空间文件（预览）。ENOENT/二进制等由纯逻辑抛中文文案 */
  async readWorkspaceFileById(
    workspaceId: number,
    relPath: string,
    userId: number,
  ): Promise<WorkspaceFileContent> {
    await this.assertWorkspaceOwned(workspaceId, userId);
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace?.directoryPath) throw new Error("工作空间未绑定目录");
    return readWorkspaceFile(resolveFilePath(workspace.directoryPath, relPath));
  }

  /** 产物面板：Finder 定位文件 */
  async revealWorkspaceFile(
    workspaceId: number,
    relPath: string,
    userId: number,
  ): Promise<void> {
    await this.assertWorkspaceOwned(workspaceId, userId);
    const workspace = await this.getWorkspace(workspaceId);
    if (workspace?.directoryPath) {
      shell.showItemInFolder(resolveFilePath(workspace.directoryPath, relPath));
    }
  }

  /**
   * 本地产物列表（资料库「本地产物」视图）：跨会话聚合 write_file 记录，
   * 已删除/非文件条目直接剔除（用户裁定：不进列表）
   */
  async listArtifacts(userId: number): Promise<ArtifactListItem[]> {
    const sessions = await prisma.session.findMany({
      where: { userId },
      select: { id: true, workspaceId: true, title: true },
    });
    if (sessions.length === 0) return [];
    const messages = await this.findArtifactMessages(sessions);
    const aggregated = aggregateArtifacts(
      messages,
      await this.findArtifactWorkspaces(sessions),
      new Map(sessions.map((s) => [s.id, s.title])),
    );
    const favorites = await prisma.artifactFavorite.findMany({
      where: { userId },
      select: { workspaceId: true, relPath: true },
    });
    const favSet = new Set(
      favorites.map((f) => `${f.workspaceId}:${f.relPath}`),
    );
    return this.filterExistingArtifacts(aggregated, favSet);
  }

  /** 产物收藏开关（独立表 toggle：命中则删返回 false，否则建返回 true） */
  async toggleArtifactFavorite(
    userId: number,
    workspaceId: number,
    relPath: string,
  ): Promise<boolean> {
    const removed = await prisma.artifactFavorite.deleteMany({
      where: { workspaceId, relPath, userId },
    });
    if (removed.count > 0) return false;
    await prisma.artifactFavorite.create({
      data: { workspaceId, relPath, userId },
    });
    return true;
  }

  /** 含 write_file 的消息（LIKE 粗筛，精确过滤在聚合纯函数），补所属工作空间 id */
  private async findArtifactMessages(
    sessions: Array<{ id: number; workspaceId: number }>,
  ): Promise<ArtifactMessageRow[]> {
    const wsOfSession = new Map(sessions.map((s) => [s.id, s.workspaceId]));
    const rows = await prisma.message.findMany({
      where: {
        sessionId: { in: sessions.map((s) => s.id) },
        blocks: { contains: "write_file" },
      },
      select: {
        id: true,
        sessionId: true,
        role: true,
        blocks: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => ({
      ...row,
      workspaceId: wsOfSession.get(row.sessionId)!,
    }));
  }

  /** 涉及的工作空间来源表（name 供展示、directoryPath 供路径 resolve） */
  private async findArtifactWorkspaces(
    sessions: Array<{ workspaceId: number }>,
  ): Promise<Map<number, { name: string; directoryPath: string | null }>> {
    const ids = [...new Set(sessions.map((s) => s.workspaceId))];
    const rows = await prisma.workspace.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, directoryPath: true },
    });
    return new Map(
      rows.map((w) => [w.id, { name: w.name, directoryPath: w.directoryPath }]),
    );
  }

  /** stat 校验存在且为普通文件，附文件大小/扩展名分类/收藏态；失败剔除不抛 */
  private async filterExistingArtifacts(
    aggregated: ReturnType<typeof aggregateArtifacts>,
    favorites: ReadonlySet<string>,
  ): Promise<ArtifactListItem[]> {
    const out: ArtifactListItem[] = [];
    for (const item of aggregated) {
      try {
        const stat = await fs.stat(item.path);
        if (stat.isFile()) {
          out.push({
            ...item,
            fileType: classifyFileType(item.name),
            size: stat.size,
            favorite: favorites.has(`${item.workspaceId}:${item.relPath}`),
          });
        }
      } catch {
        // 已删除或不可访问——直接剔除（保留会与磁盘现状不符）
      }
    }
    return out;
  }

  /** 产物面板：另存为副本（"下载"）。用户取消返回 null */
  async exportWorkspaceFile(
    workspaceId: number,
    relPath: string,
    userId: number,
  ): Promise<string | null> {
    await this.assertWorkspaceOwned(workspaceId, userId);
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace?.directoryPath) throw new Error("工作空间未绑定目录");
    const absPath = resolveFilePath(workspace.directoryPath, relPath);
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: path.basename(absPath),
    });
    if (canceled || !filePath) return null;
    try {
      await fs.copyFile(absPath, filePath);
    } catch (e) {
      Log.warn("产物另存失败", e instanceof Error ? e.message : e);
      throw new Error("另存失败，请检查源文件与目标位置", { cause: e });
    }
    return filePath;
  }

  async renameSession(
    id: number,
    title: string,
    userId: number,
  ): Promise<void> {
    await this.assertSessionOwned(id, userId);
    await prisma.session.update({ where: { id }, data: { title } });
  }

  async deleteSession(id: number, userId: number): Promise<void> {
    await this.assertSessionOwned(id, userId);
    // automationRun.sessionId 为裸列（无外键级联）——先置空再删会话，
    // 避免运行记录残留指向已删会话的死链（历史 run 保留供任务统计）
    await prisma.$transaction([
      prisma.automationRun.updateMany({
        where: { sessionId: id },
        data: { sessionId: null },
      }),
      prisma.message.deleteMany({ where: { sessionId: id } }),
      prisma.session.delete({ where: { id } }),
    ]);
  }

  async setSessionModel(
    id: number,
    modelId: number | null,
    userId: number,
  ): Promise<void> {
    await this.assertSessionOwned(id, userId);
    if (modelId !== null) {
      await this.assertModelOwnedByUser(modelId, userId);
    }
    await prisma.session.update({
      where: { id },
      data: { currentModelId: modelId },
    });
  }

  async setSessionAssistant(
    id: number,
    assistantId: number | null,
    userId: number,
  ): Promise<void> {
    await this.assertSessionOwned(id, userId);
    if (assistantId !== null) {
      await this.assertAssistantOwnedByUser(assistantId, userId);
    }
    await prisma.session.update({
      where: { id },
      data: { assistantId },
    });
  }

  /** P3 会话模式："agent" 写 null（缺省不落盘，保持 DB 干净） */
  async setSessionMode(
    id: number,
    mode: SessionMode,
    userId: number,
  ): Promise<void> {
    await this.assertSessionOwned(id, userId);
    await prisma.session.update({
      where: { id },
      data: { mode: mode === "agent" ? null : mode },
    });
  }

  async listMessages(
    sessionId: number,
    userId: number,
  ): Promise<MessageRecord[]> {
    await this.assertSessionOwned(sessionId, userId);
    return (
      await prisma.message.findMany({
        where: { sessionId },
        orderBy: { createdAt: "asc" },
      })
    ).map((row) => this.toMessage(row));
  }

  /** P0 历史搜索：LIKE 查询（spec §4.2），附带所属会话信息供搜索结果跳转 */
  async searchMessages(
    keyword: string,
    userId: number,
  ): Promise<SearchMessageResult[]> {
    // 会话域统一（D11）：项目会话消息一并可搜——按当前用户全部会话
    // id 集限定搜索范围（v12 隔离口径不变，仅去掉 projectId 过滤）
    const visibleSessions = await prisma.session.findMany({
      where: { userId },
      select: { id: true },
    });
    const rows = (
      await prisma.message.findMany({
        where: {
          blocks: { contains: keyword },
          sessionId: { in: visibleSessions.map((s) => s.id) },
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      })
    ).map((row) => this.toMessage(row));
    // 批量取关联会话（标题 + 工作空间），消息必属已有会话，缺失时兜底空值
    const sessionIds = [...new Set(rows.map((row) => row.sessionId))];
    const sessions = await prisma.session.findMany({
      where: { id: { in: sessionIds } },
      select: { id: true, workspaceId: true, title: true },
    });
    const byId = new Map(sessions.map((session) => [session.id, session]));
    return rows.map((row) => ({
      ...row,
      workspaceId: byId.get(row.sessionId)?.workspaceId ?? 0,
      sessionTitle: byId.get(row.sessionId)?.title ?? "",
    }));
  }

  /** 解析生效模型：会话当前 > 工作空间默认（spec §4.2） */
  async getEffectiveModelId(sessionId: number): Promise<number | null> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return null;
    }
    if (session.currentModelId) {
      return session.currentModelId;
    }
    const workspace = await this.getWorkspace(session.workspaceId);
    return workspace?.defaultModelId ?? null;
  }

  /** chat.service 专用：追加消息并刷新会话时间戳 */
  async appendMessage(p: AppendMessageParams): Promise<MessageRow> {
    const message = await prisma.message.create({
      data: {
        sessionId: p.sessionId,
        role: p.role,
        blocks: p.blocks,
        modelId: p.modelId,
        assistantId: p.assistantId,
        error: p.error,
        durationMs: p.durationMs,
      },
    });
    await prisma.session.update({
      where: { id: p.sessionId },
      data: { lastMessageAt: new Date(), updatedAt: new Date() },
    });
    return message;
  }

  /** chat.service 专用：首条用户消息生成标题 */
  async autotitleIfDefault(
    sessionId: number,
    content: string,
    userId: number,
  ): Promise<void> {
    const session = await this.getSession(sessionId);
    if (session && session.title === "新会话") {
      await this.renameSession(sessionId, content.slice(0, 20), userId);
    }
  }
}
