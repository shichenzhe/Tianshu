/**
 * 空会话回收（T26，spec §15 项 2，WorkBuddy discardEmptyConversation
 * 同款）：关闭 tab / 整窗关闭时，本窗惰建且尚无消息的会话直接删除——
 * 不留「空壳会话」污染主窗会话列表。两挂点（store.closeTab 与
 * FileWindowView 整窗关闭扫描）共用本谓词；流式中（消息可能正落库）
 * 与任意失败均静默跳过——回收尽力而为，不影响关闭流。
 */
import { useChatStore } from "@/domains/ai/chat/store/chat.store";
import { invoke } from "@/lib/ipc";

/**
 * 判空回收：会话无消息（首页 items 空）→ session:delete。
 * 返回是否实际删除；流式中/有消息/查询或删除失败一律 false（静默）。
 */
export async function recycleIfEmpty(sessionId: number): Promise<boolean> {
  // 流式中（含主窗发起）不删——首条消息可能正在落库
  if (useChatStore.getState().isStreaming[sessionId]) return false;
  try {
    const page = await invoke<{ items: unknown[] }>(
      "message:listBySession",
      sessionId,
    );
    if ((page?.items?.length ?? 0) > 0) return false;
    await invoke("session:delete", sessionId);
    return true;
  } catch {
    // 会话已被删（主窗先手）/查询失败：静默跳过
    return false;
  }
}
