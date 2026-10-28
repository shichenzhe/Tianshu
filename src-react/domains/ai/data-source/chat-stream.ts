/**
 * 聊天流事件路由（HD 批，spec §2.3）：本地 chat:stream:<sessionId> 与
 * 远程 server:chunk:<connId>:<sessionId> 的统一订阅面（api 内路由）。
 */
import { on } from "@/lib/ipc";
import { routeSubscribe } from "./host-route";
import type { ChatStreamChunk } from "@tianshu/protocol";

/**
 * 订阅会话流式 chunk（ChatApi.on 内部用）——本地主机走 chat:stream 动态
 * 通道；远程主机走 server:chunk 通道（载荷同为 ChatStreamChunk）。
 * on 回调为 Electron 签名 (event, chunk)——两分支统一跳过 event 取 chunk。
 */
export function onChatStream(
  sessionId: number,
  cb: (chunk: ChatStreamChunk) => void,
): () => void {
  const wrapped = (payload: unknown) => cb(payload as ChatStreamChunk);
  return routeSubscribe(
    (listener) =>
      on(
        `chat:stream:${sessionId}` as never,
        ((_event: unknown, chunk: unknown) => listener(chunk)) as never,
      ),
    (connId, listener) =>
      on(
        `server:chunk:${connId}:${sessionId}` as never,
        ((_event: unknown, chunk: unknown) => listener(chunk)) as never,
      ),
  )(wrapped);
}
