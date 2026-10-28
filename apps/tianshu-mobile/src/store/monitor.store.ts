import { create } from "zustand";
import {
  ENDPOINTS,
  type MonitorScene,
  type MonitorStats,
} from "@tianshu/protocol";

import { activeTransport } from "./connections.store";
import type { TransportRequestResult } from "../transport/types";

export type MonitorSceneFilter = MonitorScene | "all";

interface MonitorState {
  scene: MonitorSceneFilter;
  stats: MonitorStats | null;
  loading: boolean;
  error: string | null;
  load(scene?: MonitorSceneFilter): Promise<void>;
}

let loadSeq = 0;

/** 桌面用量监控只读面：scene 随 load 切换并立即重拉，迟到响应不得覆盖新场景。 */
export const useMonitorStore = create<MonitorState>((set, get) => ({
  scene: "all",
  stats: null,
  loading: false,
  error: null,

  load: async (scene = get().scene) => {
    const token = ++loadSeq;
    set({ scene, loading: true, error: null });
    const transport = activeTransport();
    if (!transport) {
      if (token === loadSeq) {
        set({ stats: null, loading: false, error: "loadFailed" });
      }
      return;
    }
    try {
      const result: TransportRequestResult = await transport.request(
        "POST",
        ENDPOINTS.monitor.stats,
        scene === "all" ? {} : { scene },
      );
      if (token !== loadSeq) return;
      const body =
        typeof result.body === "object" && result.body !== null
          ? (result.body as { success?: unknown; data?: unknown })
          : null;
      if (
        body?.success !== true ||
        typeof body.data !== "object" ||
        body.data === null ||
        Array.isArray(body.data)
      ) {
        set({ stats: null, loading: false, error: "loadFailed" });
        return;
      }
      set({ stats: body.data as MonitorStats, loading: false, error: null });
    } catch {
      if (token === loadSeq) {
        set({ stats: null, loading: false, error: "loadFailed" });
      }
    }
  },
}));
