import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";

/**
 * 通知偏好 store（M3）：enabled 总开关 + approvals/graphDone 两个子开关，
 * store 触发点（stream/orchestration）经 getNotifyPrefs 非响应式读取。
 * 持久化照 theme.store 模式：写 fire-and-forget、创建即恢复 + 白名单
 * 判型（坏档/注入字段忽略，保持默认）。
 */

/** 持久化 key（对齐 connections.store 的 tianshu-mobile.* 命名段） */
const STORAGE_KEY = "tianshu-mobile.notify";

export interface NotifyPrefs {
  /** 总开关（关则任何触发点都不响） */
  enabled: boolean;
  /** 审批请求到达提醒 */
  approvals: boolean;
  /** 图运行终态提醒 */
  graphDone: boolean;
}

/** 默认偏好：总关；首次打开总开关后两个子开关默认全开 */
const DEFAULT_PREFS: NotifyPrefs = {
  enabled: false,
  approvals: true,
  graphDone: true,
};

const PREF_KEYS = ["enabled", "approvals", "graphDone"] as const;

/** 恢复档白名单判型：仅收 boolean 字段，其余（注入/坏档）忽略 */
function pickPrefs(saved: string | null): Partial<NotifyPrefs> {
  if (!saved) return {};
  try {
    const parsed: unknown = JSON.parse(saved);
    if (typeof parsed !== "object" || parsed === null) return {};
    const row = parsed as Record<string, unknown>;
    const out: Partial<NotifyPrefs> = {};
    for (const key of PREF_KEYS) {
      if (typeof row[key] === "boolean") out[key] = row[key];
    }
    return out;
  } catch {
    return {}; // 坏 JSON 静默保持默认
  }
}

interface NotifyState extends NotifyPrefs {
  setPrefs: (partial: Partial<NotifyPrefs>) => void;
}

export const useNotifyStore = create<NotifyState>((set, get) => ({
  ...DEFAULT_PREFS,
  setPrefs: (partial) => {
    set(partial);
    const { enabled, approvals, graphDone } = get();
    void AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ enabled, approvals, graphDone }),
    ).catch(() => {
      /* 静默：quota/IO 失败不阻塞交互，下次切换覆写重试 */
    });
  },
}));

/** 非 React 消费面（store 触发点）：读当前偏好快照 */
export function getNotifyPrefs(): NotifyPrefs {
  const { enabled, approvals, graphDone } = useNotifyStore.getState();
  return { enabled, approvals, graphDone };
}

// store 创建即恢复存档（fire-and-forget；非法值/坏档静默保持默认）
void AsyncStorage.getItem(STORAGE_KEY)
  .then((saved) => {
    const picked = pickPrefs(saved);
    if (Object.keys(picked).length > 0) useNotifyStore.setState(picked);
  })
  .catch(() => {
    /* 静默：原生模块读取异常不阻断启动 */
  });
