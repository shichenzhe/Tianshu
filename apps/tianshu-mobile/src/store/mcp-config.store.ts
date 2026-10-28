// MCP 连接器远端数据 store（A4 批）：列表（mcp/query + mcp/statuses 按 id
// 合并运行态）+ 详情（mcp/detail——headers/env 恒掩码）+ HTTP 写面
// （mcp/save upsert——headers 掩码三态：undefined 保留/null 清除/含掩码
// 按未传）+ 删除/重连。stdio 类型只读摘要（宿主机进程执行面，移动端不可
// 创建/编辑参数）。读面直通，写面经 enqueueWrite 串行；能力门禁 mcp。
import { create } from "zustand";
import {
  ENDPOINTS,
  type McpDetailResult,
  type McpSavePayload,
  type McpStatusItemDto,
} from "@tianshu/protocol";
import { wireRequest } from "../transport/wire";
import { activeTransport, useConnectionsStore } from "./connections.store";

/** 列表行 = mcp/query 摘要 + 运行态（statuses 失败时 status 为 null——
 *  旧被控端不报新端点，行仍可管理启停/删除） */
export interface McpConfigRow {
  id: number;
  name: string;
  transport: string;
  command: string | null;
  url: string | null;
  enabled: boolean;
  status: McpStatusItemDto | null;
}

interface McpConfigState {
  rows: McpConfigRow[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  initialized: boolean;
  load(): Promise<void>;
  /** 运行态单拉（列表加载/重连后/15s 轮询刷新状态点，失败静默保留旧
   *  态）；并发触发共享 in-flight 守卫，进行中的刷新被跳过不叠加 */
  refreshStatuses(): Promise<void>;
  loadDetail(id: number): Promise<McpDetailResult | null>;
  saveHttp(payload: McpSavePayload): Promise<boolean>;
  /** 启停（阶段 0 修复后被控端真切换进程/工具注册态） */
  setEnabled(id: number, enabled: boolean): Promise<boolean>;
  /** 启停乐观补丁：组件先即时改行，失败回滚（对齐旧 McpSection 口径） */
  patchEnabled(id: number, enabled: boolean): void;
  remove(id: number): Promise<boolean>;
  reconnect(id: number): Promise<boolean>;
  resetForTest(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseQueryRow(value: unknown): Omit<McpConfigRow, "status"> | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "number" ||
    typeof row.name !== "string" ||
    typeof row.enabled !== "boolean"
  ) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    transport: typeof row.transport === "string" ? row.transport : "",
    command: nullableString(row.command),
    url: nullableString(row.url),
    enabled: row.enabled,
  };
}

function parseStatuses(data: unknown): McpStatusItemDto[] | null {
  if (!Array.isArray(data)) return null;
  const rows = data.map((value) => {
    if (typeof value !== "object" || value === null) return null;
    const row = value as Record<string, unknown>;
    if (
      typeof row.id !== "number" ||
      typeof row.name !== "string" ||
      typeof row.state !== "string" ||
      typeof row.toolCount !== "number"
    ) {
      return null;
    }
    return {
      id: row.id,
      name: row.name,
      state: row.state,
      toolCount: row.toolCount,
      error: nullableString(row.error) ?? undefined,
    };
  });
  return rows.every((row) => row !== null)
    ? (rows as McpStatusItemDto[])
    : null;
}

function parseDetail(data: unknown): McpDetailResult | null {
  if (typeof data !== "object" || data === null) return null;
  const row = data as Record<string, unknown>;
  if (
    typeof row.id !== "number" ||
    typeof row.name !== "string" ||
    typeof row.transport !== "string" ||
    typeof row.enabled !== "boolean"
  ) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    command: nullableString(row.command),
    url: nullableString(row.url),
    enabled: row.enabled,
    args: Array.isArray(row.args)
      ? row.args.filter((item): item is string => typeof item === "string")
      : [],
    env:
      typeof row.env === "object" && row.env !== null
        ? (row.env as Record<string, string>)
        : {},
    headers:
      typeof row.headers === "object" && row.headers !== null
        ? (row.headers as Record<string, string>)
        : {},
  };
}

let reqSeq = 0;
let writeChain: Promise<unknown> = Promise.resolve();
let pendingWrites = 0;
/** statuses 刷新 in-flight 守卫：轮询 tick 与手动刷新（重连/写后）共享，
 *  进行中的刷新直接跳过——慢响应不会叠加并发 */
let statusesInFlight = false;

interface RequestToken {
  seq: number;
  connId: string | null;
  transport: ReturnType<typeof activeTransport>;
}

