// relay 隧道帧（spec §3.3）——帧类型已收编 @tianshu/protocol（共享 core
// 重构 RC-T1，与 tianshu-server src/relay/registry.ts 的同构双写收敛
// 单份），本文件 re-export 兼容 + 保留帧判别实现（纯类型与常量收协议
// 包，运行时函数留原位）。
// **envelope 契约（T8/T9）详见包内 relay-frames.ts 头注释。**
import type { E2ESecureEnvelope } from "@tianshu/core";
import type { RelayFrame } from "@tianshu/protocol";

export type { RelayFrame };

/** E2E 握手帧（wire 明文形态；kind 常量在 @tianshu/core e2e-crypto——T1
 * 裁定跨仓单份经 core dist 消费，此处仅类型面） */
export type E2eHelloFrame = {
  kind: "e2e-hello";
  /** 控制端临时公钥（base64 32B） */
  ephemeralKey: string;
  /** 控制端已存指纹（TOFU 空=首连；被控端不校验，控制端对 ack 核对） */
  expectedFingerprint?: string;
};

/** E2E 应答帧（静态公钥 base64 + 指纹 hex16） */
export type E2eAckFrame = {
  kind: "e2e-ack";
  staticKey: string;
  fingerprint: string;
};

/** 本端经 ws 出口的全部帧形态（业务帧 + E2E 握手/信封） */
export type WireFrame =
  RelayFrame | E2eHelloFrame | E2eAckFrame | E2ESecureEnvelope;

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
