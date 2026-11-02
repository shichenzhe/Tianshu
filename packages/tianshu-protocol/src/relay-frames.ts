/**
 * relay 隧道帧（spec §3.3；RC-T1 收编单份）——唯一 wire 契约定义：
 * tianshu-server src/relay/registry.ts 已单源引用本类型（2026-11-01
 * 收敛——原该侧六值宽松联合与 ping/pong 分叉，protocol 加 kind 无
 * 编译反馈）。
 *
 * **envelope 契约（T8/T9 契约注记 → 双仓钉死）**：
 * - req 帧负载与直连 HTTP 同构：{method:"GET"|"POST", path:"session/query"
 *   |"/session/query"（前导斜杠归一等价）, body?:unknown}；
 * - res 帧负载 {id, status, body}：status/body 即 handleRoute 的返回——
 *   body 含 starter 包装 {code,success,data,message}（业务错 200+4xxx）；
 * - relay 客户端按此消费 req 帧，RelayTransport.request() 按此封装
 *   req/res 配对，两承载（直连 HTTP / relay 隧道）上层无感。
 */
export type RelayFrame =
  | { kind: "req"; id: number; method: string; path: string; body?: unknown }
  | { kind: "res"; id: number; status: number; body: unknown }
  | { kind: "event"; type: string; payload: unknown }
  | { kind: "open"; connectionId: string }
  | { kind: "close"; connectionId: string; reason?: string }
  | {
      kind: "register";
      instanceId: string;
      capabilities: string[];
      name?: string;
    }
  // 活性帧（T14）：应用层 ping/pong 经 relay 透传（relay 侧只校验 kind 为
  // string；tianshu-server RelayFrameKind 未列亦原样转发）——undici 全局
  // WebSocket 无协议层 ping，见 ws-liveness.ts。双端对称：定时发 ping、
  // 收 ping 回 pong
  | { kind: "ping" }
  | { kind: "pong" };

// ---- 连接鉴权首帧（安全批 I：凭证出 URL query）----
// token 走 upgrade query 的明文面会留存在反代/负载均衡访问日志与
// 浏览器/中间件 URL 记录；升级完成后以首帧承载凭证（ws 帧不经访问
// 日志）。兼容窗口期客户端双发（query 保留 + 首帧 auth），relay 侧
// auth 优先、query 双轨受理并打弃用告警；窗口期后客户端移除 query。

/** 连接鉴权首帧（relay 消费不转发；必须是该连接的第一条消息） */
export type AuthFrame = {
  kind: "auth";
  /** 接入令牌（等价原 query token） */
  token: string;
  /** 连接角色（等价原 query role） */
  role: "client" | "server";
  /** 被控端注册键（仅 role=server；等价原 query connectionId） */
  connectionId?: string;
};

// ---- relay 多租户三校验点 close code（spec §4.2）----
// WebSocket 关闭码（应用私有 4000-4999 段，续接 relay 既有 4000-4004）：
// relay/被控端校验不过即按码断开，控制端按码分支提示。wire 契约值
// 三端钉死于此，改值即破协议。

/**
 * relay 多租户三校验点语义化关闭码（多租户接入的三道闸门，见 spec §4.2）：
 * - QUOTA_EXCEEDED：配额超限——每租户在线连接数超 claims.quota；
 * - ID_CONFLICT：异租户注册已占用 connectionId（顶号防护）；
 * - TENANT_FORBIDDEN：控制端跨租户 attach（配对授权）。
 */
export const RELAY_CLOSE_CODES = {
  QUOTA_EXCEEDED: 4005,
  ID_CONFLICT: 4006,
  TENANT_FORBIDDEN: 4007,
} as const;

// ---- E2E 扩展帧（spec 2026-10-18-relay-e2e；安全批 H 上收 protocol）----
// 原仅 @tianshu/core e2e-crypto 导出（kind 常量）+ mirror server-face
// relay-protocol.ts（帧类型）——移动端接入 e2e 需消费契约但不能引 core
// （langChain peer 依赖不进 metro bundle），wire 契约三端单源在此。
// core e2e-crypto 转为 re-export 本处常量（运行时实现仍在 core）。

/** E2E 握手帧 kind（明文经 relay 照转发）——跨仓单份 wire 契约 */
export const E2E_HANDSHAKE_HELLO = "e2e-hello";
export const E2E_HANDSHAKE_ACK = "e2e-ack";
/** 密文信封帧 kind（包装一切后续业务帧） */
export const E2E_SECURE_KIND = "e2e-secure";
/** 接收端滑动窗口宽度（计数器记忆数） */
export const E2E_REPLAY_WINDOW = 64;

/** E2E 握手帧（wire 明文形态；控制端 → 被控端） */
export type E2eHelloFrame = {
  kind: "e2e-hello";
  /** 控制端临时公钥（base64 32B） */
  ephemeralKey: string;
  /** 控制端已存指纹（TOFU 空=首连；被控端不校验，控制端对 ack 核对） */
  expectedFingerprint?: string;
};

/** E2E 应答帧（静态公钥 base64 + 指纹 hex16；被控端 → 控制端） */
export type E2eAckFrame = {
  kind: "e2e-ack";
  staticKey: string;
  fingerprint: string;
};

/** 密文信封（n=12B nonce，ct=密文+16B GCM tag，均 base64） */
export type E2ESecureEnvelope = {
  kind: "e2e-secure";
  n: string;
  ct: string;
};
