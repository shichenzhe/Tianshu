import { ipcMain } from "electron";
import prisma from "../../../commons/prisma-client";
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
type SessionRow = NonNullable<
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
}

export class SessionRepository {
  constructor() {
    this.registerIpcHandlers();
    void this.ensureDefaultWorkspace();
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
      createdAt: row.createdAt.toISOString(),
    };
  }

  private registerIpcHandlers() {
    ipcMain.handle("workspace:list", () => this.listWorkspaces());
    ipcMain.handle("workspace:create", (_, p: WorkspaceCreateParams) =>
      this.createWorkspace(p),
    );
    ipcMain.handle("workspace:update", (_, p: WorkspaceUpdateParams) =>
      this.updateWorkspace(p),
    );
    ipcMain.handle("workspace:delete", (_, id: number) =>
      this.deleteWorkspace(id),
    );
    ipcMain.handle("session:listByWorkspace", (_, workspaceId: number) =>
      this.listSessions(workspaceId),
    );
    ipcMain.handle("session:create", (_, p: SessionCreateParams) =>
      this.createSession(p),
    );
    ipcMain.handle("session:rename", (_, id: number, title: string) =>
      this.renameSession(id, title),
    );
    ipcMain.handle("session:delete", (_, id: number) => this.deleteSession(id));
    ipcMain.handle(
      "session:setModel",
      (_, id: number, modelId: number | null) =>
        this.setSessionModel(id, modelId),
    );
    ipcMain.handle(
      "session:setAssistant",
      (_, id: number, assistantId: number | null) =>
        this.setSessionAssistant(id, assistantId),
    );
    ipcMain.handle("session:setMode", (_, id: number, mode: SessionMode) =>
      this.setSessionMode(id, mode),
    );
    ipcMain.handle("message:listBySession", (_, sessionId: number) =>
      this.listMessages(sessionId),
    );
    ipcMain.handle("message:search", (_, keyword: string) =>
      this.searchMessages(keyword),
    );
  }

  /** 空库时建默认工作空间（首启体验） */
  private async ensureDefaultWorkspace(): Promise<void> {
    const count = await prisma.workspace.count();
    if (count === 0) {
      await prisma.workspace.create({ data: { name: "默认工作空间" } });
    }
  }

  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    return (
      await prisma.workspace.findMany({ orderBy: { createdAt: "asc" } })
    ).map((row) => this.toWorkspace(row));
  }

  async getWorkspace(id: number): Promise<WorkspaceRow | null> {
    return prisma.workspace.findUnique({ where: { id } });
  }

  async createWorkspace(p: WorkspaceCreateParams): Promise<WorkspaceRecord> {
    const row = await prisma.workspace.create({
      data: { name: p.name, icon: p.icon, defaultModelId: p.defaultModelId },
    });
    return this.toWorkspace(row);
  }

  async updateWorkspace(p: WorkspaceUpdateParams): Promise<WorkspaceRecord> {
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
  ): Promise<WorkspaceRecord> {
    const row = await prisma.workspace.update({
      where: { id },
      data: { directoryPath },
    });
    return this.toWorkspace(row);
  }

  async deleteWorkspace(id: number): Promise<void> {
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

  async listSessions(workspaceId: number): Promise<SessionRecord[]> {
    return (
      await prisma.session.findMany({
        where: { workspaceId },
        orderBy: { lastMessageAt: "desc" },
      })
    ).map((row) => this.toSession(row));
  }

  async getSession(id: number): Promise<SessionRow | null> {
    return prisma.session.findUnique({ where: { id } });
  }

  async createSession(p: SessionCreateParams): Promise<SessionRecord> {
    // 新会话继承同工作空间最近一次选择的模型（用户反馈：默认丢失上次选择）
    const latest = await prisma.session.findFirst({
      where: { workspaceId: p.workspaceId, currentModelId: { not: null } },
      orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
      select: { currentModelId: true },
    });
    const row = await prisma.session.create({
      data: {
        workspaceId: p.workspaceId,
        assistantId: p.assistantId,
        currentModelId: latest?.currentModelId ?? undefined,
        title: "新会话",
      },
    });
    return this.toSession(row);
  }

  async renameSession(id: number, title: string): Promise<void> {
    await prisma.session.update({ where: { id }, data: { title } });
  }

  async deleteSession(id: number): Promise<void> {
    await prisma.message.deleteMany({ where: { sessionId: id } });
    await prisma.session.delete({ where: { id } });
  }

  async setSessionModel(id: number, modelId: number | null): Promise<void> {
    await prisma.session.update({
      where: { id },
      data: { currentModelId: modelId },
    });
  }

  async setSessionAssistant(
    id: number,
    assistantId: number | null,
  ): Promise<void> {
    await prisma.session.update({
      where: { id },
      data: { assistantId },
    });
  }

  /** P3 会话模式："agent" 写 null（缺省不落盘，保持 DB 干净） */
  async setSessionMode(id: number, mode: SessionMode): Promise<void> {
    await prisma.session.update({
      where: { id },
      data: { mode: mode === "agent" ? null : mode },
    });
  }

  async listMessages(sessionId: number): Promise<MessageRecord[]> {
    return (
      await prisma.message.findMany({
        where: { sessionId },
        orderBy: { createdAt: "asc" },
      })
    ).map((row) => this.toMessage(row));
  }

  /** P0 历史搜索：LIKE 查询（spec §4.2），附带所属会话信息供搜索结果跳转 */
  async searchMessages(keyword: string): Promise<SearchMessageResult[]> {
    const rows = (
      await prisma.message.findMany({
        where: { blocks: { contains: keyword } },
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
      },
    });
    await prisma.session.update({
      where: { id: p.sessionId },
      data: { lastMessageAt: new Date(), updatedAt: new Date() },
    });
    return message;
  }

  /** chat.service 专用：首条用户消息生成标题 */
  async autotitleIfDefault(sessionId: number, content: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (session && session.title === "新会话") {
      await this.renameSession(sessionId, content.slice(0, 20));
    }
  }
}
