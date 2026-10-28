// A4 MCP 批（spec 2026-10-26 §1.4）：桌面被控面连接器桥——阶段 0 的
// query/setEnabled 语义原样保留（list 裁剪不透 env/headers；setEnabled
// 走 repo 联动 McpManager），新增 statuses/save/delete/reconnect/detail。
// 写面 v1 仅 HTTP transport：url 必须 http(s)；stdio 类型 save 一律拒
// MCP_STDIO_FORBIDDEN（被控宿主机进程执行面，移动端只读摘要）。headers
// 掩码三态复用 providers-tap 的 REDACTED_SECRET fail-closed 语义：
// undefined 保留 / null 清除 / 含掩码按未传。detail 的 env/headers 恒掩码。
import { REDACTED_SECRET } from "@tianshu/protocol";
import type {
  McpDetailResult,
  McpErrorCode,
  McpSavePayload,
  McpStatusItemDto,
} from "@tianshu/protocol";
import type { McpRepository } from "../ai/mcp/mcp.repo";
import type {
  McpServerRecord,
  McpServerUpdateParams,
} from "../../../src-react/domains/ai/api/mcp.api";
import type { ServerFaceMcps } from "./deps";
import { redactExtraHeaders } from "./providers-tap";

/** MCP 面业务错（code 稳定——routes 侧转 bizError 信封，控制端判码） */
export class FaceMcpError extends Error {
  readonly code: McpErrorCode;
  constructor(code: McpErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** 桥接的仓储方法子集（McpRepository 满足——联动 McpManager 生命周期） */
export type McpRepoSubset = Pick<
  McpRepository,
  | "list"
  | "setEnabled"
  | "statuses"
  | "create"
  | "update"
  | "delete"
  | "reconnect"
>;

/** 仓储裸抛不存在/越权码 → MCP_NOT_FOUND（不泄露存在性） */
function toNotFound(error: unknown): FaceMcpError {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "MCP_SERVER_MISSING") {
    return new FaceMcpError("MCP_NOT_FOUND", "连接器不存在");
  }
  return new FaceMcpError("MCP_INVALID", message);
}

/** 归属内查行：不存在 MCP_NOT_FOUND（list 已按 userId 过滤） */
async function mustGet(
  repo: McpRepoSubset,
  id: number,
  userId: number,
): Promise<McpServerRecord> {
  const record = (await repo.list(userId)).find((row) => row.id === id);
  if (!record) {
    throw new FaceMcpError("MCP_NOT_FOUND", "连接器不存在");
  }
  return record;
}

/** headers 掩码三态（A1 fail-closed 同口径）：undefined/含掩码 → 保留现值；
 *  null → 清除；显式新值 → JSON 序列化落库 */
function resolveHeaders(
  payload: McpSavePayload,
  current: string | undefined,
): string | null {
  if (payload.headers === undefined) return current ?? null;
  if (payload.headers === null) return null;
  if (Object.values(payload.headers).some((v) => v.includes(REDACTED_SECRET))) {
    return current ?? null;
  }
  return JSON.stringify(payload.headers);
}

/** JSON 数组字符串列 → string[]：坏 JSON/非数组回退空数组（fail-closed，
 *  与 expert-catalog parseJsonStringArray 同口径语义） */
function parseArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

/** env/headers 恒掩码：有值键回 REDACTED 占位串（空串值保留——区分
 *  「已配置」与「显式空值」，providers redactExtraHeaders 同口径） */
function maskJsonRecord(raw: string | undefined): Record<string, string> {
  const redacted = redactExtraHeaders(raw);
  if (!redacted) return {};
  try {
    const parsed: unknown = JSON.parse(redacted);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

/** detail DTO：stdio 类型仅回摘要字段（args/env 不回传——进程执行面参数
 *  不透出）；HTTP 类型 args 透传（通常空数组），env/headers 恒掩码 */
function toDetail(record: McpServerRecord): McpDetailResult {
  const base = {
    id: record.id,
    name: record.name,
    transport: record.transport,
    command: record.command ?? null,
    url: record.url ?? null,
    enabled: record.enabled,
  };
  if (record.transport !== "http") {
    return { ...base, args: [], env: {}, headers: {} };
  }
  return {
    ...base,
    args: parseArgs(record.args),
    env: maskJsonRecord(record.env),
    headers: maskJsonRecord(record.headers),
  };
}

/** HTTP 单条 upsert 更新载荷：连接参数（command/args/env）沿库值不动——
 *  移动端写面无这些字段语义；headers 三态；enabled 缺省沿库值 */
function toUpdateParams(
  payload: McpSavePayload,
  existing: McpServerRecord,
  headers: string | null,
): McpServerUpdateParams {
  return {
    id: existing.id,
    name: payload.name,
    transport: "http",
    command: existing.command ?? null,
    args: existing.args ?? null,
    env: existing.env ?? null,
    url: payload.url,
    headers,
    enabled: payload.enabled ?? existing.enabled,
  };
}

export function createMcpsFace(repo: McpRepoSubset): ServerFaceMcps {
  const save = async (
    payload: McpSavePayload,
    userId: number,
  ): Promise<McpDetailResult> => {
    if (!/^https?:\/\//i.test(payload.url)) {
      throw new FaceMcpError("MCP_INVALID", "url 必须为 http(s) 地址");
    }
    if (payload.id != null) {
      const existing = await mustGet(repo, payload.id, userId);
      if (existing.transport !== "http") {
        throw new FaceMcpError(
          "MCP_STDIO_FORBIDDEN",
          "stdio 类型连接器请在桌面端编辑",
        );
      }
      const headers = resolveHeaders(payload, existing.headers);
      const record = await repo.update(
        toUpdateParams(payload, existing, headers),
        userId,
      );
      return toDetail(record);
    }
    const headers = resolveHeaders(payload, undefined);
    const record = await repo.create(
      {
        name: payload.name,
        transport: "http",
        url: payload.url,
        headers: headers ?? undefined,
        enabled: payload.enabled ?? true,
      },
      userId,
    );
    return toDetail(record);
  };

  return {
    // 阶段 0 语义保留：列表裁剪不透 env/headers；启停走 repo 联动 manager
    list: async (userId) =>
      (await repo.list(userId)).map((record) => ({
        id: record.id,
        name: record.name,
        transport: record.transport,
        command: record.command ?? null,
        url: record.url ?? null,
        enabled: record.enabled,
      })),
    setEnabled: (id, enabled, userId) => repo.setEnabled(id, enabled, userId),
    statuses: async (userId): Promise<McpStatusItemDto[]> =>
      (await repo.statuses(userId)).map((status) => ({
        id: status.id,
        name: status.name,
        state: status.state,
        toolCount: status.toolCount,
        ...(status.error !== undefined ? { error: status.error } : {}),
      })),
    save,
    remove: async (id, userId) => {
      try {
        await repo.delete(id, userId);
      } catch (error) {
        throw toNotFound(error);
      }
    },
    reconnect: async (id, userId) => {
      try {
        await repo.reconnect(id, userId);
      } catch (error) {
        throw toNotFound(error);
      }
    },
    detail: async (id, userId) => toDetail(await mustGet(repo, id, userId)),
  };
}
