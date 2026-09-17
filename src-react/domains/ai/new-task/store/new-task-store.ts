/**
 * 新建任务落地页草稿状态(spec §4):输入内容/场景/工作空间/权限与待引用
 * 清单。content/pending 为会话内草稿(resetDraft 发送成功后即清,不落盘);
 * scenario/workspaceId/accessMode 三配置手写持久化 localStorage(参照
 * font-scale 模式,key: tianshu-new-task,只存该三字段,读时 isScenarioKey
 * 校验,非法场景丢弃回退 daily)
 */
import { create } from "zustand";

import { isScenarioKey, type ScenarioKey } from "../lib/scenario";

const NEW_TASK_STORAGE_KEY = "tianshu-new-task";

/** 待引用条目:展示名 + 发送时读内容的定位 */
export interface PendingRef {
  /** 展示名：工作空间相对路径 / 本地文件绝对路径尾段 / 技能名 */
  label: string;
  /** 发送时读内容的定位：kind=file → 相对路径；kind=localFile → 绝对路径；kind=skill → 技能名 */
  ref: string;
  kind: "file" | "localFile" | "skill";
}

interface NewTaskState {
  content: string;
  scenario: ScenarioKey;
  workspaceId: number | null;
  accessMode: "default" | "full";
  pending: PendingRef[];
  setContent(s: string): void;
  setScenario(k: ScenarioKey): void;
  setWorkspaceId(id: number | null): void;
  setAccessMode(m: "default" | "full"): void;
  /** label+kind 去重后追加（同展示名同来源视为同一引用） */
  addPending(ref: PendingRef): void;
  /** 按 ref 移除 */
  removePending(ref: string): void;
  /** 发送成功后清 content/pending（保留场景/空间/权限） */
  resetDraft(): void;
}

export const useNewTaskStore = create<NewTaskState>((set) => ({
  content: "",
  scenario: "daily",
  workspaceId: null,
  accessMode: "default",
  pending: [],
  setContent: (s) => set({ content: s }),
  // 三配置 setter 内部写回持久化快照；content/pending 为草稿不持久化
  setScenario: (k) => {
    set({ scenario: k });
    persistDraftSnapshot();
  },
  setWorkspaceId: (id) => {
    set({ workspaceId: id });
    persistDraftSnapshot();
  },
  setAccessMode: (m) => {
    set({ accessMode: m });
    persistDraftSnapshot();
  },
  // 同 label+kind 已存在时不追加（返回原引用避免触发订阅）
  addPending: (ref) =>
    set((state) =>
      state.pending.some((p) => p.label === ref.label && p.kind === ref.kind)
        ? state
        : { pending: [...state.pending, ref] },
    ),
  removePending: (ref) =>
    set((state) => ({
      pending: state.pending.filter((p) => p.ref !== ref),
    })),
  resetDraft: () => set({ content: "", pending: [] }),
}));

/**
 * 恢复持久化配置（落地页挂载时调用一次）：localStorage "tianshu-new-task"
 * 读 { scenario, workspaceId, accessMode }；缺失/损坏整体丢弃保留默认，
 * 场景经 isScenarioKey 校验，非法值回退 daily
 */
export function hydratePersistedDraft(): void {
  const raw = localStorage.getItem(NEW_TASK_STORAGE_KEY);
  if (!raw) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return;
  }
  const { scenario, workspaceId, accessMode } = parsed as Record<
    string,
    unknown
  >;
  useNewTaskStore.setState({
    scenario:
      typeof scenario === "string" && isScenarioKey(scenario)
        ? scenario
        : "daily",
    workspaceId: typeof workspaceId === "number" ? workspaceId : null,
    accessMode: accessMode === "full" ? "full" : "default",
  });
}

/** 三字段快照写回 localStorage（配置 setter 内部调用） */
export function persistDraftSnapshot(): void {
  const { scenario, workspaceId, accessMode } = useNewTaskStore.getState();
  localStorage.setItem(
    NEW_TASK_STORAGE_KEY,
    JSON.stringify({ scenario, workspaceId, accessMode }),
  );
}
