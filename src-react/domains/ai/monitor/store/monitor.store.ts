// src-react/domains/ai/monitor/store/monitor.store.ts
/** 监控页场景筛选（spec §6）：all = 不过滤（IPC 不传 scene） */
import { create } from "zustand";
import type { MonitorScene } from "../api/monitor.api";

export type MonitorSceneFilter = MonitorScene | "all";

interface MonitorStore {
  scene: MonitorSceneFilter;
  setScene: (scene: MonitorSceneFilter) => void;
}

export const useMonitorStore = create<MonitorStore>((set) => ({
  scene: "all",
  setScene: (scene) => set({ scene }),
}));
