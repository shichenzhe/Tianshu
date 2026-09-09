/**
 * memory-scheduler 单测（spec §5.2）：决策纯函数（整理窗口 / 当日已整理 /
 * 补跑条件 / 开关 / inflight 互斥 / 失败退避）+ 运行时 catchUp 消费语义
 * + 整理失败原因持久化（修订 A：memoryLastError）。
 * scheduler 模块顶层 import memory-compiler（→ prisma-client/Log）在 vitest
 * node 环境即崩——照 memory-compiler.test 先例先 mock electron 与
 * prisma-client 两个基建模块；运行时用例另以 importOriginal 局部改写
 * compileMemory 为可控桩（网络调用不落地）。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  // Log 模块顶层读取 app.getPath("userData") 计算日志目录
  app: { getPath: vi.fn(() => "/tmp/tianshu-test-user-data") },
}));

// 运行时用例（catchUp 消费）经全局 prisma 读写 option/message/workspace，
// 屏蔽 prisma-client 模块初始化对 electron app 路径的依赖（既有模式）；
// updateMany/create 回写 stub 行模拟真实落库（成功整理后 tick 应转 noop）
const prismaStubs = vi.hoisted(() => ({
  optionRows: [] as Array<{ name: string; value: string }>,
  messageRows: [
    {
      id: 1,
      role: "user",
      blocks: JSON.stringify([{ type: "text", text: "对话材料" }]),
    },
  ] as Array<{ id: number; role: string; blocks: string }>,
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    workspace: { findMany: vi.fn(async () => []) },
    message: {
      findMany: vi.fn(async () => prismaStubs.messageRows),
    },
    option: {
      findMany: vi.fn(async () => prismaStubs.optionRows),
      updateMany: vi.fn(
        async (args: { where: { name: string }; data: { value: string } }) => {
          const row = prismaStubs.optionRows.find(
            (r) => r.name === args.where.name,
          );
          if (!row) {
            return { count: 0 };
          }
          row.value = args.data.value;
          return { count: 1 };
        },
      ),
      create: vi.fn(async (args: { data: { name: string; value: string } }) => {
        prismaStubs.optionRows.push({
          name: args.data.name,
          value: args.data.value,
        });
      }),
    },
  },
}));

// 运行时用例需要 compileMemory 可控（真实实现经 generateText 走网络）；
// 其余导出（fetchRecentConversation/resolveMemoryModel）保留真实实现
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

import MemoryScheduler, {
  decideMemoryTick,
} from "../../electron/domains/ai/personalization/memory-scheduler";

const base = {
  enabled: true,
  inflight: false,
  lastCompiledAt: "",
  catchUpPending: false,
};

const at = (h: number, m = 0): Date => new Date(2026, 8, 9, h, m);

/** 2026-09-09 深夜窗口内的时间（补跑计时从 01:00 起跳） */
const atSeconds = (h: number, m: number, s: number): Date =>
  new Date(2026, 8, 9, h, m, s);

/** 四标题齐备的合法编译输出（I2 后单节标题不再有效） */
const COMPILED_MD =
  "## 工作背景\na\n\n## 个人背景\nb\n\n## 当前关注\nc\n\n## 近期动态\nd";

