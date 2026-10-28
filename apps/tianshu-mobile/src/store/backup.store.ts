import { create } from "zustand";
import type { BackupMeta, BackupProgressPayload } from "@tianshu/protocol";

import { activeTransport, subscribeTransportEvents } from "./connections.store";
import {
  backupCreate,
  backupDelete,
  backupList,
} from "../transport/backup-api";

/**
 * 备份面批 store：列表 + 触发状态机（202 受理 → backup.progress 事件流
 * 推进度 → done 终态帧复位并重拉列表 + lastError 透出）。防迟到独立
 * 序号；事件订阅 App 级单份（bindEvents 幂等——orchestration 同款）。
 */
interface BackupStoreState {
  backups: BackupMeta[];
  loading: boolean;
  /** 触发受理后 true，终态帧复位 */
  creating: boolean;
  /** 当前进度帧（终态后保留供展示直至下次触发/清空） */
  progress: BackupProgressPayload | null;
  /** 终态帧 error（成功为 null；页面 toast 后清空由页面自理） */
  lastError: string | null;
  load(): Promise<void>;
  trigger(note: string | undefined): Promise<boolean>;
  remove(backupId: string): Promise<boolean>;
  clearLastError(): void;
  bindEvents(): void;
}

let backupSeq = 0;
let eventsBound = false;

export const useBackupStore = create<BackupStoreState>((set, get) => ({
  backups: [],
  loading: false,
  creating: false,
  progress: null,
  lastError: null,

  load: async () => {
    if (activeTransport() === null) {
      set({ backups: [], loading: false });
      return;
    }
    const token = ++backupSeq;
    set({ loading: true });
    const r = await backupList();
    if (token !== backupSeq) return;
    set({ backups: r.ok ? r.data : [], loading: false });
  },

  trigger: async (note) => {
    if (get().creating) return false;
    const r = await backupCreate(note);
    if (r.ok) {
      // 受理即置进行态（packing 首帧由事件流补齐）；失败直接回错
      set({ creating: true, progress: null, lastError: null });
      return true;
    }
    set({ lastError: r.message || "" });
    return false;
  },

  remove: async (backupId) => {
    const r = await backupDelete(backupId);
    if (r.ok) {
      set((s) => ({
        backups: s.backups.filter((meta) => meta.id !== backupId),
      }));
    }
    return r.ok;
  },

  clearLastError: () => set({ lastError: null }),

  bindEvents: () => {
    if (eventsBound) return;
    eventsBound = true;
    subscribeTransportEvents((event) => {
      if (event.type !== "backup.progress") return;
      const payload = event.payload;
      if (payload.done) {
        // 终态帧：复位进行态；成功重拉列表，失败透 error
        set({
          creating: false,
          lastError: payload.error ?? null,
        });
        if (!payload.error) void get().load();
        return;
      }
      set({ progress: payload, creating: true });
    });
  },
}));
