import { dialog, shell } from "electron";
import prisma from "../../../commons/prisma-client";
import type { Prisma } from "../../../generated/prisma/client";
import Log from "../../../commons/Log";
import { handleUser } from "../../../commons/ipc-user";
import fs from "node:fs/promises";
import path from "node:path";

import {
  readWorkspaceFile,
  resolveFilePath,
  type WorkspaceFileContent,
} from "./workspace-files";
import { listWorkspaceDir, type DirEntry } from "./workspace-dir";
import { gitFileDiff, gitWorkingChanges } from "./git-changes";
import {
  aggregateArtifacts,
  extractPaths,
  type AggregatedArtifact,
  type ArtifactMessageRow,
} from "./artifact-aggregate";
import { getAppOptionMap, setAppOption } from "../../app-settings/option-store";
import { summarizeLastMessage } from "@tianshu/core/last-message";
import type { SessionLastMessage, SessionReadResult } from "@tianshu/protocol";
import { revokeSession } from "../file-window/granted-paths";
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

/** P1 未读角标批：会话行 + 查询期动态计算的未读角标/末条摘要（不落盘，
 *  非 Prisma 行——经 listAllSessionsSummarized/getSessionSummary 产出） */
export type SessionSummaryRecord = SessionRecord & {
  unreadCount: number;
  lastMessage: SessionLastMessage | null;
};

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

/** 被控面 session/query 查询参数（语义照搬 tianshu-server
 *  SessionQueryDto：keyword 大小写敏感契约、archived 布尔、activityAfter
 *  活动时间窗 lastMessageAt ?? updatedAt，阈值含边界） */
export interface SessionQueryParams {
  page?: number;
  pageSize?: number;
  /** 标题大小写敏感 includes（空串/缺省不过滤；SQLite LIKE 大小写不敏感
   *  无法下推，契约不变走内存精确过滤） */
  keyword?: string;
  workspaceId?: number;
  archived?: boolean;
  activityAfter?: Date;
}

