/**
 * 主机数据源全局态（HD 批，spec 2026-10-19 §2.1）：单 UI 多主机（Paseo
 * 模式）——activeHost 决定 api 层路由（本地 IPC / 远程 server:* 透传）。
 * 切换副作用（react-query 缓存清空/搜索与草稿复位）由切换入口经
 * onSwitch 钩子执行（store 不依赖 queryClient——保持纯态）。
 */
import { create } from "zustand";

/** 主机能力面（UI 功能门控——caps.files=false 隐藏附件/文件联想等） */
export interface HostCaps {
  chat: boolean;
  provider: boolean;
  session: boolean;
  assistant: boolean;
  skills: boolean;
  permission: boolean;
  usage: boolean;
  /** 文件系统面（workspace 文件/附件/项目——远程主机恒 false） */
  files: boolean;
  /** 远程编排（graph/automation——仅无头主机） */
  graph: boolean;
}

/** 本地主机能力恒全集（spec：本地是真全集——所有域可用） */
export const LOCAL_HOST_CAPS: HostCaps = {
  chat: true,
  provider: true,
  session: true,
  assistant: true,
  skills: true,
  permission: true,
  usage: true,
  files: true,
  graph: false,
};

/** 远程主机 caps 由连接运行时上报 capabilities 推导 */
export function capsOfCapabilities(capabilities: string[]): HostCaps {
  const has = (cap: string) => capabilities.includes(cap);
  return {
    chat: has("chat"),
    provider: has("provider"),
    session: has("chat"),
    assistant: true,
    skills: true,
    permission: has("chat"),
    usage: has("chat"),
    // FA-T3 动态化：被控端上报 files（三端点）才开文件面——旧端不上报
    // 照旧全关，HD-T4 门控零改动跟随
    files: has("files"),
    graph: has("graph"),
  };
}

export type ActiveHost = { kind: "local" } | { kind: "remote"; connId: string };

interface HostState {
  activeHost: ActiveHost;
  /** 远程主机 caps（本地时为 LOCAL_HOST_CAPS） */
  caps: HostCaps;
  /** 切换主机（onSwitch 钩子由调用方执行缓存清空等副作用） */
  switchHost(next: ActiveHost, opts?: { onSwitched?: () => void }): void;
}

export const useHostStore = create<HostState>((set, get) => ({
  activeHost: { kind: "local" },
  caps: LOCAL_HOST_CAPS,
  switchHost: (next, opts) => {
    if (
      get().activeHost.kind === next.kind &&
      (next.kind === "local" ||
        (get().activeHost as { connId: string }).connId === next.connId)
    ) {
      return; // 同主机幂等
    }
    set({ activeHost: next });
    // caps：本地全集；远程先置空面（由切换入口拉 connectionList 回填真实值）
    set({
      caps: next.kind === "local" ? LOCAL_HOST_CAPS : capsOfCapabilities([]),
    });
    opts?.onSwitched?.();
  },
}));

/** 非组件态读取（api 路由层用——避免 React 依赖） */
export function activeHost(): ActiveHost {
  return useHostStore.getState().activeHost;
}

/** 组件态读取（UI 门控用——ChatInput 附件/文件联想/compact 等，
 *  spec §2.4：caps.files=false 的面不渲染不触发） */
export function useHostCaps(): HostCaps {
  return useHostStore((s) => s.caps);
}
