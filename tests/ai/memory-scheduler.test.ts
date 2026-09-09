/**
 * memory-scheduler 决策纯函数单测（spec §5.2）：整理窗口 / 当日已整理 /
 * 补跑条件 / 开关 / inflight 互斥。scheduler 模块顶层 import memory-compiler
 * （→ prisma-client/Log）在 vitest node 环境即崩——照 memory-compiler.test
 * 先例先 mock electron 与 prisma-client 两个基建模块，仅测纯函数。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  // Log 模块顶层读取 app.getPath("userData") 计算日志目录
  app: { getPath: vi.fn(() => "/tmp/tianshu-test-user-data") },
}));

// 屏蔽 prisma-client 模块初始化对 electron app 路径的依赖（既有模式）
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {},
}));

import { decideMemoryTick } from "../../electron/domains/ai/personalization/memory-scheduler";

const base = {
  enabled: true,
  inflight: false,
  lastCompiledAt: "",
  catchUpPending: false,
};

const at = (h: number, m = 0): Date => new Date(2026, 8, 9, h, m);

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