function beginRequest(): RequestToken | null {
  const connId = useConnectionsStore.getState().activeConnId;
  if (!connId) return null;
  const capabilities =
    useConnectionsStore.getState().capabilitiesByConn[connId];
  if (!capabilities?.includes("mcp")) return null;
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

/** statuses 按 id 并入列表行（缺行丢弃——query 与 statuses 同库同源） */
function mergeStatuses(
  rows: Omit<McpConfigRow, "status">[],
  statuses: McpStatusItemDto[] | null,
): McpConfigRow[] {
  const byId = new Map((statuses ?? []).map((item) => [item.id, item]));
  return rows.map((row) => ({ ...row, status: byId.get(row.id) ?? null }));
}

export const useMcpConfigStore = create<McpConfigState>((set, get) => {
  /** 写面统一出口：串行排队 + saving 态 + 三重防迟到；成功后重拉列表
   *  （启停/删除/保存的权威态以服务端重拉为准） */
  async function enqueueWrite(
    path: string,
    body: unknown,
    refresh: "load" | "statuses" = "load",
  ): Promise<boolean> {
    const token = beginRequest();
    if (!token) return false;
    pendingWrites += 1;
    set({ saving: true, loading: false, error: null });
    const doWrite = async (): Promise<boolean> => {
      try {
        const result = await wireRequest("POST", path, body, token.transport);
        if (!isCurrentRequest(token)) return false;
        if (!result.ok) {
          set({ error: result.code || result.message });
          return false;
        }
        if (refresh === "statuses") await get().refreshStatuses();
        else await get().load();
        return true;
      } catch (error) {
        if (isCurrentRequest(token)) set({ error: errorMessage(error) });
        return false;
      } finally {
        pendingWrites -= 1;
        if (pendingWrites === 0) set({ saving: false });
      }
    };
    const queued = writeChain.then(doWrite);
    writeChain = queued;
    return queued;
  }

  return {
    rows: [],
    loading: false,
    saving: false,
    error: null,
    initialized: false,

    load: async () => {
      const token = beginRequest();
      if (!token) return;
      set({ loading: true, error: null });
      try {
        const result = await wireRequest(
          "POST",
          ENDPOINTS.mcp.query,
          null,
          token.transport,
        );
        if (!isCurrentRequest(token)) return;
        if (!result.ok) {
          set({ error: result.code || result.message });
          return;
        }
        if (!Array.isArray(result.data)) {
          set({ error: "Invalid mcp list response" });
          return;
        }
        const parsed = result.data
          .map(parseQueryRow)
          .filter((row): row is NonNullable<typeof row> => row !== null);
        if (!isCurrentRequest(token)) return;
        // 运行态并入（statuses 失败静默——行保留 null 运行态）
        const statusResult = await wireRequest(
          "POST",
          ENDPOINTS.mcp.statuses,
          null,
          token.transport,
        );
        const statuses =
          isCurrentRequest(token) && statusResult.ok
            ? parseStatuses(statusResult.data)
            : null;
        set({
          rows: mergeStatuses(parsed, statuses),
          error: null,
          initialized: true,
        });
      } catch (error) {
        if (isCurrentRequest(token)) set({ error: errorMessage(error) });
      } finally {
        if (isCurrentRequest(token)) set({ loading: false });
      }
    },

    refreshStatuses: async () => {
      if (statusesInFlight) return;
      const token = beginRequest();
      if (!token) return;
      statusesInFlight = true;
      try {
        const result = await wireRequest(
          "POST",
          ENDPOINTS.mcp.statuses,
          null,
          token.transport,
        );
        if (!isCurrentRequest(token) || !result.ok) return;
        const statuses = parseStatuses(result.data);
        if (!statuses) return;
        set((state) => ({
          rows: state.rows.map((row) => ({
            ...row,
            status: statuses.find((item) => item.id === row.id) ?? null,
          })),
        }));
      } catch {
        // 状态点刷新失败静默（不影响管理面）
      } finally {
        statusesInFlight = false;
      }
    },

    loadDetail: async (id) => {
      const token = beginRequest();
      if (!token) return null;
      try {
        const result = await wireRequest(
          "POST",
          ENDPOINTS.mcp.detail,
          { id },
          token.transport,
        );
        if (!isCurrentRequest(token)) return null;
        if (!result.ok) {
          set({ error: result.code || result.message });
          return null;
        }
        return parseDetail(result.data);
      } catch (error) {
        if (isCurrentRequest(token)) set({ error: errorMessage(error) });
        return null;
      }
    },

    saveHttp: (payload) => enqueueWrite(ENDPOINTS.mcp.save, payload),

    setEnabled: (id, enabled) =>
      enqueueWrite(ENDPOINTS.mcp.setEnabled, { id, enabled }),

    patchEnabled: (id, enabled) => {
      set((state) => ({
        rows: state.rows.map((row) =>
          row.id === id ? { ...row, enabled } : row,
        ),
      }));
    },

    remove: (id) => enqueueWrite(ENDPOINTS.mcp.delete, { id }),

    reconnect: (id) =>
      enqueueWrite(ENDPOINTS.mcp.reconnect, { id }, "statuses"),

    resetForTest: () => {
      reqSeq += 1;
      writeChain = Promise.resolve();
      pendingWrites = 0;
      statusesInFlight = false;
      set({
        rows: [],
        loading: false,
        saving: false,
        error: null,
        initialized: false,
      });
    },
  };
});

/** 轮询 tick（McpSection 挂载期 interval 纯调用）：MCP 进程外部掉线状态点
 *  不会自动刷新，15s 轮询补拉；与手动刷新共享 statusesInFlight 守卫，进行
 *  中的刷新被跳过不叠加并发；失败静默 */
export function pollMcpStatusesTick(): void {
  void useMcpConfigStore.getState().refreshStatuses();
}
