/**
 * 安全配置存取纯函数层（SP1 spec §6.1）：注入 db 接口的纯函数
 * （照 app-settings/option-store.ts 模式），vitest 可直接测。
 * 写为 upsert 语义（updateMany 命中 0 行则 create）。
 */
import type {
  CmdRule,
  SecurityConfig,
  SecurityConfigKey,
} from "../../../src-react/domains/security/model/types";
import { parseBoolOption } from "../app-settings/option-store";
import { ESTIMATE_COUNT_LIMIT } from "./backup-policy";
import { normalizeDomain } from "./domain-policy";
import { BUILTIN_TOOL_NAMES, SECURITY_DEFAULTS } from "./defaults";

export const SECURITY_OPTION_TYPE = "security";

/** prisma option delegate 结构子集（真实客户端/测试 stub 均可注入） */
export interface SecurityOptionPrismaLike {
  findMany(args: {
    where: { type: string };
    select: { name: true; value: true };
  }): Promise<Array<{ name: string; value: string }>>;
  updateMany(args: {
    where: { type: string; name: string };
    data: { value: string };
  }): Promise<{ count: number }>;
  create(args: {
    data: { type: string; name: string; value: string };
  }): Promise<unknown>;
}

export async function listSecurityOptions(
  db: SecurityOptionPrismaLike,
): Promise<Array<{ name: string; value: string }>> {
  return db.findMany({
    where: { type: SECURITY_OPTION_TYPE },
    select: { name: true, value: true },
  });
}

/** upsert：先 updateMany（type+name 定位），命中 0 行则 create */
export async function setSecurityOption(
  db: SecurityOptionPrismaLike,
  name: string,
  value: string,
): Promise<void> {
  const result = await db.updateMany({
    where: { type: SECURITY_OPTION_TYPE, name },
    data: { value },
  });
  if (result.count === 0) {
    await db.create({ data: { type: SECURITY_OPTION_TYPE, name, value } });
  }
}

// ---------- normalize 族（spec §6.1，照 WorkBuddy 钳制规则） ----------

export function normalizeFileBackupMaxSizeMB(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return SECURITY_DEFAULTS.fileBackupMaxSizeMB;
  return Math.max(1000, Math.round(n));
}

/**
 * 批量删除阈值：整数钳制到 [1, ESTIMATE_COUNT_LIMIT]——上限与预估计数封顶
 * 一致（>上限时 count 恒 ≤ 上限 < 阈值会致批量门静默失效）；非法回落默认。
 */
export function normalizeBulkDeleteThreshold(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < 1) {
    return SECURITY_DEFAULTS.bulkDeleteThreshold;
  }
  return Math.min(n, ESTIMATE_COUNT_LIMIT);
}

/** 命令规则校验：prefix 非空字符串数组（空 token 剔除），reason 可选 */
export function pickCommandRuleArray(v: unknown): CmdRule[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((item): CmdRule[] => {
    if (typeof item !== "object" || item === null) return [];
    const { prefix, reason } = item as { prefix?: unknown; reason?: unknown };
    const tokens = pickStringArray(prefix);
    if (tokens.length === 0) return [];
    return typeof reason === "string" && reason
      ? [{ prefix: tokens, reason }]
      : [{ prefix: tokens }];
  });
}

export function pickStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (item): item is string => typeof item === "string" && item !== "",
  );
}

/** 域名单清洗（SP5）：字符串数组逐条归一化，剔空去重（保序） */
export function pickDomainArray(raw: unknown): string[] {
  const seen = new Set<string>();
  for (const item of pickStringArray(raw)) {
    const norm = normalizeDomain(item);
    if (norm) seen.add(norm);
  }
  return [...seen];
}

/** 禁用工具清洗（SP6）：只收内置已知名，去重保注册表序；防配置漂移 */
export function pickDisabledTools(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  for (const name of pickStringArray(v)) {
    if (BUILTIN_TOOL_NAMES.includes(name)) seen.add(name);
  }
  return [...seen];
}

