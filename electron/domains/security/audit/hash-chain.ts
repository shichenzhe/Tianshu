/**
 * 审计日志哈希链（SP1 spec §6.3）：每条 entry 的 hash 覆盖自身规范化
 * 内容与前条 hash，事后删改任一环节都会导致链校验失败。
 * 纯函数 + node:crypto，可被 vitest 直接测试。
 */
import { createHash } from "node:crypto";

/** 规范化 JSON：对象 key 递归排序、undefined 值剔除 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item ?? null)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(",")}}`;
}

/** 条目 hash：sha256(prevHash + 规范化内容)；entry 自身的 hash 字段不参与 */
export function computeEntryHash(
  entry: Record<string, unknown>,
  prevHash: string | null,
): string {
  const { hash: _omit, ...rest } = entry;
  return createHash("sha256")
    .update(prevHash ?? "")
    .update(stableStringify(rest))
    .digest("hex");
}

/** 链完整性校验：逐条重算 hash 并比对 prevHash 接续（entries 须按链序传入） */
export function verifyChain(
  entries: Array<Record<string, unknown> & { prevHash: string | null; hash: string }>,
): boolean {
  let prev: string | null = null;
  for (const entry of entries) {
    if (entry.prevHash !== prev) return false;
    if (computeEntryHash(entry, prev) !== entry.hash) return false;
    prev = entry.hash;
  }
  return true;
}
