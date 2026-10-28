import { create } from "zustand";
import type { MemoryServiceResult, MemoryState } from "@tianshu/protocol";

import { activeTransport } from "./connections.store";
import {
  memoryApplyInstruction,
  memoryCompile,
  memoryGet,
  memorySaveConfig,
  memorySaveProfile,
} from "../transport/memory-api";

/**
 * 记忆进化批 store：state 聚合 + 写面回参覆写 + AI 操作（busy 单槽——
 * 指令/整理共享在途互斥，face 侧 MEMORY_BUSY 兜底并发）。防迟到：load
 * 独立序号（资源隔离铁律——与 graphs/tasks 互不判过期）。
 */
interface MemoryStoreState {
  state: MemoryState | null;
  loading: boolean;
  /** 指令/整理共享 busy 槽（null = 空闲） */
  busy: "instruction" | "compile" | null;
  load(): Promise<void>;
  saveConfig(payload: {
    enabled?: boolean;
    modelId?: number | null;
  }): Promise<boolean>;
  saveProfile(profile: string): Promise<boolean>;
  applyInstruction(instruction: string): Promise<MemoryServiceResult>;
  compile(): Promise<MemoryServiceResult>;
}

let memorySeq = 0;

export const useMemoryStore = create<MemoryStoreState>((set, get) => ({
  state: null,
  loading: false,
  busy: null,

  load: async () => {
    if (activeTransport() === null) {
      set({ state: null, loading: false });
      return;
    }
    const token = ++memorySeq;
    set({ loading: true });
    const r = await memoryGet();
    if (token !== memorySeq) return;
    set({ state: r.ok ? r.data : null, loading: false });
  },

  saveConfig: async (payload) => {
    const r = await memorySaveConfig(payload);
    if (r.ok) set({ state: r.data });
    return r.ok;
  },

  saveProfile: async (profile) => {
    const r = await memorySaveProfile(profile);
    if (r.ok) set({ state: r.data });
    return r.ok;
  },

  applyInstruction: async (instruction) => {
    if (get().busy !== null) {
      return { ok: false, error: "MEMORY_BUSY" };
    }
    set({ busy: "instruction" });
    const r = await memoryApplyInstruction(instruction);
    set({ busy: null });
    if (r.ok && r.data.ok) {
      // 成功：画像回参覆写（face 侧已落库）
      const current = get().state;
      if (current !== null) {
        set({
          state: { ...current, profile: r.data.memory ?? current.profile },
        });
      }
    }
    return r.ok ? r.data : { ok: false, error: "MEMORY_COMPILE_FAILED" };
  },

  compile: async () => {
    if (get().busy !== null) {
      return { ok: false, error: "MEMORY_BUSY" };
    }
    set({ busy: "compile" });
    const r = await memoryCompile();
    set({ busy: null });
    if (r.ok && r.data.ok) {
      const current = get().state;
      if (current !== null) {
        set({
          state: { ...current, profile: r.data.memory ?? current.profile },
        });
      }
    }
    return r.ok ? r.data : { ok: false, error: "MEMORY_COMPILE_FAILED" };
  },
}));
