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
    removeItem: vi.fn((key: string) => {
      storage.delete(key);
      return Promise.resolve();
    }),
  };
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: storageMock,
}));

// —— nativewind 替身（node 环境无 RN 运行时，真身入口含原生语法不可加载）——
const colorSchemeSetMock = vi.hoisted(() => vi.fn());
vi.mock("nativewind", () => ({
  colorScheme: { set: colorSchemeSetMock },
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
    storageMock.removeItem.mockClear();
    colorSchemeSetMock.mockClear();
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

describe("theme store 精选皮肤（setSkin 三联动）", () => {
  beforeEach(() => {
    storageMock.storage.clear();
    storageMock.getItem.mockClear();
    storageMock.setItem.mockClear();
    storageMock.removeItem.mockClear();
    colorSchemeSetMock.mockClear();
  });

  it("setSkin 墨韵：skinId/hue/mode 三联动 + colorScheme.set 施加深色 + 三 key 持久化", async () => {
    const { useThemeStore } = await import("./theme");
    useThemeStore.getState().setSkin("ink");

    const state = useThemeStore.getState();
    expect(state.skinId).toBe("ink");
    expect(state.themeName).toBe("blue");
    expect(state.mode).toBe("dark");
    expect(colorSchemeSetMock).toHaveBeenCalledWith("dark");
    expect(storageMock.setItem).toHaveBeenCalledWith(
      "tianshu-mobile.skin",
      "ink",
    );
    expect(storageMock.setItem).toHaveBeenCalledWith(
      "tianshu-mobile.theme",
      "blue",
    );
    expect(storageMock.setItem).toHaveBeenCalledWith(
      "tianshu-mobile.mode",
      "dark",
    );
  });

  it("setSkin 涟漪：hue 覆写为 orange、mode 为 light", async () => {
    const { useThemeStore } = await import("./theme");
    useThemeStore.getState().setSkin("ripple");

    const state = useThemeStore.getState();
    expect(state.skinId).toBe("ripple");
    expect(state.themeName).toBe("orange");
    expect(state.mode).toBe("light");
  });

  it("选纯色主题退出皮肤：setTheme 清 skinId 并移除皮肤存档", async () => {
    const { useThemeStore } = await import("./theme");
    useThemeStore.getState().setSkin("ink");
    useThemeStore.getState().setTheme("red");

    const state = useThemeStore.getState();
    expect(state.skinId).toBeNull();
    expect(state.themeName).toBe("red");
    expect(storageMock.removeItem).toHaveBeenCalledWith("tianshu-mobile.skin");
  });

  it("setSkin 未知 id（防御）：state 不变不写档", async () => {
    const { useThemeStore } = await import("./theme");
    expect(() =>
      useThemeStore.getState().setSkin("dawn-mist" as never),
    ).not.toThrow();
    expect(useThemeStore.getState().skinId).toBeNull();
  });
});

describe("theme store 皮肤档恢复", () => {
  beforeEach(() => {
    storageMock.storage.clear();
    storageMock.getItem.mockClear();
    storageMock.setItem.mockClear();
    storageMock.removeItem.mockClear();
    colorSchemeSetMock.mockClear();
  });

  it("skin 存档整体生效：skinId/hue/mode 随皮肤恢复并施加深色", async () => {
    // 模拟 setSkin 全写后的存档形态（skin + theme + mode 三 key）
    storageMock.storage.set("tianshu-mobile.skin", "ink");
    storageMock.storage.set("tianshu-mobile.theme", "blue");
    storageMock.storage.set("tianshu-mobile.mode", "dark");
    vi.resetModules();
    const { useThemeStore } = await import("./theme");
    await new Promise((resolve) => setImmediate(resolve));

    const state = useThemeStore.getState();
    expect(state.skinId).toBe("ink");
    expect(state.themeName).toBe("blue");
    expect(state.mode).toBe("dark");
    expect(colorSchemeSetMock).toHaveBeenCalledWith("dark");
  });

  it("skin 存档优先于 theme/mode 存档（皮肤整体生效，hue/mode 随皮肤）", async () => {
    // 场景：上次会话皮肤涟漪生效后用户又手动调过明暗档（mode=dark 残留）
    storageMock.storage.set("tianshu-mobile.skin", "ripple");
    storageMock.storage.set("tianshu-mobile.theme", "orange");
    storageMock.storage.set("tianshu-mobile.mode", "dark");
    vi.resetModules();
    const { useThemeStore } = await import("./theme");
    await new Promise((resolve) => setImmediate(resolve));

    const state = useThemeStore.getState();
    expect(state.skinId).toBe("ripple");
    expect(state.mode).toBe("light");
  });

  it("skin 存档非法值（dawn-mist）忽略：回落纯色路径恢复 theme 档", async () => {
    storageMock.storage.set("tianshu-mobile.skin", "dawn-mist");
    storageMock.storage.set("tianshu-mobile.theme", "green");
    vi.resetModules();
    const { useThemeStore } = await import("./theme");
    await new Promise((resolve) => setImmediate(resolve));

    const state = useThemeStore.getState();
    expect(state.skinId).toBeNull();
    expect(state.themeName).toBe("green");
  });
});
