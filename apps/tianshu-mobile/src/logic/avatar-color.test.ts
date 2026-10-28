import { describe, expect, it } from "vitest";

import {
  AVATAR_THEME_ORDER,
  avatarInitial,
  avatarThemeIndex,
  hashSeed,
} from "./avatar-color";

describe("avatar-color（微信范式头像批）", () => {
  it("hashSeed 稳定且非负（djb2）", () => {
    expect(hashSeed("42")).toBe(hashSeed("42"));
    expect(hashSeed("42")).toBeGreaterThanOrEqual(0);
    expect(hashSeed("a")).not.toBe(hashSeed("b"));
  });

  it("avatarThemeIndex 恒落在四主题范围内", () => {
    for (const seed of ["1", "42", "hello", "工作空间甲", ""]) {
      const idx = avatarThemeIndex(seed);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(AVATAR_THEME_ORDER.length);
    }
  });

  it("avatarInitial 取首字符大写，空标题兜底问号", () => {
    expect(avatarInitial("周报助手")).toBe("周");
    expect(avatarInitial("  abc")).toBe("A");
    expect(avatarInitial(null)).toBe("?");
    expect(avatarInitial("   ")).toBe("?");
  });

  it("avatarInitial 按 Unicode 字素取首字符", () => {
    expect(avatarInitial("🔧 Diagnostics")).toBe("🔧");
  });
});
