// 记忆进化批 memory face 桥：桌面被控面专属五端点（memory/get|saveConfig|
// saveProfile|applyInstruction|compile）——option 表存储+每晚调度在桌面端，
// 无头端不实现不报（A5/A6/AR 先例）。批9（2026-11-05）：画像三键 per-user
// 化——五端点均带 userId（开关/整理模型仍本机全局，走 app 级 key）；
// AI 操作转 MemoryService 公开方法（IPC 与被控面同源——automation 批
// 「内联体收拢」同款）。tap 接 deps 注入，内存替身可直测。
import { PERSONALIZATION_KEYS, memoryProfileKeyFor } from "@tianshu/core";
import type { MemoryServiceResult, MemoryState } from "@tianshu/protocol";
import type { PersonalizationConfig } from "../ai/personalization/personalization.config";
import type { ServerFaceMemory } from "./deps";

/** 画像 markdown 上限（桌面 model/memory-markdown.ts MEMORY_PROFILE_LIMIT
 *  同值——face 侧保底截断，防超长覆写撑爆注入 prompt） */
const PROFILE_LIMIT = 8000;

/** 配置 → wire 状态（modelId/时间戳/错误 空串 → null；modelId 数字化） */
function toMemoryState(config: PersonalizationConfig): MemoryState {
  const modelId = Number(config.memoryModelId);
  return {
    enabled: config.memoryEnabled,
    profile: config.memoryProfile,
    modelId:
      config.memoryModelId !== "" && Number.isFinite(modelId) ? modelId : null,
    lastCompiledAt: config.memoryLastCompiledAt || null,
    lastError: config.memoryLastError || null,
  };
}

export function createMemoryFace(deps: {
  /** 按用户读取（画像/整理元数据 per-user，其余键 app 级） */
  loadConfig: (userId: number) => Promise<PersonalizationConfig>;
  save: (name: string, value: string) => Promise<void>;
  memoryService: Pick<MemoryServiceLike, "applyInstruction" | "compileNow">;
}): ServerFaceMemory {
  async function get(userId: number): Promise<MemoryState> {
    return toMemoryState(await deps.loadConfig(userId));
  }
  return {
    get,
    // 显式携带才写（enabled/modelId 各自独立，均本机全局键）；写后回读聚合
    saveConfig: async (userId, payload) => {
      if (typeof payload.enabled === "boolean") {
        await deps.save(
          PERSONALIZATION_KEYS.memoryEnabled,
          String(payload.enabled),
        );
      }
      if (payload.modelId !== undefined) {
        await deps.save(
          PERSONALIZATION_KEYS.memoryModelId,
          payload.modelId === null ? "" : String(payload.modelId),
        );
      }
      return get(userId);
    },
    // 全量覆写（空串=重置语义——移动端重置共用；桌面导入对话框 merge
    // 逻辑不进 wire，spec 标注假设）；超长保底截断；批9 落当前用户命名空间
    saveProfile: async (userId, profile) => {
      await deps.save(
        memoryProfileKeyFor(userId),
        profile.slice(0, PROFILE_LIMIT),
      );
      return get(userId);
    },
    applyInstruction: (userId, instruction) =>
      deps.memoryService.applyInstruction(instruction, userId),
    compile: (userId) => deps.memoryService.compileNow(userId),
  };
}

/** MemoryService 结构子集（实例天然满足；独立声明避免 tap 依赖类构造——
 *  测试替身不引） */
interface MemoryServiceLike {
  applyInstruction(
    instruction: string,
    userId: number,
  ): Promise<MemoryServiceResult>;
  compileNow(userId: number): Promise<MemoryServiceResult>;
}
