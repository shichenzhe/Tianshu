/**
 * 会话与消息 API
 */

import { invoke } from "@/lib/ipc";

export interface SessionRecord {
  id: number;
  workspaceId: number;
  assistantId?: number;
  currentModelId?: number;
  title: string;
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

  static async listMessages(sessionId: number): Promise<MessageRecord[]> {
    return invoke<MessageRecord[]>("message:listBySession", sessionId);
  }

  static async searchMessages(keyword: string): Promise<SearchMessageResult[]> {
    return invoke<SearchMessageResult[]>("message:search", keyword);
  }
}

export default SessionApi;
