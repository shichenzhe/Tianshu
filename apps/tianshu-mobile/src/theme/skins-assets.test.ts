/**
 * 皮肤壁纸资产模块（UI 层）：四款 id → require 源映射齐备、
 * resolveSkinWallpaper 纯函数（null/未知回落 null、命中带 scrim）。
 * jpg 走 vi.mock 拦截（node 环境无法解析二进制资产，真图打包由
 * metro 资产通道保障——node 单测只测映射与回落逻辑）。
 */
import { describe, expect, it, vi } from "vitest";

// store/theme（经 useThemeStore）顶层读 AsyncStorage、依赖 nativewind——
// node 环境双防线 mock（同 theme.store.test.ts 做法；config alias 的
// nativewind stub 对动态图不总生效，见 src/testing/nativewind.ts 头注释）
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

vi.mock("nativewind", () => ({
  colorScheme: { set: vi.fn() },
  useColorScheme: () => ({
    colorScheme: "light" as const,
    setColorScheme: vi.fn(),
    toggleColorScheme: vi.fn(),
  }),
}));

vi.mock("../../assets/skins/ripple.jpg", () => ({ default: 101 }));
vi.mock("../../assets/skins/ocean-sky.jpg", () => ({ default: 102 }));
vi.mock("../../assets/skins/warm-sand.jpg", () => ({ default: 103 }));
vi.mock("../../assets/skins/ink.jpg", () => ({ default: 104 }));

import {
  SKIN_WALLPAPERS,
  resolveSkinWallpaper,
  resolveWallpaperScrim,
} from "../theme/skins-assets";

describe("resolveWallpaperScrim（明暗档兜底纱）", () => {
  it("浅色档用皮肤自带纱", () => {
    expect(resolveWallpaperScrim("hsla(1, 2%, 3%, 0.5)", "light")).toBe(
      "hsla(1, 2%, 3%, 0.5)",
    );
  });

  it("深色档统一黑纱（浅色系皮肤被手动改暗后保浅字可读）", () => {
    expect(resolveWallpaperScrim("hsla(178, 22%, 98%, 0.55)", "dark")).toBe(
      "hsla(222, 16%, 7%, 0.62)",
    );
  });
});

describe("SKIN_WALLPAPERS 映射", () => {
  it("四款皮肤 id 各有壁纸源（非空）", () => {
    for (const id of ["ripple", "ocean-sky", "warm-sand", "ink"] as const) {
      expect(SKIN_WALLPAPERS[id]).toBeTruthy();
    }
  });
});

describe("resolveSkinWallpaper", () => {
  it("null（纯色主题）→ null", () => {
    expect(resolveSkinWallpaper(null)).toBeNull();
  });

  it("命中皮肤 → 壁纸源 + 纱层色（墨韵深色纱）", () => {
    const wp = resolveSkinWallpaper("ink");
    expect(wp).not.toBeNull();
    expect(wp?.source).toBeTruthy();
    expect(wp?.scrim).toMatch(/^hsla\(/);
  });
});
