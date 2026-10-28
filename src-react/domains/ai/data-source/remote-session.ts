/**
 * session/message 域远程适配器（HD-T2，spec §2.3）：远程主机 server:*
 * 通道 → 本地 SessionApi 类型形状转换。UI 消费零变化。
 * 不映射字段（scenario/projectId/planItemId）缺省 undefined——本地 UI 对
 * undefined 走既有缺省分支（项目徽标等远程不适用面由 caps 门控）。
 * A9 批起 summary/compactedUpToId 原样透传（被控端两字段全量透出——
 * 会话页压缩提示条/摘要轮数据源；旧被控端行缺省 undefined）。
 * P1 未读角标批：unreadCount/lastMessage 远端行透出时原样透传（本地 UI
 * 角标渲染消费；桌面端自身不做角标展示，spec §1.7——纯管道零行为变化）。
 */
import type { SessionRecord, SessionCreateParams } from "../api/session.api";
import type { SessionMode } from "../api/session.api";
import type { SessionReadResult } from "@tianshu/protocol";
import ServerApi from "../server/api/server.api";
import type { RemoteSessionRow } from "../server/api/server.api";

/** RemoteSessionRow → SessionRecord（mode 三值收窄；时间字符串直传；
 * workspaceId 远端树分组用——列表行缺省时归 default 空间外的未分组） */
function toSessionRecord(row: RemoteSessionRow): SessionRecord {
  const mode: SessionMode =
    row.mode === "ask" || row.mode === "plan" ? row.mode : "agent";
  return {
    id: row.id,
    workspaceId: row.workspaceId ?? 0,
    title: row.title ?? "",
    mode,
    createdAt: "",
    updatedAt: row.updatedAt ?? "",
    ...(row.lastMessageAt != null ? { lastMessageAt: row.lastMessageAt } : {}),
    ...(row.pinnedAt != null ? { pinnedAt: row.pinnedAt } : {}),
    ...(row.archivedAt != null ? { archivedAt: row.archivedAt } : {}),
    ...(row.assistantId != null ? { assistantId: row.assistantId } : {}),
    ...(row.currentModelId != null
      ? { currentModelId: row.currentModelId }
      : {}),
    // P1 未读角标批：远端行有角标数据才透传（旧被控端行缺省 undefined）
    ...(row.unreadCount != null ? { unreadCount: row.unreadCount } : {}),
    ...(row.lastMessage !== undefined ? { lastMessage: row.lastMessage } : {}),
    // A9 批：压缩态两字段原样透传（会话页压缩提示条数据源）
    ...(row.summary !== undefined ? { summary: row.summary } : {}),
    ...(row.compactedUpToId !== undefined
      ? { compactedUpToId: row.compactedUpToId }
      : {}),
  };
}

/** 会话全量（分页拉拼——UI listAll 消费全量语义；500/页） */
export async function remoteListAll(connId: string): Promise<SessionRecord[]> {
  const records: RemoteSessionRow[] = [];
  const pageSize = 500;
  for (let page = 1; page <= 200; page += 1) {
    const result = await ServerApi.sessionList({ page, pageSize }, connId);
    records.push(...result.records);
    if (result.page * result.pageSize >= result.total) break;
  }
  return records.map(toSessionRecord);
}

export async function remoteGetById(
  id: number,
  connId: string,
): Promise<SessionRecord> {
  const detail = await ServerApi.sessionGet(id, connId);
  return toSessionRecord(detail.session);
}

export async function remoteCreate(
  params: SessionCreateParams,
  connId: string,
): Promise<SessionRecord> {
  const row = await ServerApi.sessionCreate(
    {
      ...(params.title !== undefined ? { title: params.title } : {}),
      ...(params.workspaceId !== undefined
        ? { workspaceId: params.workspaceId }
        : {}),
    },
    connId,
  );
  return toSessionRecord(row);
}

/** 复合 update（title/mode/archived/pinned/assistantId/currentModelId） */
export async function remoteUpdate(
  id: number,
  fields: {
    title?: string;
    mode?: SessionMode;
    archived?: boolean;
    pinned?: boolean;
    assistantId?: number | null;
    currentModelId?: number | null;
  },
  connId: string,
): Promise<void> {
  await ServerApi.sessionUpdate(id, fields, connId);
}

/** P1 尾未读角标：远程已读推进（session/read 透传，SessionReadResult 原样返回） */
export async function remoteMarkRead(
  sessionId: number,
  messageId: number,
  connId: string,
): Promise<SessionReadResult> {
  return ServerApi.sessionRead(sessionId, messageId, connId);
}

/** 消息历史（server:getById 的 messages 段全量 → MessagePage 首页语义；
 * hasMore 恒 false——远程详情已拼全量，UI 翻页分支自然收口） */
export async function remoteListMessages(
  sessionId: number,
  connId: string,
): Promise<{
  items: import("../api/session.api").MessageRecord[];
  hasMore: boolean;
  nextBeforeId: number | null;
}> {
  const detail = await ServerApi.sessionGet(sessionId, connId);
  return {
    items: detail.messages.map((m) => ({
      id: m.id,
      sessionId,
      role: m.role as "user" | "assistant" | "system",
      blocks: m.blocks,
      ...(m.modelId != null ? { modelId: m.modelId } : {}),
      ...(m.durationMs != null ? { durationMs: m.durationMs } : {}),
      ...(m.createdAt != null ? { createdAt: m.createdAt } : { createdAt: "" }),
    })),
    hasMore: false,
    nextBeforeId: null,
  };
}