describe("decideMemoryTick（spec §5.2）", () => {
  it("窗口内且当日未整理 → compile", () => {
    expect(decideMemoryTick({ ...base }, at(2, 30))).toBe("compile");
    expect(decideMemoryTick({ ...base }, at(3, 59))).toBe("compile");
  });
  it("窗口外 → noop", () => {
    expect(decideMemoryTick({ ...base }, at(1, 59))).toBe("noop");
    expect(decideMemoryTick({ ...base }, at(4, 0))).toBe("noop");
  });
  it("当日已整理 → noop", () => {
    const today = at(12).toISOString();
    expect(
      decideMemoryTick({ ...base, lastCompiledAt: today }, at(2, 30)),
    ).toBe("noop");
  });
  it("昨日整理 → 窗口内 compile", () => {
    const yesterday = new Date(2026, 8, 8, 3).toISOString();
    expect(
      decideMemoryTick({ ...base, lastCompiledAt: yesterday }, at(2, 30)),
    ).toBe("compile");
  });
  it("开关关 / 在途 → noop", () => {
    expect(decideMemoryTick({ ...base, enabled: false }, at(2, 30))).toBe(
      "noop",
    );
    expect(decideMemoryTick({ ...base, inflight: true }, at(2, 30))).toBe(
      "noop",
    );
  });
  it("补跑标志 + 从未整理 → catchUp", () => {
    expect(decideMemoryTick({ ...base, catchUpPending: true }, at(10))).toBe(
      "catchUp",
    );
  });
  it("补跑标志 + 距上次 <24h → noop", () => {
    const recent = new Date(at(10).getTime() - 12 * 3600 * 1000).toISOString();
    expect(
      decideMemoryTick(
        { ...base, catchUpPending: true, lastCompiledAt: recent },
        at(10),
      ),
    ).toBe("noop");
  });
  it("补跑标志 + 距上次 >24h → catchUp", () => {
    const old = new Date(at(10).getTime() - 25 * 3600 * 1000).toISOString();
    expect(
      decideMemoryTick(
        { ...base, catchUpPending: true, lastCompiledAt: old },
        at(10),
      ),
    ).toBe("catchUp");
  });
});

describe("失败退避（I1，spec §5.2 修订）", () => {
  const MIN = 60 * 1000;
  it("失败后 5 分钟（<10 分钟）→ noop：窗口内与补跑路径均被退避拦截", () => {
    const night = at(2, 30);
    expect(
      decideMemoryTick(
        { ...base, lastAttemptAt: night.getTime() - 5 * MIN },
        night,
      ),
    ).toBe("noop");
    const day = at(10);
    const old = new Date(day.getTime() - 25 * 3600 * 1000).toISOString();
    expect(
      decideMemoryTick(
        {
          ...base,
          catchUpPending: true,
          lastCompiledAt: old,
          lastAttemptAt: day.getTime() - 5 * MIN,
        },
        day,
      ),
    ).toBe("noop");
  });
  it("失败后 11 分钟（≥10 分钟）→ 可重试：窗口内 compile、补跑 catchUp", () => {
    const night = at(2, 30);
    expect(
      decideMemoryTick(
        { ...base, lastAttemptAt: night.getTime() - 11 * MIN },
        night,
      ),
    ).toBe("compile");
    const day = at(10);
    const old = new Date(day.getTime() - 25 * 3600 * 1000).toISOString();
    expect(
      decideMemoryTick(
        {
          ...base,
          catchUpPending: true,
          lastCompiledAt: old,
          lastAttemptAt: day.getTime() - 11 * MIN,
        },
        day,
      ),
    ).toBe("catchUp");
  });
});

describe("catchUp 消费语义（M4，spec §5.2 修订）", () => {
  it("启动未满 24h：90s 补跑评估即消费（不编译），当夜 02:00-04:00 窗口可触发 compile", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(atSeconds(1, 0, 0)); // 01:00：窗口外，90s 后补跑计时到点
      prismaStubs.optionRows.length = 0;
      prismaStubs.optionRows.push(
        { name: "personalization.memoryEnabled", value: "true" },
        {
          name: "personalization.memoryLastCompiledAt",
          value: new Date(2026, 8, 8, 13, 0, 0).toISOString(), // 12h 前：未满 24h
        },
      );
      compileMemoryMock.mockReset();
      compileMemoryMock.mockResolvedValue(COMPILED_MD);

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
          listAll: async () => [
            { id: 1, providerId: 1, modelId: "m1", enabled: true },
          ],
        },
      });
      scheduler.start();
      // 01:00:30 常规 tick：窗口外 noop；01:01:30 补跑计时到点评估：未满 24h
      // → 不编译，且 catchUp 标志被消费（否则夜间窗口分支被永久阻塞）
      await vi.advanceTimersByTimeAsync(90_000);
      expect(compileMemoryMock).not.toHaveBeenCalled();

      // 推进到当夜 02:00 之后：窗口内 + 当日未整理 → compile 恰好一次
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(compileMemoryMock).toHaveBeenCalledTimes(1);
      // 成功落库后（stub 回写 LastCompiledAt）当夜不再重复整理
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(compileMemoryMock).toHaveBeenCalledTimes(1);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

