/**
 * 远程审批队列派生（T17）：RemoteStreamState → 待应答审批项（纯函数，
 * 与移动端 T15 队列语义同源）。入队/去重/出队已在 applyRemoteChunk 收口
 * （approval-request 同 toolCallId 覆写刷新 argSummary；tool-update 离开
 * awaiting-approval 即出队——含 running 本端已应答/他端竞速先到，与
 * done/denied/error 终态同口径收起），本模块只做两件事：
 * - 队列派生：active 流中 awaiting-approval 工具按 toolOrder FIFO 列出；
 *   finish / error / session.error（active=false）→ 清空（流收场后挂起
 *   审批不可再应答）
 * - 本端已应答过滤：onResponded 即时顶下一项，不等 tool-update 往返
 *   （真出队仍由 tool-update 收口，双保险）
 */
import type { RemoteStreamState } from "./remote-stream";

/** 待应答审批项（Banner 渲染载荷） */
export interface ApprovalItem {
  toolCallId: string;
  toolName: string;
  argSummary?: string;
}

/** 队列派生：active 流中 awaiting-approval 工具按到达顺序列出 */
export function pendingApprovals(
  state: RemoteStreamState | null,
): ApprovalItem[] {
  if (!state || !state.active) return [];
  const items: ApprovalItem[] = [];
  for (const toolCallId of state.toolOrder) {
    const tool = state.tools[toolCallId];
    if (tool?.state === "awaiting-approval") {
      items.push({
        toolCallId,
        toolName: tool.toolName,
        argSummary: tool.argSummary,
      });
    }
  }
  return items;
}

/** 本端已应答过滤（respondedIds 挂载方页面级持有，切会话/连接时清空） */
export function unrespondedApprovals(
  pending: ApprovalItem[],
  respondedToolCallIds: ReadonlySet<string>,
): ApprovalItem[] {
  return pending.filter((item) => !respondedToolCallIds.has(item.toolCallId));
}
