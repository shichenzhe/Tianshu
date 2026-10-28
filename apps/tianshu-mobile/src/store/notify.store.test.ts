import { beforeEach, describe, expect, it, vi } from "vitest";

// —— AsyncStorage 内存 Map 替身（node vitest 环境无 RN 原生模块，照 theme.store.test.ts 做法） ——
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

describe("notify store 持久化", () => {
  beforeEach(() => {
    storageMock.storage.clear();
    storageMock.getItem.mockClear();
    storageMock.setItem.mockClear();
  });

  it("setPrefs 局部更新 state 并整体写档（白名单三键 JSON）", async () => {
    const { useNotifyStore } = await import("./notify.store");
    useNotifyStore.getState().setPrefs({ enabled: true, graphDone: false });

    const s = useNotifyStore.getState();
    expect(s.enabled).toBe(true);
    expect(s.graphDone).toBe(false);
    expect(s.approvals).toBe(true); // 未触碰字段保持默认
    expect(storageMock.setItem).toHaveBeenCalledWith(
      "tianshu-mobile.notify",
      JSON.stringify({ enabled: true, approvals: true, graphDone: false }),
    );
  });

  it("模块创建即从 AsyncStorage 恢复：白名单字段生效，缺席保持默认、注入字段忽略", async () => {
    storageMock.storage.set(
      "tianshu-mobile.notify",
      JSON.stringify({ enabled: true, graphDone: false, evil: "inject" }),
    );
    vi.resetModules();
    const { useNotifyStore } = await import("./notify.store");
    // setImmediate 让 getItem 的 .then 微任务链先行跑完再断言（waitFor 对恒真条件会秒过）
    await new Promise((resolve) => setImmediate(resolve));

    const s = useNotifyStore.getState();
    expect(s.enabled).toBe(true); // 恢复档字段
    expect(s.graphDone).toBe(false);
    expect(s.approvals).toBe(true); // 缺席保持默认
    expect("evil" in s).toBe(false); // 注入字段不入 state
  });
});
