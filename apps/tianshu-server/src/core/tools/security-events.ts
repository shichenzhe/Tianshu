/**
 * 安全审计事件最小形状（自 mirror src-react/domains/security/model/types 的
 * SecurityEventSink 载荷收敛）：服务端未移植安全中心，仅保留工具门禁与
 * bash 事实上报的事件结构；消费方（日志/审计出口）由装配层接线。
 */
export interface SecurityEvent {
  eventType: string;
  /** 决议词汇（blocked/rejected/approved/info/failed 等自由字符串） */
  decision: string;
  detail: Record<string, unknown>;
  /** 命令类事件的脱敏预览（截断 100）与 sha256 指纹（对账用） */
  commandPreview?: string;
  commandHash?: string;
  /** 发起会话 id；图执行无会话为 null（2026-10-28 去会话化，mirror 同款） */
  sessionId: number | null;
}

export type SecurityEventSink = (event: SecurityEvent) => void;
