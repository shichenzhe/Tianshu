// chat 流进程级 tap 点（server-face spec T10）：ChatService.emit 的旁路
// 出口，无论渲染层 sender 在场与否都广播 (sessionId, chunk)——被控面
//（T11 路由 / T12 SSE·relay）经 onChatChunk 订阅无头消费，渲染层零改动。
// T10 复审兜底（deferred 必做）：emitChatChunk 逐订阅者手动扇出 + try/catch
// ——EventEmitter.emit 会同步传播订阅者异常炸掉 chat 流（持久化/终止 chunk
// 一并中断），订阅者故障只殃及自身；setMaxListeners(0) 撤销多路复用告警
//（SSE 每连接一个订阅者，连接数不受控）。
import { EventEmitter } from "node:events";
import Log from "../../commons/Log";
import type { ChatStreamChunk } from "../../../src-react/domains/ai/api/chat.api";

type ChunkListener = (sessionId: number, chunk: ChatStreamChunk) => void;

const tap = new EventEmitter();
tap.setMaxListeners(0);

/** chunk 广播（chat.service emit 首行调用，先于 sender 判空） */
export function emitChatChunk(sessionId: number, chunk: ChatStreamChunk): void {
  for (const listener of tap.listeners("chunk") as ChunkListener[]) {
    try {
      listener(sessionId, chunk);
    } catch (e) {
      Log.warn("chat tap 订阅者抛错（已隔离，流继续）", e);
    }
  }
}

/** 进程级单例订阅；返回退订函数 */
export function onChatChunk(
  fn: (sessionId: number, chunk: ChatStreamChunk) => void,
): () => void {
  tap.on("chunk", fn);
  return () => {
    tap.off("chunk", fn);
  };
}
