/**
 * 记忆 IPC 服务（spec §4/§5.1）：编辑指令应用 + 手动整理触发。
 * 错误以错误码返回（不 throw 到渲染端），渲染层映射 i18n；在途互斥走
 * memory-inflight 共享模块（与定时整理不并发，spec §5.2）。指令应用与
 * 整理路径均直接落库 Profile（修订 2026-09-10 验收反馈）；仅整理路径
 * 更新 LastCompiledAt。依赖全注入（createMemoryHandlers 纯逻辑可测），
 * MemoryService 仅做生产依赖组装与 IPC 注册——repo 为 Application 已建
 * 实例（构造器会 ipcMain.handle，二次 new 因重复注册抛错，故构造注入
 * 复用）。
 */
import { ipcMain } from "electron";

import prisma from "../../../commons/prisma-client";
import { setAppOption } from "../../app-settings/option-store";
import {
  compileMemory,
  fetchRecentConversation,
  resolveMemoryModel,
  validateMemoryOutput,
  type MemoryModelContext,
} from "./memory-compiler";
import { loadPersonalization } from "./personalization.repo";
import {
  memoryLastCompiledAtKeyFor,
  memoryProfileKeyFor,
} from "./personalization.config";
import { acquire, release } from "./memory-inflight";
import { handleUser } from "../../../commons/ipc-user";
import type { MemorySchedulerDeps } from "./memory-scheduler";

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

/** 用户 AI 指令入口限长（M1）：超长截断，防 IPC 直调撑爆 prompt */
const MEMORY_INSTRUCTION_LIMIT = 2000;

export interface MemoryHandlerDeps {
  /** 批9 P2.1：读配置/取素材/落库均按当次 userId（画像 per-user 命名空间） */
  loadConfig: (userId: number) => Promise<{
    memoryEnabled: boolean;
    memoryProfile: string;
    memoryLastCompiledAt: string;
  }>;
  fetchMaterial: (userId: number) => Promise<string>;
  resolveModel: () => Promise<MemoryModelContext | null>;
  compile: (
    currentMemory: string,
    material: string,
    instructionMode: boolean,
    model: MemoryModelContext,
    signal?: AbortSignal,
  ) => Promise<string>;
  save: (name: string, value: string) => Promise<void>;
  /** 在途互斥（与定时整理共享，spec §5.2）：占用中 acquire 返回 null */
  acquire: () => AbortController | null;
  release: (owner: AbortController) => void;
}

/** 前置闸门结果：未通过为错误码，通过携带后续编译所需上下文 */
type MemoryGate =
  | { ok: false; error: MemoryErrorCode }
  | {
      ok: true;
      model: MemoryModelContext;
      currentMemory: string;
      material: string;
    };

export function createMemoryHandlers(deps: MemoryHandlerDeps) {
  /** 前置闸门：开关关 / 无材料（整理路径，材料惰性求值）/ 无模型 → 错误码 */
  const passGates = async (
    userId: number,
    getMaterial: () => Promise<string>,
    instructionMode: boolean,
  ): Promise<MemoryGate> => {
    const config = await deps.loadConfig(userId);
    if (!config.memoryEnabled) {
      return { ok: false, error: "MEMORY_DISABLED" };
    }
    // T5b：开关通过后才取对话材料（整理路径的库扫描不在开关关时白跑）
    const material = await getMaterial();
    if (!instructionMode && material === "") {
      return { ok: false, error: "MEMORY_NO_MATERIAL" };
    }
    const model = await deps.resolveModel();
    if (!model) {
      return { ok: false, error: "MEMORY_MODEL_MISSING" };
    }
    return { ok: true, model, currentMemory: config.memoryProfile, material };
  };

  /** 编译（锁内执行）：失败或输出非法 → MEMORY_COMPILE_FAILED；指令模式不更新 LastCompiledAt */
  const execute = async (
    userId: number,
    gate: Extract<MemoryGate, { ok: true }>,
    instructionMode: boolean,
    signal?: AbortSignal,
  ): Promise<MemoryServiceResult> => {
    let raw: string;
    try {
      raw = await deps.compile(
        gate.currentMemory,
        gate.material,
        instructionMode,
        gate.model,
        signal,
      );
    } catch {
      return { ok: false, error: "MEMORY_COMPILE_FAILED" };
    }
    const memory = validateMemoryOutput(raw);
    if (memory === null) {
      return { ok: false, error: "MEMORY_COMPILE_FAILED" };
    }
    // 指令应用直接落库（修订 2026-09-10 验收反馈）；但不更新
    // memoryLastCompiledAt——该时间戳语义为定时整理时间，指令应用
    // 不算，避免干扰「当日未整理」判断。批9：落库键按 userId 命名空间
    await deps.save(memoryProfileKeyFor(userId), memory);
    if (!instructionMode) {
      await deps.save(
        memoryLastCompiledAtKeyFor(userId),
        new Date().toISOString(),
      );
    }
    return { ok: true, memory };
  };

  const run = async (
    userId: number,
    getMaterial: () => Promise<string>,
    instructionMode: boolean,
  ): Promise<MemoryServiceResult> => {
    const gate = await passGates(userId, getMaterial, instructionMode);
    if (!gate.ok) {
      return gate;
    }
    // 执行前占用在途槽（与定时整理互斥）；quit abort 经 signal 传导
    const lock = deps.acquire();
    if (!lock) {
      return { ok: false, error: "MEMORY_BUSY" };
    }
    try {
      return await execute(userId, gate, instructionMode, lock.signal);
    } finally {
      deps.release(lock);
    }
  };

  return {
    applyInstruction: (userId: number, instruction: string) =>
      // M1：入口限长截断，防 IPC 直调绕过前端 maxLength 撑爆 prompt
      run(
        userId,
        async () => instruction.slice(0, MEMORY_INSTRUCTION_LIMIT),
        true,
      ),
    compileNow: (userId: number) =>
      run(userId, () => deps.fetchMaterial(userId), false),
  };
}

