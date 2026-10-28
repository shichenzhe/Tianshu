// 被控面事件总线（spec §3.2）：face 侧协议事件的进程内扇出源。三个生产者
// ——tap 桥（message.chunk）、send 桥收尾（session.updated / session.error）
// ——两类消费者：SSE 出口（server-face.ts /event）与 relay 客户端
// （relay-client.ts event 帧）。逐订阅者 try/catch 扇出（T2 F1/T10 兜底
// 同款理由：订阅者异常不得打断生产者 send 链路）。
// FaceEvent 类型已收编 @tianshu/protocol（RC-T1，原与 protocol.ts /
// tianshu-server server-event.ts 三处同构双写），本文件 re-export 兼容。
import Log from "../../commons/Log";
import type { FaceEvent } from "@tianshu/protocol";
import { onChatChunk } from "./chat-tap";
import { onAutomationChanged } from "../ai/automation/automation-change-bus";

export type { FaceEvent };

type FaceListener = (event: FaceEvent) => void;

const listeners = new Set<FaceListener>();

export function onFaceEvent(fn: FaceListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function publishFaceEvent(event: FaceEvent): void {
  for (const fn of [...listeners]) {
    try {
      fn(event);
    } catch (e) {
      Log.warn("face 事件订阅者抛错（已隔离）", e);
    }
  }
}

// —— tap 桥：onChatChunk → message.chunk。协议即天枢 onChunk 原样透传，
// 全部 chunk 类型（text/reasoning/tool-update/approval-request/finish/
// title-updated/error）不过滤——title-updated 等控制型 chunk 由控制端
// 自行识别消费（T12 裁定，报告已注记）——
let tapBridged = false;

/** 幂等启动 tap 桥（ensureServerFace 与 startRelayClient 各自调用；
 * 订阅与 tap 同为进程级单例，重复调用零副作用） */
export function ensureTapBridge(): void {
  if (tapBridged) return;
  tapBridged = true;
  onChatChunk((sessionId, chunk) =>
    publishFaceEvent({ type: "message.chunk", payload: { sessionId, chunk } }),
  );
  // CRUD 批：桌面本地任务变更（repo runNow 收口/scheduler/event-bus/face
  // save/delete）→ automation.changed 远程控制端重拉（taskId 0 = 列表级
  // 刷新信号，无头端 payload 语义同源）
  onAutomationChanged((payload) =>
    publishFaceEvent({ type: "automation.changed", payload }),
  );
}
