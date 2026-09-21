/**
 * memory.service 单测（spec §4/§5.1）：编辑指令应用 / 手动整理触发的
 * 错误码决策 + 在途互斥（MEMORY_BUSY）+ scheduler × service 共享 inflight
 * 集成（spec §5.2「定时与手动不并发」）。handlers 依赖全注入；模块顶层
 * import memory-compiler / scheduler（→ prisma-client/Log）在 vitest node
 * 环境即崩——照 memory-scheduler.test 先例 mock electron 与 prisma-client；
 * 集成用例另以 importOriginal 局部改写 compileMemory 为可控 deferred。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  // Log 模块顶层读取 app.getPath("userData") 计算日志目录
  app: { getPath: vi.fn(() => "/tmp/tianshu-test-user-data") },
}));

// scheduler 集成路径经全局 prisma 读 workspace/message/option，
// 屏蔽 prisma-client 模块初始化对 electron app 路径的依赖（既有模式）
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    workspace: { findMany: vi.fn(async () => []) },
    message: {
      findMany: vi.fn(async () => [
        {
          id: 1,
          role: "user",
          blocks: JSON.stringify([{ type: "text", text: "对话材料" }]),
        },
      ]),
    },
    option: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(),
    },
  },
}));

// 集成用例需要 compileMemory 挂起以持锁；其余导出（validateMemoryOutput /
// resolveMemoryModel / fetchRecentConversation）保留真实实现
const compileMemoryMock = vi.hoisted(() => vi.fn());
vi.mock(
  "../../electron/domains/ai/personalization/memory-compiler",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../electron/domains/ai/personalization/memory-compiler")
      >();
    return { ...actual, compileMemory: compileMemoryMock };
  },
);

import { createMemoryHandlers } from "../../electron/domains/ai/personalization/memory.service";
import type { MemoryModelContext } from "../../electron/domains/ai/personalization/memory-compiler";
import MemoryScheduler from "../../electron/domains/ai/personalization/memory-scheduler";
import { PERSONALIZATION_KEYS } from "../../electron/domains/ai/personalization/personalization.config";
import {
  acquire,
  isInflight,
  release,
} from "../../electron/domains/ai/personalization/memory-inflight";

const MODEL: MemoryModelContext = {
  type: "openai-compatible",
  baseUrl: "http://x",
  modelId: "m1",
};

/** 四标题齐备的合法编译输出（I2 后单节标题不再有效） */
const fourSectionMemory = (work = "新记忆") =>
  `## 工作背景\n${work}\n\n## 个人背景\nb\n\n## 当前关注\nc\n\n## 近期动态\nd`;

/** 独立 inflight 桩（每 handlers 一套，避免真实模块级状态串扰纯逻辑用例） */
function mkLock() {
  let held: AbortController | null = null;
  return {
    acquire: () => {
      if (held) {
        return null;
      }
      held = new AbortController();
      return held;
    },
    release: (owner: AbortController) => {
      if (held === owner) {
        held = null;
      }
    },
    isInflight: () => held !== null,
  };
}

/** 同源 acquire/release 对（单次调用用例省一行绑定） */
function mkLockDeps() {
  const lock = mkLock();
  return { acquire: lock.acquire, release: lock.release };
}

function mkHandlers(overrides: {
  enabled?: boolean;
  model?: object | null;
  material?: string;
  compiled?: string;
}) {
  return createMemoryHandlers({
    loadConfig: async () => ({
      memoryEnabled: overrides.enabled ?? true,
      memoryProfile: "",
      memoryLastCompiledAt: "",
    }),
    fetchMaterial: async () => overrides.material ?? "对话材料",
    resolveModel: async () =>
      (overrides.model === undefined
        ? MODEL
        : overrides.model) as MemoryModelContext | null,
    compile: async () => overrides.compiled ?? fourSectionMemory(),
    save: async () => {},
    ...mkLockDeps(),
  });
}

