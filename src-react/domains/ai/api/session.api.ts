/**
 * 会话与消息 API
 */

import { invoke } from "@/lib/ipc";

/** 会话模式（P3）：agent 默认 / ask 仅问答 / plan 计划 */
export type SessionMode = "agent" | "ask" | "plan";

export interface SessionRecord {
  id: number;
  workspaceId: number;
  assistantId?: number;
  currentModelId?: number;
  title: string;
  mode: SessionMode;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
  pinnedAt?: string;
  archivedAt?: string;
}

export interface SessionCreateParams {
  workspaceId: number;
  assistantId?: number;
}

export interface MessageRecord {
  id: number;
  sessionId: number;
  role: "user" | "assistant" | "system";
  blocks: string;
  modelId?: number;
  assistantId?: number;
  error?: string;
  createdAt: string;
}

/** 搜索结果：消息附带所属会话信息（message:search 由后端 repo 使用，前端入口已移除） */
export interface SearchMessageResult extends MessageRecord {
  workspaceId: number;
  sessionTitle: string;
}

export class SessionApi {
  static async create(params: SessionCreateParams): Promise<SessionRecord> {
    return invoke<SessionRecord>("session:create", params);
  }

  static async rename(id: number, title: string): Promise<void> {
    return invoke<void>("session:rename", id, title);
  }

  static async delete(id: number): Promise<void> {
    return invoke<void>("session:delete", id);
  }

  /** v5：全部未归档任务（标准侧边栏分组树） */
  static async listAll(): Promise<SessionRecord[]> {
    return invoke<SessionRecord[]>("session:listAll");
  }

  static async pin(id: number, pinned: boolean): Promise<void> {
    return invoke<void>("session:pin", id, pinned);
  }

  static async archive(id: number, archived: boolean): Promise<void> {
    return invoke<void>("session:archive", id, archived);
  }

  /** 空关键词返回最近 20 条（最近任务模式） */
  static async searchByTitle(keyword: string): Promise<SessionRecord[]> {
    return invoke<SessionRecord[]>("session:searchByTitle", keyword);
  }

  static async setModel(id: number, modelId: number | null): Promise<void> {
    return invoke<void>("session:setModel", id, modelId);
  }

  static async setAssistant(
    id: number,
    assistantId: number | null,
  ): Promise<void> {
    return invoke<void>("session:setAssistant", id, assistantId);
  }

  /** 切换会话模式（P3）：agent 时主进程落 null，保持 DB 干净 */
  static async setMode(id: number, mode: SessionMode): Promise<void> {
    return invoke<void>("session:setMode", id, mode);
  }

  static async listMessages(sessionId: number): Promise<MessageRecord[]> {
    return invoke<MessageRecord[]>("message:listBySession", sessionId);
  }
}

export default SessionApi;
