import { describe, expect, it, vi } from "vitest";

// 工厂内一次性生成随机目录（闭包固定）：并行测试文件互不共享密钥文件
vi.mock("electron", () => {
  const dir = `/tmp/tianshu-jwt-secret-test-${Math.random()
    .toString(36)
    .slice(2)}`;
  return { app: { getPath: () => dir } };
});

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
