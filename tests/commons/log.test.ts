/**
 * Log 参数归一：Error 的 message/stack 不可枚举，三个级别都必须特判——
 * 否则 JSON.stringify 输出 {}（曾致 memory-scheduler 的失败原因在日志丢失）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const stub = vi.hoisted(() => {
  const calls: Array<[level: string, message: string]> = [];
  return {
    calls,
    info: (m: string) => calls.push(["info", m]),
    warn: (m: string) => calls.push(["warn", m]),
    error: (m: string) => calls.push(["error", m]),
  };
});

vi.mock("winston", () => ({
  default: {
    createLogger: () => stub,
    format: { combine: vi.fn(), timestamp: vi.fn(), printf: vi.fn() },
    transports: {
      DailyRotateFile: class {},
      Console: class {},
    },
  },
}));
vi.mock("winston-daily-rotate-file", () => ({}));
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: vi.fn(() => "/tmp/tianshu-log-test") },
}));

import Log from "../../electron/commons/Log";

beforeEach(() => {
  stub.calls.length = 0;
});

describe("Log 各级别 Error 归一", () => {
  it("warn 传 Error 输出 name/message/stack（而非 {}）", () => {
    const boom = new Error("超时了");
    Log.warn("记忆整理失败（10 分钟后重试）", boom);
    const [level, message] = stub.calls[0];
    expect(level).toBe("warn");
    expect(message).toContain("Error: 超时了");
    expect(message).toContain("记忆整理失败");
    expect(message).not.toContain("{}");
  });
  it("info 传 Error 同样保留信息", () => {
    Log.info("ctx", new TypeError("bad type"));
    expect(stub.calls[0][1]).toContain("TypeError: bad type");
  });
  it("error 传 Error 保持既有行为（回归锚）", () => {
    Log.error("boom", new RangeError("out of range"));
    expect(stub.calls[0][1]).toContain("RangeError: out of range");
    expect(stub.calls[0][1]).toMatch(/at .*\(/); // 含 stack 帧
  });
});

describe("Log 普通值序列化", () => {
  it("对象输出 pretty JSON", () => {
    Log.info("state", { a: 1 });
    expect(stub.calls[0][1]).toContain('"a": 1');
  });
  it("原始值 String 化并拼接多参", () => {
    Log.warn("count:", 3, true);
    expect(stub.calls[0][1]).toBe("count: 3 true");
  });
  it("循环引用对象不抛错（回退 String）", () => {
    const cyc: Record<string, unknown> = { self: null };
    cyc.self = cyc;
    expect(() => Log.warn(cyc)).not.toThrow();
    expect(stub.calls[0][1]).toContain("Object");
  });
});
