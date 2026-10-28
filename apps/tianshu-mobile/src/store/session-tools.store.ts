import { create } from "zustand";
import {
  ENDPOINTS,
  type SessionPolishParams,
  type SessionPolishStyle,
} from "@tianshu/protocol";

import { activeTransport } from "./connections.store";
import type { Transport } from "../transport/types";
import { wireRequest } from "../transport/wire";

/**
 * 会话工具批（A9）store：compact（阶段 2）/ polish（阶段 3）两个会话内
 * 工具的调用出口。端点与载荷契约单份在 @tianshu/protocol（ENDPOINTS.
 * session.compact/polish + SessionPolishParams）；transport 参数留作单测
 * 注入，缺省取活动连接。
 */

/** 润色风格：对齐桌面现状固定 professional（桌面 UI 无风格选择） */
export const POLISH_STYLE: SessionPolishStyle = "professional";

export type PolishResult =
  { ok: true; text: string } | { ok: false; message: string };

interface SessionToolsState {
  /** compact 请求进行中（防重复点） */
  compacting: boolean;
  /** polish 请求进行中（防重复点） */
  polishing: boolean;
  /** 请求压缩上下文：返回是否受理（202）；false = 网络/业务错（调用方提示） */
  compact(sessionId: number, transport?: Transport | null): Promise<boolean>;
  /** 润色文本：成功返回润色后文本（调用方替换草稿）；失败返回错误文案
   *  （草稿不动——失败侧由调用方维持原文并提示） */
  polish(
    text: string,
    workspaceId: number | null,
    transport?: Transport | null,
  ): Promise<PolishResult>;
}

export const useSessionToolsStore = create<SessionToolsState>((set, get) => ({
  compacting: false,
  polishing: false,

  compact: async (sessionId, transport) => {
    if (get().compacting) return false;
    set({ compacting: true });
    try {
      const r = await wireRequest(
        "POST",
        ENDPOINTS.session.compact,
        { sessionId },
        transport ?? activeTransport(),
      );
      return r.ok;
    } finally {
      set({ compacting: false });
    }
  },

  polish: async (text, workspaceId, transport) => {
    if (get().polishing) {
      return { ok: false, message: "" };
    }
    set({ polishing: true });
    try {
      const r = await wireRequest(
        "POST",
        ENDPOINTS.session.polish,
        {
          text,
          style: POLISH_STYLE,
          ...(workspaceId != null ? { workspaceId } : {}),
        },
        transport ?? activeTransport(),
      );
      if (!r.ok) {
        return { ok: false, message: r.message };
      }
      const polished = (r.data as { text?: unknown } | null)?.text;
      if (typeof polished !== "string" || polished === "") {
        return { ok: false, message: "" };
      }
      return { ok: true, text: polished };
    } finally {
      set({ polishing: false });
    }
  },
}));
