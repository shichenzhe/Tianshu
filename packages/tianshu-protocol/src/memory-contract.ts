/**
 * 记忆面契约（移动端记忆进化批，2026-10-27）：桌面被控面专属五端点
 * （memory/get|saveConfig|saveProfile|applyInstruction|compile）——记忆
 * 数据（option 表 PERSONALIZATION_KEYS）与每晚整理调度均在桌面端，
 * 无头端不实现不报（A5/A6/AR 批先例）。错误码语义与桌面
 * electron/domains/ai/personalization/memory.service.ts 五值枚举同源
 * （不 throw、码透传消费端映射）。
 */

/** AI 操作错误码（MemoryServiceResult.error；ok:true 无 error） */
export type MemoryErrorCode =
  | "MEMORY_DISABLED"
  | "MEMORY_MODEL_MISSING"
  | "MEMORY_COMPILE_FAILED"
  | "MEMORY_NO_MATERIAL"
  | "MEMORY_BUSY";

/** AI 操作（applyInstruction/compile）出参：ok + 新画像（失败带码） */
export interface MemoryServiceResult {
  ok: boolean;
  memory?: string;
  error?: MemoryErrorCode;
}

/** memory/get 出参：配置+画像一次读全（profile 为四板块 markdown 全文） */
export interface MemoryState {
  enabled: boolean;
  /** 四板块画像 markdown（空串=从未生成或已重置） */
  profile: string;
  /** 整理模型 id；null = 未配置（缺省走 provider 默认模型） */
  modelId: number | null;
  /** 上次定时整理时间（ISO；null=从未） */
  lastCompiledAt: string | null;
  /** 上次整理失败原因（桌面调度器写入；null=无） */
  lastError: string | null;
}