/** 运行时用例统一复位共享 stub（option 行清空 + 消息材料恢复默认一条） */
function resetRuntimeStubs() {
  prismaStubs.optionRows.length = 0;
  prismaStubs.messageRows.length = 0;
  prismaStubs.messageRows.push({
    id: 1,
    role: "user",
    blocks: JSON.stringify([{ type: "text", text: "对话材料" }]),
  });
}

/** 当前 memoryLastError 行值（缺行 = undefined） */
const memoryLastErrorValue = () =>
  prismaStubs.optionRows.find(
    (row) => row.name === "personalization.memoryLastError",
  )?.value;

function mkScheduler(
  listModels: () => Promise<
    Array<{ id: number; providerId: number; modelId: string; enabled: boolean }>
  > = async () => [{ id: 1, providerId: 1, modelId: "m1", enabled: true }],
) {
  return new MemoryScheduler({
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
      listAll: listModels,
    },
  });
}

describe("整理失败原因持久化（修订 A：memoryLastError）", () => {
  it("编译失败 → 失败原因写入 memoryLastError（超长截断 200），成功后清除", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(atSeconds(1, 0, 0)); // 01:00：90s 补跑计时到点
      resetRuntimeStubs();
      compileMemoryMock.mockReset();
      compileMemoryMock.mockRejectedValue(new Error("boom"));

      const scheduler = mkScheduler();
      scheduler.start();
      await vi.advanceTimersByTimeAsync(90_000); // 补跑 → run → 编译失败
      expect(compileMemoryMock).toHaveBeenCalledTimes(1);
      expect(memoryLastErrorValue()).toBe("记忆整理失败：boom");

      // 夜间窗口重试再失败（超长原因）：截断到 200 字
      compileMemoryMock.mockRejectedValue(new Error("x".repeat(300)));
      await vi.advanceTimersByTimeAsync(60 * 60_000); // → 02:01:30 窗口内
      expect(compileMemoryMock).toHaveBeenCalledTimes(2);
      const truncated = memoryLastErrorValue() ?? "";
      expect(truncated.startsWith("记忆整理失败：")).toBe(true);
      expect(truncated).toHaveLength(200);

      // 恢复成功 → 清除失败标记 + 落库 Profile/LastCompiledAt
      compileMemoryMock.mockResolvedValue(COMPILED_MD);
      await vi.advanceTimersByTimeAsync(10 * 60_000); // 退避期满窗口内重试
      expect(memoryLastErrorValue()).toBe("");
      expect(
        prismaStubs.optionRows.find(
          (row) => row.name === "personalization.memoryProfile",
        )?.value,
      ).toBe(COMPILED_MD);
      expect(
        prismaStubs.optionRows.find(
          (row) => row.name === "personalization.memoryLastCompiledAt",
        )?.value,
      ).toBeTruthy();
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("无对话材料早退 → 不写也不清 memoryLastError（跳过不算失败）", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(atSeconds(1, 0, 0));
      resetRuntimeStubs();
      prismaStubs.messageRows.length = 0; // 无对话材料
      prismaStubs.optionRows.push({
        name: "personalization.memoryLastError",
        value: "记忆整理失败：旧原因",
      });
      compileMemoryMock.mockReset();
      compileMemoryMock.mockResolvedValue(COMPILED_MD);

      const scheduler = mkScheduler();
      scheduler.start();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(compileMemoryMock).not.toHaveBeenCalled();
      expect(memoryLastErrorValue()).toBe("记忆整理失败：旧原因"); // 不清空
      expect(
        prismaStubs.optionRows.find(
          (row) => row.name === "personalization.memoryProfile",
        ),
      ).toBeUndefined(); // 未写 Profile / LastCompiledAt
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("无可用模型早退 → 不写也不清 memoryLastError", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(atSeconds(1, 0, 0));
      resetRuntimeStubs();
      prismaStubs.optionRows.push({
        name: "personalization.memoryLastError",
        value: "记忆整理失败：旧原因",
      });
      compileMemoryMock.mockReset();
      compileMemoryMock.mockResolvedValue(COMPILED_MD);

      const scheduler = mkScheduler(async () => []); // 无可用模型
      scheduler.start();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(compileMemoryMock).not.toHaveBeenCalled();
      expect(memoryLastErrorValue()).toBe("记忆整理失败：旧原因");
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