describe("applyMemoryInstruction", () => {
  it("成功返回新记忆且直接落库 Profile（不更新 LastCompiledAt，修订 2026-09-10）", async () => {
    const save = vi.fn(async () => {});
    const h = createMemoryHandlers({
      loadConfig: async () => ({
        memoryEnabled: true,
        memoryProfile: "",
        memoryLastCompiledAt: "",
      }),
      fetchMaterial: async () => "m",
      resolveModel: async () => MODEL,
      compile: async () => fourSectionMemory("新记忆"),
      save,
      ...mkLockDeps(),
    });
    expect(await h.applyInstruction("记住我在厦门")).toEqual({
      ok: true,
      memory: fourSectionMemory("新记忆"),
    });
    expect(save).toHaveBeenCalledWith(
      PERSONALIZATION_KEYS.memoryProfile,
      fourSectionMemory("新记忆"),
    );
    // LastCompiledAt 语义为「定时整理时间」，指令应用不算，避免干扰
    // 「当日未整理」判断（修订 2026-09-10 验收反馈）
    expect(save).not.toHaveBeenCalledWith(
      PERSONALIZATION_KEYS.memoryLastCompiledAt,
      expect.anything(),
    );
  });
  it("开关关 → MEMORY_DISABLED", async () => {
    const h = mkHandlers({ enabled: false });
    expect(await h.applyInstruction("x")).toEqual({
      ok: false,
      error: "MEMORY_DISABLED",
    });
  });
  it("无模型 → MEMORY_MODEL_MISSING", async () => {
    const h = mkHandlers({ model: null });
    expect(await h.applyInstruction("x")).toEqual({
      ok: false,
      error: "MEMORY_MODEL_MISSING",
    });
  });
  it("编译输出非法 → MEMORY_COMPILE_FAILED 且不落库", async () => {
    const save = vi.fn(async () => {});
    const h = createMemoryHandlers({
      loadConfig: async () => ({
        memoryEnabled: true,
        memoryProfile: "",
        memoryLastCompiledAt: "",
      }),
      fetchMaterial: async () => "m",
      resolveModel: async () => MODEL,
      compile: async () => "完全不是记忆格式",
      save,
      ...mkLockDeps(),
    });
    expect(await h.applyInstruction("x")).toEqual({
      ok: false,
      error: "MEMORY_COMPILE_FAILED",
    });
    expect(save).not.toHaveBeenCalled();
  });
  it("编译抛异常 → MEMORY_COMPILE_FAILED，锁已释放可立即重试", async () => {
    const lock = mkLock();
    let call = 0;
    const h = createMemoryHandlers({
      loadConfig: async () => ({
        memoryEnabled: true,
        memoryProfile: "",
        memoryLastCompiledAt: "",
      }),
      fetchMaterial: async () => "m",
      resolveModel: async () => MODEL,
      compile: async () => {
        call += 1;
        if (call === 1) {
          throw new Error("network down");
        }
        return fourSectionMemory("恢复");
      },
      save: async () => {},
      acquire: lock.acquire,
      release: lock.release,
    });
    expect(await h.applyInstruction("x")).toEqual({
      ok: false,
      error: "MEMORY_COMPILE_FAILED",
    });
    expect(lock.isInflight()).toBe(false);
    expect(await h.applyInstruction("x")).toEqual({
      ok: true,
      memory: fourSectionMemory("恢复"),
    });
  });
  it("超长指令入口截断到 2000 字再送编译（M1）", async () => {
    const compile = vi.fn(async () => fourSectionMemory());
    const h = createMemoryHandlers({
      loadConfig: async () => ({
        memoryEnabled: true,
        memoryProfile: "",
        memoryLastCompiledAt: "",
      }),
      fetchMaterial: async () => "m",
      resolveModel: async () => MODEL,
      compile,
      save: async () => {},
      ...mkLockDeps(),
    });
    await h.applyInstruction("长".repeat(3000));
    // 指令模式下 compile 的 material 参数即用户指令
    expect(compile.mock.calls[0][1]).toBe("长".repeat(2000));
  });
  it("在途占用 → MEMORY_BUSY 且不调编译", async () => {
    const lock = mkLock();
    const compile = vi.fn(async () => fourSectionMemory("x"));
    const h = createMemoryHandlers({
      loadConfig: async () => ({
        memoryEnabled: true,
        memoryProfile: "",
        memoryLastCompiledAt: "",
      }),
      fetchMaterial: async () => "m",
      resolveModel: async () => MODEL,
      compile,
      save: async () => {},
      acquire: lock.acquire,
      release: lock.release,
    });
    expect(lock.acquire()).toBeInstanceOf(AbortController); // 预占在途槽
    await expect(h.applyInstruction("x")).resolves.toEqual({
      ok: false,
      error: "MEMORY_BUSY",
    });
    await expect(h.compileNow()).resolves.toEqual({
      ok: false,
      error: "MEMORY_BUSY",
    });
    expect(compile).not.toHaveBeenCalled();
  });
});

