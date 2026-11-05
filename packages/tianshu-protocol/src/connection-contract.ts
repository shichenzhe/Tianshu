/**
 * 控制端连接 E2E 承载状态契约（TOFU 指纹确认仪式批，2026-11-05 上收单源）：
 * 桌面主进程（server/transport.ts TransportE2eState）与渲染层
 * （ai/server/api/server.api.ts ConnectionE2eState）原各自双写，收编为
 * 协议包单份；值域 kebab-case 与既有 mitm-suspect/required-failed 同构。
 * 仅控制端 UI/注册表语义面——非 wire 契约（relay 帧不承载，relay-frames.ts
 * 才是 wire 单源）；移动端 TransportState 为本地联合，可后续接入。
 */
export type ConnectionE2eState =
  /** 不适用（direct——信任模型内：localhost/上游 TLS 已覆盖） */
  | "unsupported"
  /** 明文中继（握手在途/降级兼容——UI 警示徽标） */
  | "plaintext"
  /**
   * TOFU 首连已建加密会话但指纹未经用户核对（P0-1 确认仪式）：通信可用，
   * UI 呈 mitm-suspect 同款警示 + 指纹核对卡；用户确认后回填指纹持久化
   * （ConnectionConfig.confirmedAt 记确认时刻），其后不匹配走 mitm-suspect
   */
  | "pending-confirm"
  /** 加密会话已建立（指纹核对通过/已确认钉扎） */
  | "encrypted"
  /** 指纹不匹配断开（UI 红色警示，不再重连） */
  | "mitm-suspect"
  /** 连接级 e2e=required 握手无 ack 拒降级断开（不再重连） */
  | "required-failed";

/**
 * TOFU 指纹用户确认时间戳（ISO 8601 字符串）：连接配置字段
 * `ConnectionConfig.confirmedAt` 的契约语义——
 * - 用户经确认卡显式确认协商指纹时写入（registry.confirmFingerprint）；
 * - 手工录入/更换指纹视为同等核对行为（save 时写入）；
 * - 缺省 = 未确认（TOFU 待核对）；存量已钉扎连接经迁移视为已确认
 *   （升级首见时刻代替——option 表 JSON 无行级 createdAt）。
 */
export type FingerprintConfirmedAt = string;
