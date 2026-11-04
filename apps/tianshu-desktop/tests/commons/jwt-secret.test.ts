import { describe, expect, it, vi } from "vitest";

// electron mock 仅满足 import（jwt-secret 传递依赖）；secret 路径经
// commons/paths，数据根已由 tests/setup.ts 全局重定向到临时目录，
// 密钥落盘不会写真实 ~/.tianshu
vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => "/tmp" },
}));

import {
  getJwtSecret,
  resetJwtSecretCache,
} from "../../electron/commons/jwt-secret";

describe("jwt-secret", () => {
  it("生成的密钥具备足够熵（≥32 字符）且不含硬编码旧值", () => {
    const secret = getJwtSecret();
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(secret).not.toBe("3k4jl234jl2kj23423j");
  });

  it("进程内重复取值稳定（单例），清缓存后重新加载仍为同一持久化值", () => {
    const first = getJwtSecret();
    expect(getJwtSecret()).toBe(first);
    resetJwtSecretCache();
    expect(getJwtSecret()).toBe(first);
  });
});
