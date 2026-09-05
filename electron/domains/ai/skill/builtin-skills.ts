/**
 * 内置技能启动自愈安装(P-D spec §2):skill-creator 缺失时从应用资源复制到
 * userData/skills 并落库(source: builtin)。纯 Node(禁 import electron),
 * builtinRoot/skillsRoot/prisma 全注入可测。
 * 跳过判定只看目标目录是否存在——禁用记录不阻判定,卸载(目录被删)后
 * 重启恢复重装(内置语义,spec §6 决策 3)。
 */
import { cpSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../agent/skill-loader";
import type { SkillRecordPrismaLike } from "./skill-installer";

/** 内置技能清单(资源目录名 = frontmatter name,与 target 目录名一致) */
const BUILTIN_SKILL_NAMES = ["skill-creator"];

/**
 * 逐个确保内置技能已安装:目录在 → 跳过;目录缺失 → cpSync 递归复制 +
 * upsert(source builtin,description 读资源 SKILL.md frontmatter)。
 * upsert 而非 create:卸载残留的旧记录(含禁用态)会被纠正回内置来源。
 */
export async function ensureBuiltinSkills(deps: {
  builtinRoot: string;
  skillsRoot: string;
  prisma: SkillRecordPrismaLike;
}): Promise<void> {
  for (const name of BUILTIN_SKILL_NAMES) {
    await ensureOne(name, deps);
  }
}

async function ensureOne(
  name: string,
  deps: {
    builtinRoot: string;
    skillsRoot: string;
    prisma: SkillRecordPrismaLike;
  },
): Promise<void> {
  const sourceDir = path.join(deps.builtinRoot, name);
  const targetDir = path.join(deps.skillsRoot, name);
  if (existsSync(targetDir)) return;
  const { description } = parseFrontmatter(
    readFileSync(path.join(sourceDir, "SKILL.md"), "utf8"),
  );
  cpSync(sourceDir, targetDir, { recursive: true });
  const data = {
    slug: null,
    version: null,
    source: "builtin",
    dir: targetDir,
    description: description ?? "",
  };
  await deps.prisma.upsert({
    where: { name },
    create: { name, ...data },
    update: data,
  });
}