/** 分页协议（starter QueryResult 同构：{page,pageSize,records,total}） */
export interface SessionQueryPage {
  page: number;
  pageSize: number;
  records: SessionSummaryRecord[];
  total: number;
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
    handleUser("session:listAll", (_, userId) =>
      this.listAllSessionsSummarized(userId),
    );
    handleUser("session:pin", (_, userId, id: number, pinned: boolean) =>
      this.pinSession(id, pinned, userId),
    );
    handleUser("session:archive", (_, userId, id: number, archived: boolean) =>
      this.archiveSession(id, archived, userId),
    );
    handleUser("session:searchByTitle", (_, userId, keyword: string) =>
      this.searchSessionsByTitle(keyword, userId),
    );
    // 文件窗 AI 面板（T22）按 id 精确拉取单会话（ChatPane 渲染数据源）
    handleUser("session:getById", (_, userId, p: { id: number }) =>
      this.getSessionById(p.id, userId),
    );
    // P1 尾未读角标：已读游标单调推进（ChatPane 历史就绪/本会话轮次
    // 定稿后上报 maxMessageId——发送方自身 assistant 消息同推游标，与
    // 移动端 loadHistory 后上报同语义；游标条件写天然防回退）
    handleUser(
      "session:markRead",
      (_, userId, sessionId: number, messageId: number) =>
        this.markSessionRead(sessionId, messageId, userId),
    );
    handleUser("workspace:openDirectory", (_, userId, workspaceId: number) =>
      this.openWorkspaceDirectory(workspaceId, userId),
    );
    // 双通道差异：workspace:readFile（产物面板预览）fullAccess 语义——绝对路径
    // 直接用，服务会话内 write 记录的任意路径；既有 file:readWorkspaceFile
    // （chat.service.ts，AI 工具读取）走 resolveSafePath 沙箱校验。两通道有意
    // 不同，后续可将读取上限/NUL 逻辑整合进 file-tools.ts。
    handleUser(
      "workspace:readFile",
      (_, userId, workspaceId: number, relPath: string) =>
        this.readWorkspaceFileById(workspaceId, relPath, userId),
    );
    // 工作空间 tab 文件树：沙箱语义列目录（与 readFile 的 fullAccess
    // 双通道差异见 workspace-dir.ts 头注释）
    handleUser(
      "workspace:listDir",
      (_, userId, workspaceId: number, relPath: string) =>
        this.listWorkspaceDirById(workspaceId, relPath, userId),
    );
    // 查看变更 tab：工作树变更列表与单文件 diff（git 只读三命令白名单）
    handleUser("workspace:gitStatus", (_, userId, workspaceId: number) =>
      this.gitStatusById(workspaceId, userId),
    );
    handleUser(
      "workspace:gitDiff",
      (_, userId, workspaceId: number, relPath: string) =>
        this.gitDiffById(workspaceId, relPath, userId),
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
    handleUser(
      "message:listBySession",
      (
        _,
        userId,
        sessionId: number,
        opts?: { beforeId?: number; limit?: number },
      ) => this.listMessages(sessionId, userId, opts),
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
  async assertSessionOwned(
    id: number,
    userId: number,
    /** 归档会话拒绝写入（只读查看）：send/regenerate/editAndResend 入口传 true */
    rejectArchived = false,
  ): Promise<void> {
    const row = await prisma.session.findFirst({ where: { id, userId } });
    if (!row) {
      throw new Error("SESSION_NOT_FOUND");
    }
    if (rejectArchived && row.archivedAt) {
      throw new Error("ARCHIVED_SESSION");
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
      select: { id: true, userId: true },
    });
    await prisma.message.deleteMany({
      where: { sessionId: { in: sessions.map((s) => s.id) } },
    });
    await prisma.session.deleteMany({ where: { workspaceId: id } });
    await prisma.workspace.delete({ where: { id } });
    // 会话级路径授权随删回收（T28 spec §16 项 1）：行删成功后尽力回收
    // （revoke 内部自吞错），桶键取会话行自带 userId（与授权注册口径一致）
    for (const s of sessions) {
      await revokeSession(s.id, s.userId ?? null);
    }
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

  /** 文件窗 AI 面板（T22）按 id 拉取单会话：归属校验（findFirst 带
   *  userId，他人会话与已删同报错不泄露存在性）后 toSession 序列化 */
  async getSessionById(id: number, userId: number): Promise<SessionRecord> {
    const row = await prisma.session.findFirst({ where: { id, userId } });
    if (!row) {
      throw new Error("SESSION_NOT_FOUND");
    }
    return this.toSession(row);
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
    // 含归档（前端 splitArchived 拆「已归档」分组——归档可查看只读）；
    // 排序对齐 tianshu-server querydecoder 默认序：置顶优先（pinnedAt
    // 倒序，NULL 居尾 SQLite DESC）→ lastMessageAt 倒序 → id 次键保分页确定
    return (await prisma.session.findMany(this.sessionListArgs(userId))).map(
      (row) => this.toSession(row),
    );
  }

  /** listAllSessions 的查询参数（enriched 变体复用同一序，行为零偏差） */
  private sessionListArgs(userId: number) {
    return {
      where: { userId },
      orderBy: [
        { pinnedAt: "desc" as const },
        { lastMessageAt: "desc" as const },
        { id: "desc" as const },
      ],
    };
  }

  /** P1 未读角标批：会话列表 enriched 数据源（本地 IPC session:list）。
   *  恒定两条聚合批量计算末条摘要 + 未读数（enrich 逻辑与 querySessions
   *  共享 enrichSummaries，全量语义与返回形状逐字节不变） */
  async listAllSessionsSummarized(
    userId: number,
  ): Promise<SessionSummaryRecord[]> {
    return this.enrichSummaries(
      await prisma.session.findMany(this.sessionListArgs(userId)),
    );
  }

  /**
   * 被控面 session/query 数据源（face 全表扫描优化批）：workspaceId/archived/
   * activityAfter 条件下推 DB，排序固定三键（与 listAll 同序）。非 keyword
   * 走 findMany(skip/take) + count 仅当前页 enrich；有 keyword 下推其余条件
   * 取候选集内存大小写敏感过滤（SQLite LIKE 无法表达契约），total=filtered
   * .length 后内存 slice，仍仅当前页 enrich——翻页不再重复全量聚合
   */
  async querySessions(
    params: SessionQueryParams,
    userId: number,
  ): Promise<SessionQueryPage> {
    const page = Math.max(1, Math.trunc(params.page ?? 1));
    const pageSize = Math.min(
      500,
      Math.max(1, Math.trunc(params.pageSize ?? 100)),
    );
    const skip = (page - 1) * pageSize;
    const where = this.sessionQueryWhere(params, userId);
    const orderBy = [
      { pinnedAt: "desc" as const },
      { lastMessageAt: "desc" as const },
      { id: "desc" as const },
    ];
    let rows: SessionRow[];
    let total: number;
    if (params.keyword) {
      // 候选集全量（不下推 keyword），内存精确过滤后分页
      const candidates = await prisma.session.findMany({ where, orderBy });
      const filtered = candidates.filter((row) =>
        (row.title ?? "").includes(params.keyword!),
      );
      total = filtered.length;
      rows = filtered.slice(skip, skip + pageSize);
    } else {
      const [pageRows, totalCount] = await Promise.all([
        prisma.session.findMany({ where, orderBy, skip, take: pageSize }),
        prisma.session.count({ where }),
      ]);
      rows = pageRows;
      total = totalCount;
    }
    return { page, pageSize, records: await this.enrichSummaries(rows), total };
  }

  /** querySessions 的 where 下推（语义照搬无头端 session.querydecoder：
   *  activityAfter = lastMessageAt gte since OR (lastMessageAt null AND
   *  updatedAt gte since)，保两端同行为） */
  private sessionQueryWhere(
    params: SessionQueryParams,
    userId: number,
  ): Prisma.sessionWhereInput {
    const where: Prisma.sessionWhereInput = { userId };
    if (params.workspaceId != null) {
      where.workspaceId = params.workspaceId;
    }
    if (typeof params.archived === "boolean") {
      // SQLite 语义：null 表示未归档
      where.archivedAt = params.archived ? { not: null } : null;
    }
    if (params.activityAfter) {
      const since = params.activityAfter;
      where.AND = [
        {
          OR: [
            { lastMessageAt: { gte: since } },
            // lastMessageAt 为 null 的行回退 updatedAt 比较
            { AND: [{ lastMessageAt: null }, { updatedAt: { gte: since } }] },
          ],
        },
      ];
    }
    return where;
  }

  /** 批量 enrich 共享步骤：恒定两条聚合（禁 N+1）批量计算末条摘要 + 未读
   *  数——listAllSessionsSummarized/getSessionSummary/querySessions 同口径，
   *  空行集短路零聚合查询 */
  private async enrichSummaries(
    rows: SessionRow[],
  ): Promise<SessionSummaryRecord[]> {
    if (rows.length === 0) {
      return [];
    }
    const [lastById, unreadById] = await Promise.all([
      this.fetchLastMessages(rows.map((row) => row.id)),
      this.countUnreadBySessions(rows),
    ]);
    return rows.map((row) => {
      const session = this.toSession(row);
      return {
        ...session,
        unreadCount: unreadById.get(row.id) ?? 0,
        lastMessage: lastById.get(row.id) ?? null,
      };
    });
  }

  /** P1 未读角标批：单行 enriched 摘要（session.updated 事件/读毕刷新） */
  async getSessionSummary(
    id: number,
    userId: number,
  ): Promise<SessionSummaryRecord | null> {
    const row = await prisma.session.findFirst({ where: { id, userId } });
    if (!row) {
      return null;
    }
    return (await this.enrichSummaries([row]))[0] ?? null;
  }

  /** P1 未读角标批：已读游标单调推进（session/read 端点）。归属校验 +
   *  message 属会话校验同报 SESSION_NOT_FOUND（不泄露存在性）；updateMany
   *  条件写（cursor 为 NULL 或小于目标 id 才推进）天然并发安全；生效游标
   *  取 max(库值, 请求 id)——回退请求幂等成功不回退；未读按生效游标现算 */
  async markSessionRead(
    sessionId: number,
    messageId: number,
    userId: number,
  ): Promise<SessionReadResult> {
    const session = await prisma.session.findFirst({
      where: { id: sessionId, userId },
    });
    if (!session) {
      throw new Error("SESSION_NOT_FOUND");
    }
    const message = await prisma.message.findFirst({
      where: { id: messageId, sessionId },
    });
    if (!message) {
      throw new Error("SESSION_NOT_FOUND");
    }
    await prisma.session.updateMany({
      where: {
        id: sessionId,
        userId,
        OR: [
          { lastReadMessageId: null },
          { lastReadMessageId: { lt: messageId } },
        ],
      },
      data: { lastReadMessageId: messageId },
    });
    const cursor = Math.max(session.lastReadMessageId ?? 0, messageId);
    return {
      sessionId,
      lastReadMessageId: cursor,
      unreadCount: await this.countUnreadAfter(sessionId, cursor),
    };
  }

  /** 各会话末条 message（groupBy _max id → 一次 findMany 批量取行 →
   *  逐行 summarizeLastMessage 纯函数出 wire 摘要） */
  private async fetchLastMessages(
    sessionIds: number[],
  ): Promise<Map<number, SessionLastMessage>> {
    const grouped = await prisma.message.groupBy({
      by: ["sessionId"],
      where: { sessionId: { in: sessionIds } },
      _max: { id: true },
    });
    const lastIds = grouped
      .map((g) => g._max.id)
      .filter((id): id is number => id != null);
    if (lastIds.length === 0) {
      return new Map();
    }
    const rows = await prisma.message.findMany({
      where: { id: { in: lastIds } },
    });
    return new Map(
      rows.map((row) => [
        row.sessionId,
        summarizeLastMessage({
          id: row.id,
          role: row.role,
          blocks: row.blocks,
          createdAt: row.createdAt,
        }),
      ]),
    );
  }

  /** 批量未读计数（单条 groupBy 按会话分组；OR 逐会话一分支——NULL 游标
   *   bare {sessionId} 计全量，有游标 {sessionId, id>cursor}；sessionId 在
   *   分支内唯一，分组计数精确无交叉） */
  private async countUnreadBySessions(
    rows: Array<{ id: number; lastReadMessageId: number | null }>,
  ): Promise<Map<number, number>> {
    const or = rows.flatMap((row) =>
      row.lastReadMessageId == null
        ? [{ sessionId: row.id }]
        : [{ sessionId: row.id, id: { gt: row.lastReadMessageId } }],
    );
    if (or.length === 0) {
      return new Map();
    }
    const grouped = await prisma.message.groupBy({
      by: ["sessionId"],
      where: { role: "assistant", OR: or },
      _count: { _all: true },
    });
    return new Map(grouped.map((g) => [g.sessionId, g._count._all] as const));
  }

  /** 单会话 cursor 后未读数（read 响应现算；cursor 0 时全计） */
  private async countUnreadAfter(
    sessionId: number,
    cursor: number,
  ): Promise<number> {
    return prisma.message.count({
      where: {
        sessionId,
        role: "assistant",
        ...(cursor !== 0 ? { id: { gt: cursor } } : {}),
      },
    });
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

  /** DetailPanel 工作空间 tab：列目录（resolveSafePath 沙箱） */
  async listWorkspaceDirById(
    workspaceId: number,
    relPath: string,
    userId: number,
  ): Promise<DirEntry[]> {
    await this.assertWorkspaceOwned(workspaceId, userId);
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace?.directoryPath) throw new Error("工作空间未绑定目录");
    return listWorkspaceDir(workspace.directoryPath, relPath ?? "");
  }

  /** 查看变更 tab：工作树变更（非 git 目录返回 not-git，前端空态） */
  async gitStatusById(workspaceId: number, userId: number) {
    await this.assertWorkspaceOwned(workspaceId, userId);
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace?.directoryPath) throw new Error("工作空间未绑定目录");
    return gitWorkingChanges(workspace.directoryPath);
  }

  async gitDiffById(workspaceId: number, relPath: string, userId: number) {
    await this.assertWorkspaceOwned(workspaceId, userId);
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace?.directoryPath) throw new Error("工作空间未绑定目录");
    return gitFileDiff(workspace.directoryPath, relPath);
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
   * 本地产物列表（资料库「本地产物」视图）：查 artifact 表（H7a 结构化
   * 登记），已删除/非文件条目并行 stat 剔除（用户裁定：不进列表）；
   * 历史消息首查回填一次（per-user 标记，此后永不再 LIKE 扫）
   */
  async listArtifacts(userId: number): Promise<ArtifactListItem[]> {
    await this.backfillArtifactsIfNeeded(userId);
    const [rows, workspaces, favorites] = await Promise.all([
      prisma.artifact.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
      }),
      prisma.workspace.findMany({
        where: { userId },
        select: { id: true, name: true, directoryPath: true },
      }),
      prisma.artifactFavorite.findMany({
        where: { userId },
        select: { workspaceId: true, relPath: true },
      }),
    ]);
    const wsById = new Map(
      workspaces.map((w) => [
        w.id,
        { name: w.name, directoryPath: w.directoryPath },
      ]),
    );
    const sessionIds = [...new Set(rows.map((row) => row.sessionId))];
    const sessionTitles = new Map(
      sessionIds.length > 0
        ? (
            await prisma.session.findMany({
              where: { id: { in: sessionIds } },
              select: { id: true, title: true },
            })
          ).map((s) => [s.id, s.title] as const)
        : [],
    );
    const favSet = new Set(
      favorites.map((f) => `${f.workspaceId}:${f.relPath}`),
    );
    const aggregated: AggregatedArtifact[] = [];
    for (const row of rows) {
      const ws = wsById.get(row.workspaceId);
      if (!ws) continue; // 空间已删：无 resolve 基也无归属，跳过
      const isAbsolute = path.isAbsolute(row.relPath);
      if (!isAbsolute && !ws.directoryPath) continue;
      aggregated.push({
        path: isAbsolute
          ? row.relPath
          : resolveFilePath(ws.directoryPath!, row.relPath),
        relPath: row.relPath,
        name: path.basename(row.relPath),
        workspaceId: row.workspaceId,
        workspaceName: ws.name,
        sessionId: row.sessionId,
        sessionTitle: sessionTitles.get(row.sessionId) ?? "",
        writtenAt: row.createdAt.toISOString(),
      });
    }
    return this.filterExistingArtifacts(aggregated, favSet);
  }

  /** 历史消息回填（旧 LIKE 路径跑一次）：per-user 标记后永不再扫 */
  private async backfillArtifactsIfNeeded(userId: number): Promise<void> {
    const flagKey = `artifact.backfilled.${userId}`;
    const map = await getAppOptionMap(prisma.option, [flagKey]);
    if (map.get(flagKey) === "1") {
      return;
    }
    const sessions = await prisma.session.findMany({
      where: { userId },
      select: { id: true, workspaceId: true, title: true },
    });
    if (sessions.length > 0) {
      const messages = await this.findArtifactMessages(sessions);
      const aggregated = aggregateArtifacts(
        messages,
        await this.findArtifactWorkspaces(sessions),
        new Map(sessions.map((s) => [s.id, s.title])),
      );
      for (const item of aggregated) {
        await prisma.artifact.upsert({
          where: {
            userId_workspaceId_relPath: {
              userId,
              workspaceId: item.workspaceId,
              relPath: item.relPath,
            },
          },
          create: {
            userId,
            workspaceId: item.workspaceId,
            sessionId: item.sessionId,
            relPath: item.relPath,
            createdAt: new Date(item.writtenAt),
          },
          update: {},
        });
      }
    }
    await setAppOption(prisma.option, flagKey, "1");
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

  /** 含 write 工具调用的消息（LIKE 粗筛，精确过滤在聚合纯函数），补所属工作空间 id */
  private async findArtifactMessages(
    sessions: Array<{ id: number; workspaceId: number }>,
  ): Promise<ArtifactMessageRow[]> {
    const wsOfSession = new Map(sessions.map((s) => [s.id, s.workspaceId]));
    const rows = await prisma.message.findMany({
      where: {
        sessionId: { in: sessions.map((s) => s.id) },
        // 前缀模式同时命中新老两代（2026-10-29 改名前 write_file / 改名后
        // write；blocks 为 JSON.stringify 无空格产物，精确判定在
        // artifact-aggregate 的 canonical 归一比较）
        blocks: { contains: '"toolName":"write' },
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

  /** stat 校验存在且为普通文件（并行），附文件大小/扩展名分类/收藏态；失败剔除不抛 */
  private async filterExistingArtifacts(
    aggregated: ReturnType<typeof aggregateArtifacts>,
    favorites: ReadonlySet<string>,
  ): Promise<ArtifactListItem[]> {
    // H7a：串行 stat 在产物上百时是上百次往返，改并行（各自吞错剔除）
    const checked = await Promise.all(
      aggregated.map(async (item) => {
        try {
          const stat = await fs.stat(item.path);
          if (!stat.isFile()) {
            return null;
          }
          return {
            ...item,
            fileType: classifyFileType(item.name),
            size: stat.size,
            favorite: favorites.has(`${item.workspaceId}:${item.relPath}`),
          } satisfies ArtifactListItem;
        } catch {
          // 已删除或不可访问——直接剔除（保留会与磁盘现状不符）
          return null;
        }
      }),
    );
    return checked.filter((item): item is ArtifactListItem => item !== null);
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
    // 会话级路径授权随删回收（T28 spec §16 项 1）：删除成功后尽力回收
    // （主进程内直连，不加通道；revoke 内部自吞错不影响删除结果）
    await revokeSession(id, userId);
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

  /** 消息分页页（H6）：nextBeforeId 为下一页游标（取更旧消息） */
  async listMessages(
    sessionId: number,
    userId: number,
    opts?: { beforeId?: number; limit?: number },
  ): Promise<{
    items: MessageRecord[];
    hasMore: boolean;
    nextBeforeId: number | null;
  }> {
    await this.assertSessionOwned(sessionId, userId);
    // H6 游标分页：id 倒序取 limit+1 判 hasMore，翻转回时间正序——旧全量
    // 读回在长会话（数百条 × 数十 KB blocks）下是几十 MB 级 IPC 克隆
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
    const rows = await prisma.message.findMany({
      where: {
        sessionId,
        ...(opts?.beforeId !== undefined ? { id: { lt: opts.beforeId } } : {}),
      },
      orderBy: { id: "desc" },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows)
      .reverse()
      .map((row) => this.toMessage(row));
    return {
      items,
      hasMore,
      nextBeforeId: hasMore ? (items[0]?.id ?? null) : null,
    };
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

  /** 解析生效模型：会话当前 > 工作空间默认（spec §4.2）> 首个启用 llm
   * 模型兜底（P1：远控空建会话 + fresh 库双空首用不再 NO_MODEL，与
   * tianshu-server chat-runner 同款三级链） */
  async getEffectiveModelId(sessionId: number): Promise<number | null> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return null;
    }
    if (session.currentModelId) {
      return session.currentModelId;
    }
    const workspace = await this.getWorkspace(session.workspaceId);
    if (workspace?.defaultModelId) {
      return workspace.defaultModelId;
    }
    return this.firstEnabledLlmModelId(session.userId);
  }

  /** 双空兜底：首个启用 llm 模型（type="llm" 且 model.enabled，随
   * provider.enabled）；model 与 provider 无 Prisma relation，启用集先取
   * provider id 再筛模型（polishText 同款两步查）；再无返回 null（上层
   * 维持 NO_MODEL，文案已含配置指引） */
  private async firstEnabledLlmModelId(
    userId: number | null,
  ): Promise<number | null> {
    const enabledProviderIds = (
      await prisma.provider.findMany({
        where: { enabled: true, userId },
        select: { id: true },
      })
    ).map((row) => row.id);
    if (enabledProviderIds.length === 0) {
      return null;
    }
    const model = await prisma.model.findFirst({
      where: {
        type: "llm",
        enabled: true,
        providerId: { in: enabledProviderIds },
      },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    return model?.id ?? null;
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
    // H7a：write 产物登记（fire-and-forget，不阻塞消息链路）——
    // 产物面板查表替代 blocks LIKE 全表扫；失败仅记日志
    void this.recordArtifacts(message).catch((e) =>
      Log.warn("产物登记失败", e instanceof Error ? e.message : e),
    );
    return message;
  }

  /** 消息落库时提取 write 路径登记产物表（唯一键 upsert，重写刷新时间） */
  private async recordArtifacts(message: MessageRow): Promise<void> {
    const relPaths = extractPaths(message);
    if (relPaths.length === 0) {
      return;
    }
    const session = await prisma.session.findFirst({
      where: { id: message.sessionId },
      select: { workspaceId: true, userId: true },
    });
    if (!session?.userId) {
      return;
    }
    for (const relPath of relPaths) {
      await prisma.artifact.upsert({
        where: {
          userId_workspaceId_relPath: {
            userId: session.userId,
            workspaceId: session.workspaceId,
            relPath,
          },
        },
        create: {
          userId: session.userId,
          workspaceId: session.workspaceId,
          sessionId: message.sessionId,
          relPath,
        },
        update: { sessionId: message.sessionId, createdAt: new Date() },
      });
    }
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
