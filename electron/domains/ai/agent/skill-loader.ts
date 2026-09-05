/**
 * SKILL.md 技能扫描与简易 frontmatter 解析（P2）
 * 纯 Node fs 同步实现（禁止 import electron），可被 vitest 直接测试；
 * 技能目录小、扫描快，chat:send 组装时即时调用（增删技能免重启生效）
 */
import { readdirSync, readFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";

export interface SkillInfo {
  /** frontmatter name（与目录名不一致时以此为准；同名去重键） */
  name: string;
  /** 一句话用途说明（注入 system prompt 供模型按需取用） */
  description: string;
  /** skill 条目目录（含 SKILL.md） */
  dir: string;
  /** SKILL.md 绝对路径（read_skill 工具按此读正文） */
  bodyPath: string;
  /** 来源：用户级（同名优先）或工作空间级 */
  source: "user" | "workspace";
}

/** frontmatter 字段行：键为 \w+，冒号后空白可有可无，值为行内剩余部分 */
const FIELD_RE = /^(\w+):\s*(.+)$/;

/**
 * 解析 `---` 包裹的简易 frontmatter，只提取 name/description 两字段。
 * 无包裹块、残缺块（缺结束 ---）或字段缺失 → 对应字段为 undefined，不抛错。
 */
export function parseFrontmatter(raw: string): {
  name?: string;
  description?: string;
} {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return {};
  const fields: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const match = FIELD_RE.exec(lines[i] ?? "");
    if (match) fields[match[1]!] = match[2]!.trim();
  }
  return { name: fields.name, description: fields.description };
}

/**
 * 按数组序扫描技能目录（用户级在前 = 优先级高）。
 * 条目 = 目录下含 SKILL.md 的子目录(点前缀隐藏目录跳过,如 .staging-* 残留)；
 * name/description 缺一跳过该 skill；
 * 同名（按 frontmatter name）后者忽略；目录不存在/不可读 → 静默跳过该 dir。
 */
export function loadSkills(
  dirs: Array<{ dir: string; source: "user" | "workspace" }>,
): SkillInfo[] {
  const skills: SkillInfo[] = [];
  const seen = new Set<string>();
  for (const { dir, source } of dirs) {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 目录不存在/不可读：静默跳过，不影响其余目录
    }
    for (const entry of entries) {
      // 点前缀隐藏目录(如 crash 残留的 .staging-*)不扫:防幽灵技能
      // 进 system prompt、同名去重抢占真名目录(dirs 传入的是 skills 根
      // 目录本身,其子条目无合法点前缀形态,过滤无副作用)
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const entryDir = path.join(dir, entry.name);
      const bodyPath = path.join(entryDir, "SKILL.md");
      let raw: string;
      try {
        raw = readFileSync(bodyPath, "utf8");
      } catch {
        continue; // 无 SKILL.md 或不可读：跳过该条目
      }
      const { name, description } = parseFrontmatter(raw);
      if (!name || !description || seen.has(name)) continue;
      seen.add(name);
      skills.push({ name, description, dir: entryDir, bodyPath, source });
    }
  }
  return skills;
}
