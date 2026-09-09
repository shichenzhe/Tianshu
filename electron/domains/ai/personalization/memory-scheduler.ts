/**
 * 记忆定时器（spec §5.2）：30s tick 决策 + 启动补跑（>24h 延迟 90s）。
 * 在途互斥走 memory-inflight 共享模块（与 memory.service 手动触发共用，
 * 定时与手动不并发）；退出时 stop 统一 abort 在途请求；失败静默记日志
 * 等下一轮（I1：失败后 10 分钟内不再尝试）。90s 补跑评估无论结果均消费
 * 补跑标志（M4），未满足 24h 时不再阻塞夜间窗口分支。provider/model
 * 查询面由外部注入（repo 构造器注册 IPC，此处二次 new 会因重复注册抛错，
 * 故复用 Application 已建实例）。
 */
import prisma from "../../../commons/prisma-client";
import Log from "../../../commons/Log";
import { setAppOption } from "../../app-settings/option-store";
import {
  compileMemory,
  fetchRecentConversation,
  resolveMemoryModel,
  type MemoryModelContext,
  type MemoryModelRow,
  type ProviderRuntimeSource,
} from "./memory-compiler";
import { loadPersonalization } from "./personalization.repo";
import { PERSONALIZATION_KEYS } from "./personalization.config";
import { abortInflight, acquire, isInflight, release } from "./memory-inflight";

const TICK_MS = 30_000;
const CATCHUP_DELAY_MS = 90_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** 失败退避（I1）：编译失败后距下次尝试的最小间隔 */
export const RETRY_BACKOFF_MS = 10 * 60 * 1000;

export interface MemoryTickState {
  enabled: boolean;
  inflight: boolean;
  lastCompiledAt: string;
  catchUpPending: boolean;
  /** 上次尝试（含失败）的 epoch ms；0/缺省 = 从未尝试（I1 失败退避） */
  lastAttemptAt?: number;
}

export type MemoryTickDecision = "compile" | "catchUp" | "noop";

/** scheduler 依赖注入面（tickMs 测试可注入；repo 为 Application 已建实例） */
export interface MemorySchedulerDeps {
  providerRepo: ProviderRuntimeSource;
  modelRepo: {
    getById(id: number): Promise<MemoryModelRow | null>;
    listAll(): Promise<MemoryModelRow[]>;
  };
  tickMs?: number;
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 决策纯函数（注入时钟可测） */
export function decideMemoryTick(
  state: MemoryTickState,
  now: Date,
): MemoryTickDecision {
  if (!state.enabled || state.inflight) {
    return "noop";
  }
  // I1 失败退避：距上次尝试 <10 分钟 → noop（窗口内与补跑路径均拦截）
  const lastAttemptAt = state.lastAttemptAt ?? 0;
  if (lastAttemptAt > 0 && now.getTime() - lastAttemptAt < RETRY_BACKOFF_MS) {
    return "noop";
  }
  if (state.catchUpPending) {
    const last = state.lastCompiledAt ? new Date(state.lastCompiledAt) : null;
    const overdue = last === null || now.getTime() - last.getTime() > DAY_MS;
    return overdue ? "catchUp" : "noop";
  }
  const hour = now.getHours();
  if (hour < 2 || hour >= 4) {
    return "noop";
  }
  const last = state.lastCompiledAt ? new Date(state.lastCompiledAt) : null;
  return last && isSameLocalDay(last, now) ? "noop" : "compile";
}

export default class MemoryScheduler {
  private timer: NodeJS.Timeout | null = null;
  private catchUpTimer: NodeJS.Timeout | null = null;
  private catchUpPending = false;
  private lastAttemptAt = 0;

  constructor(private deps: MemorySchedulerDeps) {}

  start(): void {
    // 启动补跑（spec §5.2）：90s 计时到点挂补跑标志并评估一轮；评估后
    // 无论结果均消费标志（M4）——未满 24h 时不再阻塞夜间窗口分支，
    // 等 02:00-04:00 窗口触发
    this.catchUpTimer = setTimeout(() => {
      this.catchUpPending = true;
      void this.tick().finally(() => {
        this.catchUpPending = false;
      });
    }, CATCHUP_DELAY_MS);
    this.timer = setInterval(
      () => void this.tick(),
      this.deps.tickMs ?? TICK_MS,
    );
    Log.info("记忆调度器已启动");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.catchUpTimer) {
      clearTimeout(this.catchUpTimer);
      this.catchUpTimer = null;
    }
    // 共享在途槽统一 abort（含 service 手动触发的在途，spec §5.2 退出语义）
    abortInflight();
  }

  private async loadState(): Promise<MemoryTickState> {
    const config = await loadPersonalization();
    return {
      enabled: config.memoryEnabled,
      inflight: isInflight(),
      lastCompiledAt: config.memoryLastCompiledAt,
      catchUpPending: this.catchUpPending,
      lastAttemptAt: this.lastAttemptAt,
    };
  }

  private async tick(): Promise<void> {
    try {
      const decision = decideMemoryTick(await this.loadState(), new Date());
      if (decision === "noop") {
        return;
      }
      await this.run();
    } catch (error) {
      Log.warn("记忆定时 tick 异常", error);
    }
  }

  /** 执行一次整理（共享 inflight 互斥；失败记录退避起点） */
  private async run(): Promise<void> {
    const abort = acquire();
    if (!abort) {
      return;
    }
    this.catchUpPending = false;
    try {
      await this.compileOnce(abort.signal);
    } catch (error) {
      this.lastAttemptAt = Date.now(); // I1：10 分钟退避起点
      Log.warn("记忆整理失败（10 分钟后重试）", error);
    } finally {
      release(abort);
    }
  }

  private async compileOnce(signal: AbortSignal): Promise<void> {
    const config = await loadPersonalization();
    const material = await fetchRecentConversation(prisma);
    if (material === "") {
      return; // 无对话材料直接跳过（spec §5.3，不更新 LastCompiledAt）
    }
    const model = await this.resolveModel();
    if (!model) {
      return; // 无可用模型静默跳过（spec §5.3）
    }
    const memory = await compileMemory({
      currentMemory: config.memoryProfile,
      material,
      instructionMode: false,
      model,
      signal,
    });
    await this.persist(memory);
  }

  private resolveModel(): Promise<MemoryModelContext | null> {
    return resolveMemoryModel(this.deps.providerRepo, this.deps.modelRepo, () =>
      this.deps.modelRepo.listAll(),
    );
  }

  private async persist(memory: string): Promise<void> {
    await setAppOption(
      prisma.option,
      PERSONALIZATION_KEYS.memoryProfile,
      memory,
    );
    await setAppOption(
      prisma.option,
      PERSONALIZATION_KEYS.memoryLastCompiledAt,
      new Date().toISOString(),
    );
  }
}
