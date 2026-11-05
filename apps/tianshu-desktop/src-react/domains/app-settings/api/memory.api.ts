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
  /** AI 指令：主进程直接应用并落库（修订 B），返回落库后的新记忆 markdown */
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

  /** 批9 P4 条目溯源：msgId → 来源会话（设置页「查看来源会话」跳转源；
   *  归属校验在主进程——他人会话的消息不透出） */
  static async resolveSources(
    messageIds: number[],
  ): Promise<MemorySourceInfo[]> {
    return invoke<MemorySourceInfo[]>(
      "personalization:resolveMemorySources",
      messageIds,
    );
  }
}

/** 条目来源会话（resolveSources 返回项） */
export interface MemorySourceInfo {
  messageId: number;
  sessionId: number;
  title: string;
}