describe("compileMemory", () => {
  it("无对话材料 → MEMORY_NO_MATERIAL 不报错", async () => {
    const h = mkHandlers({ material: "" });
    expect(await h.compileNow()).toEqual({
      ok: false,
      error: "MEMORY_NO_MATERIAL",
    });
  });
  it("开关关 → MEMORY_DISABLED 且不取对话材料（T5b）", async () => {
    const fetchMaterial = vi.fn(async () => "材料");
    const compile = vi.fn(async () => fourSectionMemory());
    const h = createMemoryHandlers({
      loadConfig: async () => ({
        memoryEnabled: false,
        memoryProfile: "",
        memoryLastCompiledAt: "",
      }),
      fetchMaterial,
      resolveModel: async () => MODEL,
      compile,
      save: async () => {},
      ...mkLockDeps(),
    });
    await expect(h.compileNow()).resolves.toEqual({
      ok: false,
      error: "MEMORY_DISABLED",
    });
    expect(fetchMaterial).not.toHaveBeenCalled();
    expect(compile).not.toHaveBeenCalled();
  });
  it("成功写 LastCompiledAt", async () => {
    const saved: string[] = [];
    const h = createMemoryHandlers({
      loadConfig: async () => ({
        memoryEnabled: true,
        memoryProfile: "",
        memoryLastCompiledAt: "",
      }),
      fetchMaterial: async () => "材料",
      resolveModel: async () => MODEL,
      compile: async () =>
        "## 工作背景\na\n\n## 个人背景\nb\n\n## 当前关注\nc\n\n## 近期动态\n[2026-09-09] - a",
      save: async (name: string) => void saved.push(name),
      ...mkLockDeps(),
    });
    expect((await h.compileNow()).ok).toBe(true);
    expect(saved).toContain("personalization.memoryProfile");
    expect(saved).toContain("personalization.memoryLastCompiledAt");
  });
});

describe("共享在途互斥（scheduler × service，spec §5.2）", () => {
  it("scheduler 整理在途时 service 返回 MEMORY_BUSY，收口后恢复", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 8, 9, 3, 0)); // 整理窗口内
      let finishCompile!: (memory: string) => void;
      compileMemoryMock.mockImplementationOnce(
        () => new Promise<string>((resolve) => (finishCompile = resolve)),
      );
      const scheduler = new MemoryScheduler({
        providerRepo: {
          getRuntimeInfo: async () => ({
            type: "openai-compatible",
            baseUrl: "http://x",
          }),
        },
        modelRepo: {
          getById: async (id: number) => ({
            id,
            providerId: 1,
            modelId: "m1",
            enabled: true,
          }),
          listAllEnabledAnyUser: async () => [
            { id: 1, providerId: 1, modelId: "m1", enabled: true },
          ],
        },
      });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(30_000); // 首个 tick 触发整理
      // 泵微任务直到 scheduler 抢到共享在途槽（决策 → run → acquire）
      for (let i = 0; i < 200 && !isInflight(); i += 1) {
        await Promise.resolve();
      }
      expect(isInflight()).toBe(true);

      // 与 scheduler 真实共享 memory-inflight（acquire/release 直连模块）
      const h = createMemoryHandlers({
        loadConfig: async () => ({
          memoryEnabled: true,
          memoryProfile: "",
          memoryLastCompiledAt: "",
        }),
        fetchMaterial: async () => "材料",
        resolveModel: async () => MODEL,
        compile: async () => fourSectionMemory("手动整理"),
        save: async () => {},
        acquire,
        release,
      });
      await expect(h.compileNow()).resolves.toEqual({
        ok: false,
        error: "MEMORY_BUSY",
      });
      await expect(h.applyInstruction("记住我在厦门")).resolves.toEqual({
        ok: false,
        error: "MEMORY_BUSY",
      });

      // quit 语义：stop 清定时器并 abort 在途（槽位立即腾空）
      scheduler.stop();
      expect(isInflight()).toBe(false);
      finishCompile(
        "## 工作背景\na\n\n## 个人背景\nb\n\n## 当前关注\nc\n\n## 近期动态\n[2026-09-09] - a",
      );
      for (let i = 0; i < 50; i += 1) {
        await Promise.resolve(); // scheduler 收口（release 因持有权校验为 no-op）
      }
      expect((await h.compileNow()).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
