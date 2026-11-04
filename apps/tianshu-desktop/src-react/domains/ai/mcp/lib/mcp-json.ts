/**
 * mcp.json 风格配置 ⇄ McpServerRecord 纯函数（编辑器视图层与 sync 入参的桥）：
 * - recordsToJsonText：DB 记录 → 排序稳定的 mcp.json 文本（编辑器初始内容）
 * - parseMcpConfig：编辑器文本 → 校验归一后的 sync 入参（args/env/headers
 *   归一为 JSON 字符串列，与 DB 存储口径一致；enabled 不进 JSON）
 * - mergeTemplate：市场模板合入现有 JSON（同 key 保留原值）
 * - syncParamsChanged：sync diff 判定（canonical JSON 比较防键序误判）
 * 错误 message 统一 "<CODE>:<detail>"，UI 层按错误码 i18n 映射（详见弹窗组件）
 */
import type { McpServerRecord } from "../../api/mcp.api";

export interface McpServerJsonEntry {
  command?: string;
  args?: string[] | string;
  env?: Record<string, string> | string;
  url?: string;
  headers?: Record<string, string> | string;
}

/** sync 单条入参（key 即 name；transport 由 command/url 推断） */
export interface McpServerSyncEntry {
  transport: "stdio" | "http";
  command?: string;
  args?: string;
  env?: string;
  url?: string;
  headers?: string;
}

/** 安全 parse JSON 列：坏数据返回 undefined（展示不因脏列中断） */
function safeParse(raw?: string | null): unknown {
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** 浅拷贝并去掉值为 undefined 的 key */
function compact<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as T;
}

export function recordsToJsonText(records: McpServerRecord[]): string {
  const mcpServers: Record<string, McpServerJsonEntry> = {};
  for (const r of [...records].sort((a, b) => a.name.localeCompare(b.name))) {
    mcpServers[r.name] =
      r.transport === "stdio"
        ? (compact({
            command: r.command,
            args: safeParse(r.args),
            env: safeParse(r.env),
          }) as McpServerJsonEntry)
        : (compact({
            url: r.url,
            headers: safeParse(r.headers),
          }) as McpServerJsonEntry);
  }
  return JSON.stringify({ mcpServers }, null, 2);
}

/** JSON.parse 失败的 position 换算行号（1 起） */
function errorLine(raw: string, e: unknown): number {
  const pos = /position (\d+)/.exec(e instanceof Error ? e.message : "")?.[1];
  if (!pos) {
    return 1;
  }
  return raw.slice(0, Number(pos)).split("\n").length;
}

/** 字段缺失视为未提供；其余必须是字符串数组，归一为紧凑 JSON 字符串 */
function normalizeArray(name: string, raw: unknown): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = typeof raw === "string" ? safeParse(raw) : raw;
  const ok =
    Array.isArray(value) && value.every((item) => typeof item === "string");
  if (!ok) {
    throw new Error(`MCP_ARGS_INVALID:${name}`);
  }
  return JSON.stringify(value);
}

/** 字段缺失视为未提供；其余必须是值为字符串的对象，归一为紧凑 JSON 字符串 */
function normalizeObject(
  code: string,
  name: string,
  raw: unknown,
): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = typeof raw === "string" ? safeParse(raw) : raw;
  const ok =
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string");
  if (!ok) {
    throw new Error(`${code}:${name}`);
  }
  return JSON.stringify(value);
}

export function parseMcpConfig(
  raw: string,
): Record<string, McpServerSyncEntry> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`MCP_JSON_PARSE:${errorLine(raw, e)}`, { cause: e });
  }
  const servers = (parsed as { mcpServers?: unknown })?.mcpServers;
  if (
    typeof servers !== "object" ||
    servers === null ||
    Array.isArray(servers)
  ) {
    throw new Error("MCP_JSON_STRUCTURE:mcpServers");
  }
  const result: Record<string, McpServerSyncEntry> = {};
  for (const [name, entryRaw] of Object.entries(servers)) {
    result[name] = parseEntry(name, entryRaw);
  }
  return result;
}

function parseEntry(name: string, entryRaw: unknown): McpServerSyncEntry {
  if (typeof entryRaw !== "object" || entryRaw === null) {
    throw new Error(`MCP_ENTRY_TRANSPORT:${name}`);
  }
  if (name.includes("__")) {
    throw new Error(`MCP_NAME_INVALID:${name}`);
  }
  const entry = entryRaw as McpServerJsonEntry;
  const command = nonEmpty(entry.command);
  const url = nonEmpty(entry.url);
  if (Boolean(command) === Boolean(url)) {
    throw new Error(`MCP_ENTRY_TRANSPORT:${name}`);
  }
  return {
    transport: command ? "stdio" : "http",
    command,
    args: normalizeArray(name, entry.args),
    env: normalizeObject("MCP_ENV_INVALID", name, entry.env),
    url,
    headers: normalizeObject("MCP_HEADERS_INVALID", name, entry.headers),
  };
}

/** 非空字符串收窄（空串/空白视为未提供） */
function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

export function mergeTemplate(
  text: string,
  template: Record<string, McpServerJsonEntry>,
): string {
  const parsed = JSON.parse(text) as {
    mcpServers: Record<string, McpServerJsonEntry>;
  };
  for (const [key, value] of Object.entries(template)) {
    parsed.mcpServers[key] ??= value;
  }
  return JSON.stringify(parsed, null, 2);
}

/**
 * 与现有行比较连接参数是否实质变化（args/env/headers canonical 化后比较）；
 * command/url 的 null（DB 清空态）与 undefined（entry 缺省）视为相等，
 * 否则清空后的下次 sync 会误判已变（重复 update，非幂等）
 */
export function syncParamsChanged(
  existing: {
    transport: string;
    command?: string | null;
    args?: string | null;
    env?: string | null;
    url?: string | null;
    headers?: string | null;
  },
  entry: McpServerSyncEntry,
): boolean {
  return (
    existing.transport !== entry.transport ||
    (existing.command ?? undefined) !== (entry.command ?? undefined) ||
    (existing.url ?? undefined) !== (entry.url ?? undefined) ||
    canonical(existing.args) !== canonical(entry.args) ||
    canonical(existing.env) !== canonical(entry.env) ||
    canonical(existing.headers) !== canonical(entry.headers)
  );
}

/** canonical JSON：parse 后重排序序列化；空/坏值统一 undefined */
function canonical(raw?: string | null): string | undefined {
  const value = safeParse(raw);
  return value === undefined ? undefined : JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}
