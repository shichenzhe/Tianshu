// @vitest-environment jsdom
/**
 * 皮肤状态 store 测试（jsdom：localStorage + documentElement）：
 * - 持久化迁移：旧 {theme:"green"}（v0 / 无 version 字段）→ {skin:"light", hue:"green"}
 * - 未知皮肤 id：setSkin/applySkin 均回落 light + console.warn 一次（同 id 去重）
 * - setSkin：皮肤完整预设——写全三元组（含皮肤自带 hue；无装饰皮肤移除 data-wallpaper）
 * - setHue：正交微调——仅 data-theme 变，mode/wallpaper/skin 不动
 * - applySkin：documentElement 三属性一次写入
 * - useThemeStore 兼容层：{ theme: hue, setTheme: setHue } 适配视图
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

// localStorage stub：与 tests/app-settings/font-scale.test.ts 同款内存
// stub（Node 26 无 --localstorage-file 时原生全局访问会向 stderr打
// ExperimentalWarning，先行替换消除噪音；skin.store 在模块加载期即创建
// persist store 读写 localStorage）
vi.hoisted(() => {
  const memory = new Map<string, string>();
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => void memory.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
});

import {
  applySkin,
  initSkin,
  useSkinStore,
} from "../../src-react/stores/skin.store";
import { useThemeStore } from "../../src-react/stores/theme.store";

const root = () => document.documentElement;

beforeEach(() => {
  localStorage.clear();
  delete root().dataset.mode;
  delete root().dataset.theme;
  delete root().dataset.wallpaper;
  useSkinStore.setState({ skin: "light", hue: "orange" });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("持久化迁移", () => {
  it("旧结构 {theme:'green'}（version 0）→ skin light + hue green", async () => {
    localStorage.setItem(
      "tianshu-theme",
      JSON.stringify({ state: { theme: "green" }, version: 0 }),
    );
    await useSkinStore.persist.rehydrate();
    const { skin, hue } = useSkinStore.getState();
    expect(skin).toBe("light");
    expect(hue).toBe("green");
  });

  it("无 version 字段旧数据同样走迁移", async () => {
    localStorage.setItem(
      "tianshu-theme",
      JSON.stringify({ state: { theme: "red" } }),
    );
    await useSkinStore.persist.rehydrate();
    const { skin, hue } = useSkinStore.getState();
    expect(skin).toBe("light");
    expect(hue).toBe("red");
  });

  it("同版本脏数据（未知 skin / 非法 hue）归一回落默认", async () => {
    localStorage.setItem(
      "tianshu-theme",
      JSON.stringify({ state: { skin: "bogus", hue: "purple" }, version: 1 }),
    );
    await useSkinStore.persist.rehydrate();
    const { skin, hue } = useSkinStore.getState();
    expect(skin).toBe("light");
    expect(hue).toBe("orange");
  });

  it("setSkin 持久化 partialize 后的 {skin,hue}（version 1）", () => {
    useSkinStore.getState().setSkin("dusk");
    expect(JSON.parse(localStorage.getItem("tianshu-theme") ?? "{}")).toEqual({
      state: { skin: "dusk", hue: "orange" },
      version: 1,
    });
  });
});

describe("未知皮肤 id 回落", () => {
  it("setSkin('bogus')：store 回落 light + data-mode light，warn 一次且同 id 去重", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useSkinStore.getState().setSkin("bogus");
    expect(useSkinStore.getState().skin).toBe("light");
    expect(root().dataset.mode).toBe("light");
    expect(warn).toHaveBeenCalledTimes(1);
    useSkinStore.getState().setSkin("bogus");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("applySkin('nope')：三属性按 light 回落（hue 参数原样保留）", () => {
    applySkin("nope", "green");
    expect(root().dataset.mode).toBe("light");
    expect(root().dataset.theme).toBe("green");
    expect(root().dataset.wallpaper).toBeUndefined();
  });
});

describe("setSkin 写全三元组", () => {
  it("setSkin('dark')：mode dark + 自带 hue blue + 移除壁纸属性", () => {
    root().setAttribute("data-wallpaper", "ripple"); // 预置壁纸验证清除
    useSkinStore.getState().setSkin("dark");
    expect(useSkinStore.getState()).toMatchObject({
      skin: "dark",
      hue: "blue",
    });
    expect(root().dataset.mode).toBe("dark");
    expect(root().dataset.theme).toBe("blue");
    expect(root().dataset.wallpaper).toBeUndefined();
  });

  it("setSkin('ripple')：三属性齐（light/blue/ripple）且 hue 同步皮肤自带", () => {
    useSkinStore.getState().setSkin("ripple");
    expect(root().dataset.mode).toBe("light");
    expect(root().dataset.theme).toBe("blue");
    expect(root().dataset.wallpaper).toBe("ripple");
    expect(useSkinStore.getState().hue).toBe("blue");
  });
});

describe("setHue 正交微调", () => {
  it("setHue('red')：仅 data-theme 变，mode/wallpaper/skin 不动", () => {
    useSkinStore.getState().setSkin("ripple");
    useSkinStore.getState().setHue("red");
    expect(root().dataset.mode).toBe("light");
    expect(root().dataset.theme).toBe("red");
    expect(root().dataset.wallpaper).toBe("ripple");
    expect(useSkinStore.getState()).toMatchObject({
      skin: "ripple",
      hue: "red",
    });
  });
});

describe("applySkin 直接调用", () => {
  it("documentElement 三属性一次写入（hue 与皮肤正交组合）", () => {
    applySkin("ink", "red");
    expect(root().dataset.mode).toBe("dark");
    expect(root().dataset.theme).toBe("red");
    expect(root().dataset.wallpaper).toBe("ink");
  });
});

describe("initSkin 启动初始化", () => {
  it("旧 v0 数据 {theme:'green'} → light + green 落 DOM", () => {
    localStorage.setItem(
      "tianshu-theme",
      JSON.stringify({ state: { theme: "green" }, version: 0 }),
    );
    initSkin();
    expect(root().dataset.mode).toBe("light");
    expect(root().dataset.theme).toBe("green");
    expect(root().dataset.wallpaper).toBeUndefined();
  });

  it("新 v1 数据 {skin:'pine',hue:'red'} → 三属性落 DOM", () => {
    localStorage.setItem(
      "tianshu-theme",
      JSON.stringify({ state: { skin: "pine", hue: "red" }, version: 1 }),
    );
    initSkin();
    expect(root().dataset.mode).toBe("dark");
    expect(root().dataset.theme).toBe("red");
    expect(root().dataset.wallpaper).toBe("pine");
  });

  it("无存储回落默认（light + orange）", () => {
    initSkin();
    expect(root().dataset.mode).toBe("light");
    expect(root().dataset.theme).toBe("orange");
  });
});

describe("useThemeStore 兼容层", () => {
  it("theme 映射 hue、setTheme 映射 setHue（正交换 data-theme 不动 mode）", () => {
    const { result } = renderHook(() => useThemeStore());
    expect(result.current.theme).toBe("orange");
    act(() => result.current.setTheme("green"));
    expect(result.current.theme).toBe("green");
    expect(root().dataset.theme).toBe("green");
    expect(useSkinStore.getState().hue).toBe("green");
    expect(useSkinStore.getState().skin).toBe("light");
    expect(root().dataset.mode).toBe("light");
  });
});
