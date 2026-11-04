/** zip 条目安全校验与技能包结构定位(纯函数,TDD;spec §2.1) */
import path from "node:path";
import { parseFrontmatter } from "../agent/skill-loader";

const DANGEROUS_EXT = new Set([
  ".exe",
  ".dll",
  ".sh",
  ".bat",
  ".command",
  ".app",
  ".msi",
  ".scr",
]);
export const DEFAULTS = {
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  maxCount: 500,
};

export type ArchiveCheck = { ok: true } | { ok: false; reason: string };

/**
 * 校验 zip 条目清单:拒绝路径穿越(zip-slip)、绝对路径与可执行扩展,
 * 并限制条目数;大小上限(maxFileBytes/maxTotalBytes)由调用方在解压后
 * 按实际字节数再验一次(此函数只拿到路径,无大小信息)。
 */
export function validateArchiveEntries(
  entries: string[],
  opts: Partial<typeof DEFAULTS> = {},
): ArchiveCheck {
  const { maxCount } = { ...DEFAULTS, ...opts };
  if (entries.length === 0) {
    return { ok: false, reason: "压缩包为空" };
  }
  if (entries.length > maxCount) {
    return { ok: false, reason: `条目数超过上限(${maxCount})` };
  }
  for (const entry of entries) {
    const normalized = path.posix.normalize(entry.replace(/\\/g, "/"));
    if (
      path.posix.isAbsolute(normalized) ||
      normalized.startsWith("../") ||
      normalized.includes("/../")
    ) {
      return { ok: false, reason: `存在不安全路径:${entry}` };
    }
    if (DANGEROUS_EXT.has(path.posix.extname(normalized).toLowerCase())) {
      return { ok: false, reason: `不允许的可执行文件:${entry}` };
    }
  }
  return { ok: true };
}

/**
 * 定位技能根:SKILL.md 须位于压缩包根,或唯一一级子目录内;
 * 多个顶层目录时无法定位,拒绝。
 */
export function locateSkillRoot(
  entries: string[],
): { ok: true; root: string } | ArchiveCheck {
  const normalized = entries.map((e) => e.replace(/\\/g, "/"));
  const hasSkillMd = (prefix: string) =>
    normalized.some((e) => e === `${prefix}SKILL.md`);
  if (hasSkillMd("")) {
    return { ok: true, root: "" };
  }
  const topDirs = new Set(
    normalized
      .filter((e) => e.includes("/"))
      .map((e) => e.slice(0, e.indexOf("/"))),
  );
  if (topDirs.size === 1) {
    const only = [...topDirs][0]!;
    if (hasSkillMd(`${only}/`)) {
      return { ok: true, root: only };
    }
    return {
      ok: false,
      reason: "未找到 SKILL.md(须位于压缩包根或其唯一一级子目录)",
    };
  }
  return { ok: false, reason: "未找到 SKILL.md(压缩包含多个顶层目录)" };
}

/** 校验 SKILL.md frontmatter 必含 name 与 description(解析复用 skill-loader) */
export function validateSkillMd(
  raw: string,
): { ok: true; name: string; description: string } | ArchiveCheck {
  const { name, description } = parseFrontmatter(raw);
  if (!name) return { ok: false, reason: "SKILL.md 元数据缺少 name" };
  if (!description) {
    return { ok: false, reason: "SKILL.md 元数据缺少 description" };
  }
  return { ok: true, name, description };
}
