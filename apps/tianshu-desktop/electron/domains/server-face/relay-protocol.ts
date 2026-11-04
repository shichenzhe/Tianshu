// relay 隧道帧（spec §3.3）——帧类型已收编 @tianshu/protocol（共享 core
// 重构 RC-T1，与 tianshu-server src/relay/registry.ts 的同构双写收敛
// 单份），本文件 re-export 兼容 + 保留帧判别实现（纯类型与常量收协议
// 包，运行时函数留原位）。E2E 握手/信封帧类型安全批 H 起同收协议包
// （移动端 e2e 接入——三端 wire 契约单源），此处同样 re-export。
// **envelope 契约（T8/T9）详见包内 relay-frames.ts 头注释。**
import type {
  AuthFrame,
  E2eAckFrame,
  E2eHelloFrame,
  E2ESecureEnvelope,
  RelayFrame,
} from "@tianshu/protocol";

export type { RelayFrame };

// E2E 握手帧类型（wire 明文形态）与密文信封——单源 @tianshu/protocol
// relay-frames.ts（安全批 H 上收；kind 常量在 @tianshu/protocol，core
// e2e-crypto re-export 保既有 import 路径不变）
export type { E2eAckFrame, E2eHelloFrame, E2ESecureEnvelope };

/** 本端经 ws 出口的全部帧形态（业务帧 + 鉴权首帧 + E2E 握手/信封） */
export type WireFrame =
  RelayFrame | AuthFrame | E2eHelloFrame | E2eAckFrame | E2ESecureEnvelope;

/** req 帧最少合法形状判别（畸形帧静默丢弃，防打断其他帧处理） */
export function isReqFrame(
  frame: unknown,
): frame is Extract<RelayFrame, { kind: "req" }> {
  const candidate = frame as Extract<RelayFrame, { kind: "req" }> | null;
  return (
    candidate !== null &&
    candidate.kind === "req" &&
    typeof candidate.id === "number" &&
    typeof candidate.method === "string" &&
    typeof candidate.path === "string"
  );
}
