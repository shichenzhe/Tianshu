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
import { PERSONALIZATION_KEYS } from "./personalization.config";
import { acquire, release } from "./memory-inflight";
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
  loadConfig: () => Promise<{
    memoryEnabled: boolean;
    memoryProfile: string;
    memoryLastCompiledAt: string;
  }>;
  fetchMaterial: () => Promise<string>;
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
    getMaterial: () => Promise<string>,
    instructionMode: boolean,
  ): Promise<MemoryGate> => {
    const config = await deps.loadConfig();
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
    // 不算，避免干扰「当日未整理」判断
    await deps.save(PERSONALIZATION_KEYS.memoryProfile, memory);
    if (!instructionMode) {
      await deps.save(
        PERSONALIZATION_KEYS.memoryLastCompiledAt,
        new Date().toISOString(),
      );
    }
    return { ok: true, memory };
  };

  const run = async (
    getMaterial: () => Promise<string>,
    instructionMode: boolean,
  ): Promise<MemoryServiceResult> => {
    const gate = await passGates(getMaterial, instructionMode);
    if (!gate.ok) {
      return gate;
    }
    // 执行前占用在途槽（与定时整理互斥）；quit abort 经 signal 传导
    const lock = deps.acquire();
    if (!lock) {
      return { ok: false, error: "MEMORY_BUSY" };
    }
    try {
      return await execute(gate, instructionMode, lock.signal);
    } finally {
      deps.release(lock);
    }
  };

  return {
    applyInstruction: (instruction: string) =>
      // M1：入口限长截断，防 IPC 直调绕过前端 maxLength 撑爆 prompt
      run(async () => instruction.slice(0, MEMORY_INSTRUCTION_LIMIT), true),
    compileNow: () => run(deps.fetchMaterial, false),
  };
}

/** MemoryService 依赖注入面（repo 为 Application 已建实例） */
export type MemoryServiceDeps = Pick<
  MemorySchedulerDeps,
  "providerRepo" | "modelRepo"
>;

/** 生产依赖组装 + IPC 注册（Application.registerServices 接线） */
export default class MemoryService {
  constructor(private deps: MemoryServiceDeps) {}

  registerIpc(): void {
    const handlers = createMemoryHandlers({
      loadConfig: () => loadPersonalization(),
      fetchMaterial: () => fetchRecentConversation(prisma),
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
    ipcMain.handle(
      "personalization:applyMemoryInstruction",
      (_, instruction: string) => handlers.applyInstruction(instruction),
    );
    ipcMain.handle("personalization:compileMemory", () =>
      handlers.compileNow(),
    );
  }
}
