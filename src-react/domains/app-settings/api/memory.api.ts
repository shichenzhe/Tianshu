/**
 * 记忆 AI 操作 API：错误码透传，渲染层映射 i18n 文案。
 * 通道由主进程 MemoryService 提供
 * （electron/domains/ai/personalization/memory.service.ts）。
 */
import { invoke } from "@/lib/ipc";

export type MemoryErrorCode =
  | "MEMORY_DISABLED"
  | "MEMORY_MODEL_MISSING"
  | "MEMORY_COMPILE_FAILED"
  | "MEMORY_NO_MATERIAL"
  | "MEMORY_BUSY";

export interface MemoryServiceResult {
  ok: boolean;
  memory?: string;
  error?: MemoryErrorCode;
}

export class MemoryApi {
  /** 编辑态 AI 指令：返回应用后的新记忆 markdown（草稿，未落库——用户点保存才持久化） */
  static async applyInstruction(
    instruction: string,
  ): Promise<MemoryServiceResult> {
    return invoke<MemoryServiceResult>(
      "personalization:applyMemoryInstruction",
      instruction,
    );
  }

  /** 手动触发一次整理（调试/补跑入口） */
  static async compileNow(): Promise<MemoryServiceResult> {
    return invoke<MemoryServiceResult>("personalization:compileMemory");
  }
}
