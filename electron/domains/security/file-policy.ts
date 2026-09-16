/**
 * 文件路径判定引擎（SP3 spec §3，纯函数）：
 * 优先级 内置清单（静态+运行时）> 用户白名单 > 用户黑名单 > default。
 * 匹配：条目归一化（~/ 展开/绝对原样/相对按 workspace/去尾分隔符与 *）后，
 * 精确文件与目录前缀双匹配（无尾分隔符条目同时保护同名目录——偏安全的
 * 两段式）。不做 glob（spec §1 已知边界）。
 */
import os from "node:os";
import path from "node:path";

export type FileAccessDecision = "block" | "allow" | "default";

export interface FileAccessRules {
  builtinBlocklist: string[];
  fileBlocklist: string[];
  fileAllowlist: string[];
}

/** 循环剥离尾分隔符与尾通配符至稳定（/dir/* → /dir、孤立 * → ""） */
function stripTrailingSepAndGlob(value: string): string {
  for (;;) {
    const next = value
      .replace(/[/\\]+$/, "")
      .replace(/\*+$/, "")
      .trim();
    if (next === value) return value;
    value = next;
  }
}

/** 条目归一化：去首尾空白/尾分隔符/尾通配符，~/ 展开，相对按 workspace resolve */
export function normalizeRulePath(
  entry: string,
  workspacePath: string,
): string {
  let value = stripTrailingSepAndGlob(entry.trim());
  if (value === "" || value === "~") {
    return value === "~" ? os.homedir() : "";
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    value = path.join(os.homedir(), value.slice(2));
  }
  return path.isAbsolute(value)
    ? path.normalize(value)
    : path.resolve(workspacePath, value);
}

/** 精确文件或目录前缀匹配（ruleAbs 为空恒 false） */
export function pathMatchesRule(absPath: string, ruleAbs: string): boolean {
  if (ruleAbs === "") return false;
  return absPath === ruleAbs || absPath.startsWith(ruleAbs + path.sep);
}

/** 名单命中：任一条目（归一化后）双匹配 */
function hits(
  absPath: string,
  workspacePath: string,
  entries: string[],
): boolean {
  return entries.some((entry) =>
    pathMatchesRule(absPath, normalizeRulePath(entry, workspacePath)),
  );
}

/** 文件判定：内置 > 用户白 > 用户黑 > default */
export function decideFileAccess(
  absPath: string,
  workspacePath: string,
  rules: FileAccessRules,
): FileAccessDecision {
  if (hits(absPath, workspacePath, rules.builtinBlocklist)) return "block";
  if (hits(absPath, workspacePath, rules.fileAllowlist)) return "allow";
  if (hits(absPath, workspacePath, rules.fileBlocklist)) return "block";
  return "default";
}
