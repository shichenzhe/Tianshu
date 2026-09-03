import { ipcMain } from "electron";
import prisma from "../../../commons/prisma-client";
import type {
  MessageRecord,
  SessionCreateParams,
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
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toSession(row: SessionRow): SessionRecord {
    return {
      ...row,
      assistantId: row.assistantId ?? undefined,
      currentModelId: row.currentModelId ?? undefined,
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
    const row = await prisma.session.create({
      data: {
        workspaceId: p.workspaceId,
        assistantId: p.assistantId,
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

  async listMessages(sessionId: number): Promise<MessageRecord[]> {
    return (
      await prisma.message.findMany({
        where: { sessionId },
        orderBy: { createdAt: "asc" },
      })
    ).map((row) => this.toMessage(row));
  }

  /** P0 历史搜索：LIKE 查询（spec §4.2） */
  async searchMessages(keyword: string): Promise<MessageRecord[]> {
    return (
      await prisma.message.findMany({
        where: { blocks: { contains: keyword } },
        orderBy: { createdAt: "desc" },
        take: 100,
      })
    ).map((row) => this.toMessage(row));
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