function parseJsonArray(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

// ---------- read-time fallback 解析（spec §5.1） ----------

/**
 * 逐字段 read-time 解析器：入参为 option 行值（缺行为 undefined），
 * 畸形 JSON 不抛错、非法条目剔除，逐字段回退默认值。
 */
const FIELD_PARSERS: {
  [K in SecurityConfigKey]: (raw: string | undefined) => SecurityConfig[K];
} = {
  sandboxEnabled: (raw) => parseBoolOption(raw, true),
  fileAllowlist: (raw) => pickStringArray(parseJsonArray(raw ?? "[]")),
  fileBlocklist: (raw) => pickStringArray(parseJsonArray(raw ?? "[]")),
  cmdAllow: (raw) =>
    pickCommandRuleArray(
      parseJsonArray(raw ?? JSON.stringify(SECURITY_DEFAULTS.cmdAllow)),
    ),
  cmdAsk: (raw) =>
    pickCommandRuleArray(
      parseJsonArray(raw ?? JSON.stringify(SECURITY_DEFAULTS.cmdAsk)),
    ),
  programBlacklist: (raw) =>
    pickStringArray(
      parseJsonArray(raw ?? JSON.stringify(SECURITY_DEFAULTS.programBlacklist)),
    ),
  domainAllow: (raw) => pickDomainArray(parseJsonArray(raw ?? "[]")),
  domainDeny: (raw) => pickDomainArray(parseJsonArray(raw ?? "[]")),
  blockAllNetwork: (raw) => parseBoolOption(raw, false),
  maliciousDomainProtection: (raw) => parseBoolOption(raw, true),
  fileBackupEnabled: (raw) => parseBoolOption(raw, true),
  fileBackupMaxSizeMB: (raw) => normalizeFileBackupMaxSizeMB(raw),
  deleteProtection: (raw) => parseBoolOption(raw, true),
  bulkDeleteThreshold: (raw) => normalizeBulkDeleteThreshold(raw),
  disabledTools: (raw) => pickDisabledTools(parseJsonArray(raw ?? "[]")),
};

/** 行集 → 完整安全配置（read-time fallback）：缺行逐字段回退默认 */
export function parseSecurityConfig(
  rows: Array<{ name: string; value: string }>,
): SecurityConfig {
  // Map 构造器读条目的 [0]/[1]，须先转 [name, value] 对（照 option-store 惯例）
  const map = new Map(rows.map((row) => [row.name, row.value]));
  const config: Partial<Record<SecurityConfigKey, unknown>> = {};
  for (const key of Object.keys(FIELD_PARSERS) as SecurityConfigKey[]) {
    config[key] = FIELD_PARSERS[key](map.get(key));
  }
  // FIELD_PARSERS 在类型层面穷尽 SecurityConfigKey，聚合收口安全
  return config as SecurityConfig;
}

// ---------- 序列化与内置项处理 ----------

export function serializeSecurityValue(
  key: SecurityConfigKey,
  value: unknown,
): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** 保存前剔除内置项（三层防删第二层：内置永不落盘） */
export function stripBuiltinItems(list: string[], builtin: string[]): string[] {
  return list.filter((item) => !builtin.includes(item));
}

/** 展示合并：内置在前、去重（三层防删的展示层） */
export function mergeRuleList(builtin: string[], custom: string[]): string[] {
  const customOnly = stripBuiltinItems(custom, builtin);
  return [...builtin, ...customOnly];
}

/** 深拷贝配置（内存缓存返回防御性副本） */
export function copySecurityConfig(config: SecurityConfig): SecurityConfig {
  return {
    ...config,
    fileAllowlist: [...config.fileAllowlist],
    fileBlocklist: [...config.fileBlocklist],
    cmdAllow: config.cmdAllow.map((rule) => ({ ...rule })),
    cmdAsk: config.cmdAsk.map((rule) => ({ ...rule })),
    programBlacklist: [...config.programBlacklist],
    domainAllow: [...config.domainAllow],
    domainDeny: [...config.domainDeny],
    disabledTools: [...config.disabledTools],
  };
}
