import type { SessionLastMessage, SessionReadResult } from "@tianshu/protocol";
/**
 * 会话与消息 API
 */

import { routeInvoke } from "@/domains/ai/data-source/host-route";
import * as remote from "@/domains/ai/data-source/remote-session";
import ServerApi from "@/domains/ai/server/api/server.api";

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
  /** /compact 摘要(v8):存在即压缩态;compactedUpToId 为压缩覆盖点消息 id */
  summary?: string | null;
  compactedUpToId?: number | null;
  /** 发起场景 daily|coding|design；缺省落 null */
  scenario?: string | null;
  /** 会话归属项目；null = 普通会话（一期统一：项目/任务会话进会话域） */
  projectId?: number | null;
  /** 任务会话关联事项 id；null = 非任务会话（D1：一任务一会话由 create 查重保证） */
  planItemId?: number | null;
  /** P1 未读角标批：未读数（远端会话经被控面动态算；本地会话缺省不显示角标） */
  unreadCount?: number;
  /** P1 未读角标批：末条消息摘要（远端会话透出；本地会话缺省） */
  lastMessage?: SessionLastMessage | null;
}

export interface SessionCreateParams {
  /** 目标工作空间；projectId 非空时可缺省（后端解析项目资产空间） */
  workspaceId?: number;
  assistantId?: number;
  /** 发起场景 daily|coding|design；缺省不落库 */
  scenario?: string;
  /** 会话归属项目；非空时后端强制挂项目资产空间（防传错） */
  projectId?: number;
  /** 任务会话关联事项 id；非空时后端查重复用既有会话（一任务一会话） */
  planItemId?: number;
  /** 会话标题；缺省落「新会话」（任务会话由推进入口传任务标题） */
  title?: string;
}

export interface MessageRecord {
  id: number;
  sessionId: number;
  role: "user" | "assistant" | "system";
  blocks: string;
  modelId?: number;
  assistantId?: number;
  error?: string;
  /** 生成耗时毫秒(assistant 轮,v9) */
  durationMs?: number;
  createdAt: string;
}

/** 搜索结果：消息附带所属会话信息（message:search 由后端 repo 使用，前端入口已移除） */
export interface SearchMessageResult extends MessageRecord {
  workspaceId: number;
  sessionTitle: string;
}

export class SessionApi {
  static async create(params: SessionCreateParams): Promise<SessionRecord> {
    return routeInvoke({ ch: "session:create", args: [params] }, (connId) =>
      remote.remoteCreate(params, connId),
    );
  }

  static async rename(id: number, title: string): Promise<void> {
    return routeInvoke({ ch: "session:rename", args: [id, title] }, (connId) =>
      remote.remoteUpdate(id, { title }, connId),
    );
  }

  static async delete(id: number): Promise<void> {
    return routeInvoke({ ch: "session:delete", args: [id] }, (connId) =>
      ServerApi.sessionDelete(id, connId),
    );
  }

  /** v5：全部未归档任务（标准侧边栏分组树） */
  static async listAll(): Promise<SessionRecord[]> {
    return routeInvoke({ ch: "session:listAll", args: [] }, (connId) =>
      remote.remoteListAll(connId),
    );
  }

  static async pin(id: number, pinned: boolean): Promise<void> {
    return routeInvoke({ ch: "session:pin", args: [id, pinned] }, (connId) =>
      remote.remoteUpdate(id, { pinned }, connId),
    );
  }

  static async archive(id: number, archived: boolean): Promise<void> {
    return routeInvoke(
      { ch: "session:archive", args: [id, archived] },
      (connId) => remote.remoteUpdate(id, { archived }, connId),
    );
  }

  /** 空关键词返回最近 20 条（最近任务模式） */
  static async searchByTitle(keyword: string): Promise<SessionRecord[]> {
    // 远程：全量拉取后本地 includes（face 面同口径）
    return routeInvoke(
      { ch: "session:searchByTitle", args: [keyword] },
      async (connId) => {
        const all = await remote.remoteListAll(connId);
        const kw = keyword.trim();
        return kw ? all.filter((r) => r.title.includes(kw)) : all;
      },
    );
  }

  /** 按 id 精确拉取单会话（文件窗 AI 面板 ChatPane 数据源，T22）；
   *  归属校验主进程侧（他人/已删同报 SESSION_NOT_FOUND） */
  static async getById(id: number): Promise<SessionRecord> {
    return routeInvoke({ ch: "session:getById", args: [{ id }] }, (connId) =>
      remote.remoteGetById(id, connId),
    );
  }

  static async setModel(id: number, modelId: number | null): Promise<void> {
    return routeInvoke(
      { ch: "session:setModel", args: [id, modelId] },
      (connId) => remote.remoteUpdate(id, { currentModelId: modelId }, connId),
    );
  }

  static async setAssistant(
    id: number,
    assistantId: number | null,
  ): Promise<void> {
    return routeInvoke(
      { ch: "session:setAssistant", args: [id, assistantId] },
      (connId) => remote.remoteUpdate(id, { assistantId }, connId),
    );
  }

  /** 切换会话模式（P3）：agent 时主进程落 null，保持 DB 干净 */
  static async setMode(id: number, mode: SessionMode): Promise<void> {
    return routeInvoke({ ch: "session:setMode", args: [id, mode] }, (connId) =>
      remote.remoteUpdate(id, { mode }, connId),
    );
  }

  /** H6 消息分页页：nextBeforeId 为下一页游标（取更旧消息） */
  static async listMessages(
    sessionId: number,
    beforeId?: number,
  ): Promise<MessagePage> {
    // 远程主机：详情接口已拼全量（beforeId 翻页分支自然收口——首页语义）
    return routeInvoke<MessagePage>(
      {
        ch: "message:listBySession",
        args: [sessionId, beforeId !== undefined ? { beforeId } : undefined],
      },
      (connId) => remote.remoteListMessages(sessionId, connId),
    );
  }

  /** P1 尾未读角标：已读游标推进（本地 session:markRead / 远程 session/read
   *  透传；ChatPane 消息就绪/轮次定稿后上报 maxMessageId——单调游标天然
   *  防回退，发送方自身 assistant 消息同推） */
  static async markRead(
    sessionId: number,
    messageId: number,
  ): Promise<SessionReadResult> {
    return routeInvoke(
      { ch: "session:markRead", args: [sessionId, messageId] },
      (connId) => remote.remoteMarkRead(sessionId, messageId, connId),
    );
  }
}

/** H6 消息分页页形状（["messages"] infinite 缓存的页类型） */
export interface MessagePage {
  items: MessageRecord[];
  hasMore: boolean;
  nextBeforeId: number | null;
}

export default SessionApi;
