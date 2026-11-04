import { describe, expect, it } from "vitest";

import {
  hashPassword,
  isHashedPassword,
  verifyPassword,
} from "../../../electron/domains/user/password";

describe("password", () => {
  it("哈希后不含明文，格式可识别", () => {
    const hashed = hashPassword("s3cret-密码");
    expect(hashed).not.toContain("s3cret");
    expect(isHashedPassword(hashed)).toBe(true);
    expect(isHashedPassword("s3cret-密码")).toBe(false);
  });

  it("verifyPassword：正确明文通过、错误明文拒绝", () => {
    const hashed = hashPassword("s3cret-密码");
    expect(verifyPassword("s3cret-密码", hashed)).toBe(true);
    expect(verifyPassword("wrong", hashed)).toBe(false);
  });

  it("同明文两次哈希盐不同（存储串不同）", () => {
    expect(hashPassword("abc")).not.toBe(hashPassword("abc"));
  });

  it("存量明文兼容：明文形态直接等值比对（迁移路径）", () => {
    expect(verifyPassword("legacy", "legacy")).toBe(true);
    expect(verifyPassword("legacy", "other")).toBe(false);
  });

  it("损坏的哈希串拒绝而非抛错", () => {
    expect(verifyPassword("abc", "scrypt$broken")).toBe(false);
    expect(verifyPassword("abc", "scrypt$a$b$c$d$e")).toBe(false);
  });
});
