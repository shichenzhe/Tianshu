import { beforeEach, describe, expect, it, vi } from "vitest";

// —— AsyncStorage 内存 Map 替身（node vitest 环境无 RN 原生模块，照 connections.store.test.ts 做法） ——
const storageMock = vi.hoisted(() => {
  const storage = new Map<string, string>();
  return {
    storage,
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      storage.set(key, value);
      return Promise.resolve();
    }),
  };
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: storageMock,
}));

// —— nativewind 替身（node 环境无 RN 运行时，真身入口含原生语法不可加载）——
vi.mock("nativewind", () => ({
  colorScheme: { set: vi.fn() },
  useColorScheme: () => ({
    colorScheme: "light" as const,
    setColorScheme: vi.fn(),
    toggleColorScheme: vi.fn(),
  }),
}));

describe("theme store 持久化", () => {
  beforeEach(() => {
    storageMock.storage.clear();
    storageMock.getItem.mockClear();
    storageMock.setItem.mockClear();
  });

  it("setTheme 更新 state 并同步发起 AsyncStorage 写", async () => {
    const { useThemeStore } = await import("./theme");
    useThemeStore.getState().setTheme("green");

    expect(useThemeStore.getState().themeName).toBe("green");
    expect(storageMock.setItem).toHaveBeenCalledWith(
      "tianshu-mobile.theme",
      "green",
    );
  });

  it("模块创建即从 AsyncStorage 恢复已持久化主题", async () => {
    storageMock.storage.set("tianshu-mobile.theme", "red");
    vi.resetModules();
    const { useThemeStore } = await import("./theme");

    await vi.waitFor(() =>
      expect(useThemeStore.getState().themeName).toBe("red"),
    );
  });

  it("持久化值为非法主题（如 purple）时忽略，保持 DEFAULT_THEME", async () => {
    storageMock.storage.set("tianshu-mobile.theme", "purple");
    vi.resetModules();
    const { useThemeStore } = await import("./theme");
    // setImmediate 让 getItem 的 .then 微任务链先行跑完再断言（waitFor 对恒真条件会秒过）
    await new Promise((resolve) => setImmediate(resolve));

    expect(useThemeStore.getState().themeName).toBe("blue");
  });
});
