// 审批记忆 store（A10 批）：已记住工具列表（toolPermission 表，双端同表）
// + 完全授权运行态列表。读面直通（load 双读面并行），写面经
// enqueueWrite 串行 + 请求序号+activeConnId+transport 三重防迟到；
// 能力门禁走 chat（审批记忆属会话审批域，双端均报）。撤销成功本地移除/
// 清空对应列表，不整页重拉；revokeAll 系列透传服务端撤销条数。
import { create } from "zustand";
import {
  ENDPOINTS,
  type PermissionFullGrantItem,
  type PermissionRememberedItem,
} from "@tianshu/protocol";
import { wireRequest, type WireResult } from "../transport/wire";
import { activeTransport, useConnectionsStore } from "./connections.store";

export type PermissionRememberedRow = PermissionRememberedItem;
export type PermissionFullGrantRow = PermissionFullGrantItem;

interface PermissionState {
  remembered: PermissionRememberedRow[];
  fullGrants: PermissionFullGrantRow[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  /** 首次成功加载后置位（页头下内容区加载/空态判定） */
  initialized: boolean;
  load(): Promise<void>;
  /** 单条撤销：成功本地移除行，返回是否成功（服务端幂等 no-op 亦成功） */
  revokeRemembered(id: number): Promise<boolean>;
  /** 全部撤销：成功清空本地列表，返回服务端撤销条数（失败 null） */
  revokeAllRemembered(): Promise<number | null>;
  /** 清空完全授权：成功清空本地列表，返回服务端撤销条数（失败 null） */
  revokeAllFull(): Promise<number | null>;
  resetForTest(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function parseRemembered(data: unknown): PermissionRememberedRow[] | null {
  if (!Array.isArray(data)) return null;
  const rows = data.map((value) => {
    if (typeof value !== "object" || value === null) return null;
    const row = value as Record<string, unknown>;
    if (
      typeof row.id !== "number" ||
      typeof row.workspaceName !== "string" ||
      typeof row.toolName !== "string" ||
      typeof row.createdAt !== "string"
    ) {
      return null;
    }
    return {
      id: row.id,
      workspaceName: row.workspaceName,
      toolName: row.toolName,
      createdAt: row.createdAt,
    };
  });
  return rows.every((row) => row !== null)
    ? (rows as PermissionRememberedRow[])
    : null;
}

function parseFullGrants(data: unknown): PermissionFullGrantRow[] | null {
  if (typeof data !== "object" || data === null) return null;
  const grants = (data as { grants?: unknown }).grants;
  if (!Array.isArray(grants)) return null;
  // 最小公共形状（spec §3 裁定）：{sessionId, title}——两仓运行态均无
  // toolName/createdAt
  const rows = grants.map((value) => {
    if (typeof value !== "object" || value === null) return null;
    const row = value as Record<string, unknown>;
    if (typeof row.sessionId !== "number" || typeof row.title !== "string") {
      return null;
    }
    return { sessionId: row.sessionId, title: row.title };
  });
  return rows.every((row) => row !== null)
    ? (rows as PermissionFullGrantRow[])
    : null;
}

function parseRevokedCount(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  const revoked = (data as { revoked?: unknown }).revoked;
  return typeof revoked === "number" ? revoked : null;
}

let reqSeq = 0;
let writeChain: Promise<unknown> = Promise.resolve();
let pendingWrites = 0;

interface RequestToken {
  seq: number;
  connId: string | null;
  transport: ReturnType<typeof activeTransport>;
}

/** 请求前置三重门禁：活动连接存在 + chat 能力已协商 + transport 可用，
 *  不满足不发请求（返回 null，调用方静默返回） */
function beginRequest(): RequestToken | null {
  const connId = useConnectionsStore.getState().activeConnId;
  if (!connId) return null;
  const capabilities =
    useConnectionsStore.getState().capabilitiesByConn[connId];
  if (!capabilities?.includes("chat")) return null;
  const transport = activeTransport();
  if (!transport) return null;
  return { seq: ++reqSeq, connId, transport };
}

function isCurrentRequest(token: RequestToken): boolean {
  return (
    token.seq === reqSeq &&
    token.connId === useConnectionsStore.getState().activeConnId &&
    token.transport === activeTransport()
  );
}

export const usePermissionStore = create<PermissionState>((set) => {
  /** 写面统一出口：串行排队 + saving 态 + 三重防迟到校验；透传 WireResult
   *  （revokeAll 系列需消费服务端撤销条数），成功后局部态由各动作自管 */
  async function enqueueWrite(
    path: string,
    body: unknown,
  ): Promise<WireResult | null> {
    const token = beginRequest();
    if (!token) return null;
    pendingWrites += 1;
    set({ saving: true, error: null });
    const doWrite = async (): Promise<WireResult | null> => {
      try {
        const result = await wireRequest("POST", path, body, token.transport);
        if (!isCurrentRequest(token)) return null;
        if (!result.ok) {
          set({ error: result.message });
          return result;
        }
        return result;
      } catch (error) {
        if (isCurrentRequest(token)) set({ error: errorMessage(error) });
        return null;
      } finally {
        pendingWrites -= 1;
        // 只由最后一项在途写清除；旧写迟到不得提前解锁后续写。
        if (pendingWrites === 0) set({ saving: false });
      }
    };
    const queued = writeChain.then(doWrite);
    writeChain = queued;
    return queued;
  }

  return {
    remembered: [],
    fullGrants: [],
    loading: false,
    saving: false,
    error: null,
    initialized: false,

    load: async () => {
      const token = beginRequest();
      if (!token) return;
      set({ loading: true, error: null });
      try {
        // 双读面并行：同一 token，任一面业务错即整体置错
        const [rememberedResult, fullResult] = await Promise.all([
          wireRequest(
            "POST",
            ENDPOINTS.permission.listRemembered,
            null,
            token.transport,
          ),
          wireRequest(
            "POST",
            ENDPOINTS.permission.listFullGrants,
            null,
            token.transport,
          ),
        ]);
        if (!isCurrentRequest(token)) return;
        if (!rememberedResult.ok) {
          set({ error: rememberedResult.message });
          return;
        }
        if (!fullResult.ok) {
          set({ error: fullResult.message });
          return;
        }
        const remembered = parseRemembered(rememberedResult.data);
        const fullGrants = parseFullGrants(fullResult.data);
        if (!remembered || !fullGrants) {
          set({ error: "Invalid permission response" });
          return;
        }
        set({ remembered, fullGrants, error: null, initialized: true });
      } catch (error) {
        if (isCurrentRequest(token)) set({ error: errorMessage(error) });
      } finally {
        if (isCurrentRequest(token)) set({ loading: false });
      }
    },

    revokeRemembered: async (id) => {
      const result = await enqueueWrite(ENDPOINTS.permission.revokeRemembered, {
        id,
      });
      if (!result?.ok) return false;
      // 本地移除行，不整页重拉（服务端幂等 no-op，本地行必消失）
      set((state) => ({
        remembered: state.remembered.filter((row) => row.id !== id),
      }));
      return true;
    },

    revokeAllRemembered: async () => {
      const result = await enqueueWrite(
        ENDPOINTS.permission.revokeAllRemembered,
        null,
      );
      if (!result?.ok) return null;
      const revoked = parseRevokedCount(result.data);
      if (revoked === null) {
        set({ error: "Invalid permission response" });
        return null;
      }
      set({ remembered: [] });
      return revoked;
    },

    revokeAllFull: async () => {
      const result = await enqueueWrite(
        ENDPOINTS.permission.revokeAllFull,
        null,
      );
      if (!result?.ok) return null;
      const revoked = parseRevokedCount(result.data);
      if (revoked === null) {
        set({ error: "Invalid permission response" });
        return null;
      }
      set({ fullGrants: [] });
      return revoked;
    },

    resetForTest: () => {
      reqSeq += 1;
      writeChain = Promise.resolve();
      pendingWrites = 0;
      set({
        remembered: [],
        fullGrants: [],
        loading: false,
        saving: false,
        error: null,
        initialized: false,
      });
    },
  };
});
