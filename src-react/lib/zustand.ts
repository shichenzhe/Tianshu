/**
 * Zustand Store 配置
 * 配置 persist 中间件，使用 localStorage 持久化
 */

import { createJSONStorage, persist } from "zustand/middleware";

/**
 * 默认持久化配置
 */
export const createPersistStore = <T>(
  storeName: string,
  storage = localStorage,
) => {
  return persist<T>((config: unknown) => config as T, {
    name: storeName,
    storage: createJSONStorage(() => storage),
    // 只持久化指定的状态
    partialize: (state: T) => {
      const all = state as Record<string, unknown>;
      const partialState: Record<string, unknown> = {};
      Object.keys(all).forEach((key) => {
        // 排除以 _ 开头的私有状态
        if (!key.startsWith("_")) {
          partialState[key] = all[key];
        }
      });
      return partialState as T;
    },
  });
};
