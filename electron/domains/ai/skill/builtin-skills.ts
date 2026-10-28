/**
 * 内置技能启动自愈安装(P-D spec §2):skill-creator 缺失时从应用资源复制到
 * userData/skills 并落库(source: builtin)。纯 Node(禁 import electron),
 * builtinRoot/skillsRoot/prisma 全注入可测。
 * 目录在 → 不复制(用户内容原样)但纠 source 为 builtin——自愈机制上线前的
 * 存量记录可能以 local 落库,不纠会混入「用户技能」组(分组/卸载拦截/
 * Badge 均按 source 判定);禁用记录不阻判定,卸载(目录被删)后
 * 重启恢复重装(内置语义,spec §6 决策 3)。
 */
import { cpSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../agent/skill-loader";
import type { SkillRecordPrismaLike } from "./skill-installer";

/** 内置技能清单(资源目录名 = frontmatter name,与 target 目录名一致) */
const BUILTIN_SKILL_NAMES = ["skill-creator", "workflow-creator"];

/**
 * 逐个确保内置技能已安装且 source 正确:目录缺 → cpSync 递归复制 +
 * upsert(全量);目录在 → 仅 upsert 纠 source(update 只写 source,
 * 启停/描述等用户状态原样保留)。
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
  if (!existsSync(targetDir)) {
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
    return;
  }
  // 目录在:不读源不复制;create 兜底 description 留空,由 list 对账补齐
  await deps.prisma.upsert({
    where: { name },
    create: {
      name,
      slug: null,
      version: null,
      source: "builtin",
      dir: targetDir,
      description: "",
    },
    update: { source: "builtin" },
  });
}
