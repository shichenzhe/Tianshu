// @vitest-environment jsdom
/**
 * 字体缩放模型测试（jsdom：localStorage + document）：
 * - readFontScale：缺失/非法值回退 default，合法值原样读出
 * - applyFontScale：三档即时改 html fontSize 并持久化
 * - initFontScale：启动按持久化档位恢复，非法存储回退默认档
 * - stepFontScale：zoomIn/zoomOut 快捷键的三档递进与越界钳制
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// localStorage stub：与 tests/ai/chat-view-edit-optimistic.test.tsx 同款内存
// stub（Node 26 无 --localstorage-file 时原生全局访问会向 stderr 打
// ExperimentalWarning，先行替换消除噪音）
vi.hoisted(() => {
  const memory = new Map<string, string>();
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
});

import {
  applyFontScale,
  initFontScale,
  readFontScale,
  stepFontScale,
} from "../../src-react/domains/app-settings/model/font-scale";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.style.fontSize = "";
});

describe("readFontScale", () => {
  it("无存储与非法值均回退 default", () => {
    expect(readFontScale()).toBe("default");
    localStorage.setItem("tianshu-font-scale", "huge");
    expect(readFontScale()).toBe("default");
  });

  it("合法档位原样读出", () => {
    localStorage.setItem("tianshu-font-scale", "small");
    expect(readFontScale()).toBe("small");
  });
});

describe("applyFontScale", () => {
  it("三档即时改 html fontSize 并持久化", () => {
    applyFontScale("small");
    expect(document.documentElement.style.fontSize).toBe("14px");
    expect(localStorage.getItem("tianshu-font-scale")).toBe("small");
    applyFontScale("default");
    expect(document.documentElement.style.fontSize).toBe("16px");
    expect(localStorage.getItem("tianshu-font-scale")).toBe("default");
    applyFontScale("large");
    expect(document.documentElement.style.fontSize).toBe("18px");
    expect(localStorage.getItem("tianshu-font-scale")).toBe("large");
  });
});

describe("initFontScale", () => {
  it("按持久化档位恢复 html fontSize", () => {
    localStorage.setItem("tianshu-font-scale", "small");
    initFontScale();
    expect(document.documentElement.style.fontSize).toBe("14px");
  });

  it("非法存储回退默认档（16px）", () => {
    localStorage.setItem("tianshu-font-scale", "giant");
    initFontScale();
    expect(document.documentElement.style.fontSize).toBe("16px");
    expect(localStorage.getItem("tianshu-font-scale")).toBe("default");
  });
});

describe("stepFontScale（字号快捷键递进）", () => {
  it("递增：small→default→large，large 越界保持", () => {
    expect(stepFontScale("small", 1)).toBe("default");
    expect(stepFontScale("default", 1)).toBe("large");
    expect(stepFontScale("large", 1)).toBe("large");
  });

  it("递减：large→default→small，small 越界保持", () => {
    expect(stepFontScale("large", -1)).toBe("default");
    expect(stepFontScale("default", -1)).toBe("small");
    expect(stepFontScale("small", -1)).toBe("small");
  });
});
