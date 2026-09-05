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

/** 搜索结果：消息附带所属会话信息（跳转定位用） */
export interface SearchMessageResult extends MessageRecord {
  workspaceId: number;
  sessionTitle: string;
}

export class SessionApi {
  static async listByWorkspace(workspaceId: number): Promise<SessionRecord[]> {
    return invoke<SessionRecord[]>("session:listByWorkspace", workspaceId);
  }

  static async create(params: SessionCreateParams): Promise<SessionRecord> {
    return invoke<SessionRecord>("session:create", params);
  }

  static async rename(id: number, title: string): Promise<void> {
    return invoke<void>("session:rename", id, title);
  }

  static async delete(id: number): Promise<void> {
    return invoke<void>("session:delete", id);
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

  static async searchMessages(keyword: string): Promise<SearchMessageResult[]> {
    return invoke<SearchMessageResult[]>("message:search", keyword);
  }
}

export default SessionApi;
