// src-react/domains/ai/automation/store/automation.store.ts
/**
 * 自动化视图状态(内存态,zustand;来源/状态/搜索过滤在前端,
 * spec §5:SQLite 数据量小,分类计数由过滤结果派生)。
 */
import { create } from "zustand";
import type { TaskRecord } from "../api/automation.api";

export type SourceFilter = "all" | "local" | "project" | "cloud";
export type StatusFilter = "all" | "running" | "paused" | "error" | "expired";

/** 纯过滤:cloud 无服务端支撑恒空(spec §0 决策) */
export function filterTasks(
  tasks: TaskRecord[],
  source: SourceFilter,
  status: StatusFilter,
  search: string,
): TaskRecord[] {
  return tasks.filter((task) => {
    if (source === "cloud") {
      return false;
    }
    if (source !== "all" && task.source !== source) {
      return false;
    }
    if (status === "running" && !(task.enabled && task.status === "active")) {
      return false;
    }
    if (status === "paused" && (task.enabled || task.status !== "active")) {
      return false;
    }
    if (status === "error" && task.status !== "error") {
      return false;
    }
    if (status === "expired" && task.status !== "expired") {
      return false;
    }
    if (search && !task.name.toLowerCase().includes(search.toLowerCase())) {
      return false;
    }
    return true;
  });
}

interface AutomationState {
  tab: "tasks" | "runs";
  view: "list" | "market";
  sourceFilter: SourceFilter;
  statusFilter: StatusFilter;
  search: string;
  batchMode: boolean;
  selectedIds: number[];
  setTab: (tab: "tasks" | "runs") => void;
  setView: (view: "list" | "market") => void;
  setSourceFilter: (f: SourceFilter) => void;
  setStatusFilter: (f: StatusFilter) => void;
  setSearch: (s: string) => void;
  enterBatchMode: () => void;
  exitBatchMode: () => void;
  toggleSelected: (id: number) => void;
  selectAll: (ids: number[]) => void;
}

export const useAutomationStore = create<AutomationState>((set) => ({
  tab: "tasks",
  view: "list",
  sourceFilter: "all",
  statusFilter: "all",
  search: "",
  batchMode: false,
  selectedIds: [],
  setTab: (tab) => set({ tab }),
  setView: (view) => set({ view }),
  setSourceFilter: (sourceFilter) => set({ sourceFilter }),
  setStatusFilter: (statusFilter) => set({ statusFilter }),
  setSearch: (search) => set({ search }),
  enterBatchMode: () => set({ batchMode: true, selectedIds: [] }),
  exitBatchMode: () => set({ batchMode: false, selectedIds: [] }),
  toggleSelected: (id) =>
    set((state) => ({
      selectedIds: state.selectedIds.includes(id)
        ? state.selectedIds.filter((x) => x !== id)
        : [...state.selectedIds, id],
    })),
  selectAll: (ids) =>
    set((state) => ({
      selectedIds: state.selectedIds.length === ids.length ? [] : ids,
    })),
}));