/** 条目溯源（批9 P4）：msgId → 归属会话（设置页「查看来源会话」跳转源）。
 *  归属校验：会话必须属当前用户（他人会话的消息不透出）；查无/不属 → 缺席 */
export async function resolveMemorySources(
  prismaLike: {
    message: {
      findMany(
        args: unknown,
      ): Promise<Array<{ id: number; sessionId: number }>>;
    };
    session: {
      findMany(
        args: unknown,
      ): Promise<Array<{ id: number; title: string | null }>>;
    };
  },
  userId: number,
  messageIds: number[],
): Promise<Array<{ messageId: number; sessionId: number; title: string }>> {
  const ids = [...new Set(messageIds)].filter((id) => Number.isInteger(id));
  if (ids.length === 0) {
    return [];
  }
  const messages = await prismaLike.message.findMany({
    where: { id: { in: ids } },
    select: { id: true, sessionId: true },
  });
  const sessionIds = [...new Set(messages.map((m) => m.sessionId))];
  if (sessionIds.length === 0) {
    return [];
  }
  const sessions = await prismaLike.session.findMany({
    where: { id: { in: sessionIds }, userId },
    select: { id: true, title: true },
  });
  const owned = new Map(sessions.map((s) => [s.id, s.title ?? ""]));
  return messages
    .filter((m) => owned.has(m.sessionId))
    .map((m) => ({
      messageId: m.id,
      sessionId: m.sessionId,
      title: owned.get(m.sessionId) ?? "",
    }));
}

/** MemoryService 依赖注入面（repo 为 Application 已建实例） */
export type MemoryServiceDeps = Pick<
  MemorySchedulerDeps,
  "providerRepo" | "modelRepo"
>;

/** 生产依赖组装 + IPC 注册（Application.registerServices 接线） */
export default class MemoryService {
  /** 记忆批公开化：handlers 单份（IPC 与被控面 face 桥同源——automation
   *  批「内联体收拢」同款）；惰性建（registerIpc 与 face 装配孰先均可） */
  private handlers: ReturnType<typeof createMemoryHandlers> | null = null;

  constructor(private deps: MemoryServiceDeps) {}

  /** AI 指令应用（IPC 与 memory-tap 共用入口）；userId = 画像归属用户 */
  async applyInstruction(
    instruction: string,
    userId: number,
  ): Promise<MemoryServiceResult> {
    return (await this.ensureHandlers()).applyInstruction(userId, instruction);
  }

  /** 手动整理（同上共用） */
  async compileNow(userId: number): Promise<MemoryServiceResult> {
    return (await this.ensureHandlers()).compileNow(userId);
  }

  /** 条目来源会话解析（设置页逐条溯源跳转源） */
  resolveMemorySources(
    userId: number,
    messageIds: number[],
  ): Promise<Array<{ messageId: number; sessionId: number; title: string }>> {
    return resolveMemorySources(prisma, userId, messageIds);
  }

  private async ensureHandlers(): Promise<
    ReturnType<typeof createMemoryHandlers>
  > {
    if (this.handlers === null) {
      this.handlers = createMemoryHandlers({
        loadConfig: (userId) => loadPersonalization(userId),
        fetchMaterial: (userId) =>
          fetchRecentConversation(prisma, 7, 30000, userId),
        resolveModel: () =>
          resolveMemoryModel(this.deps.providerRepo, this.deps.modelRepo, () =>
            this.deps.modelRepo.listAllEnabledAnyUser(),
          ),
        compile: (currentMemory, material, instructionMode, model, signal) =>
          compileMemory({
            currentMemory,
            material,
            instructionMode,
            model,
            signal,
          }),
        save: (name, value) => setAppOption(prisma.option, name, value),
        acquire,
        release,
      });
    }
    return this.handlers;
  }

  registerIpc(): void {
    // 批9：token → userId（v12 隔离口径），画像按命名空间读写
    handleUser(
      "personalization:applyMemoryInstruction",
      (_, userId, instruction: string) =>
        this.applyInstruction(instruction, userId),
    );
    handleUser("personalization:compileMemory", (_, userId) =>
      this.compileNow(userId),
    );
    handleUser(
      "personalization:resolveMemorySources",
      (_, userId, messageIds: number[]) =>
        this.resolveMemorySources(userId, messageIds),
    );
  }
}
