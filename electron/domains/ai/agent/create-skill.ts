/**
 * create_skill 内置工具（P-D Task 2）：把模型创作的技能落盘到 userData/skills
 * 并入库（source local）。纯 Node 实现（禁止 import electron），skillsRoot/
 * prisma 注入可测；kind write → 走统一审批（runToolCall 挂起，批准后才 execute）。
 * 安全双层：validateCreateSkillParams 纯函数校验链先行（zod + name/path/上限），
 * 执行层对每个目标文件 path.join 后再以 isInsideDir（resolve 型）复核。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { validateSkillMd } from "../skill/skill-archive";
import { isInsideDir } from "../skill/skill-sync";
import type { SkillRecordPrismaLike } from "../skill/skill-installer";
import type { ToolDefinition } from "./file-tools";

/** 数值约束与 skill-creator SKILL.md 第四步一致（改动须两处同步） */
const LIMITS = {
  maxFiles: 20,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 1024 * 1024,
} as const;

/** name kebab-case（与 SKILL.md frontmatter 约束一致，且严于 isSafeDirName） */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Windows 盘符原语（如 C:/x；posix.isAbsolute 放行，须单独兜底） */
const DRIVE_LETTER_RE = /^[A-Za-z]:/;

export interface CreateSkillParams {
  name: string;
  description: string;
  files: Array<{ path: string; content: string }>;
}

export type CreateSkillCheck =
  | {
      ok: true;
      name: string;
      description: string;
      files: CreateSkillParams["files"];
    }
  | { ok: false; reason: string };

const createSkillSchema = z.object({
  name: z
    .string()
    .describe("技能名，kebab-case，须与 SKILL.md frontmatter 的 name 一致"),
  description: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "技能一句话用途说明，须与 SKILL.md frontmatter 的 description 一致",
    ),
  files: z
    .array(
      z.object({
        path: z
          .string()
          .describe(
            "相对技能目录的路径（如 SKILL.md、references/xxx.md），禁止 .. 与绝对路径",
          ),
        content: z.string().describe("完整文件内容（UTF-8 文本）"),
      }),
    )
    .min(1)
    .describe(
      `技能文件清单，必须包含 SKILL.md；条目 ≤ ${LIMITS.maxFiles}、单文件 ≤ 256KB、总量 ≤ 1MB。请先阅读 skill-creator 技能的创作规范再调用`,
    ),
});

/**
 * 校验链（调用顺序固定）：zod 结构 → name kebab-case → 条目数 →
 * 逐条 path 安全与字节上限 → SKILL.md 必含且过 validateSkillMd →
 * frontmatter name 与参数一致（目录/记录/frontmatter 三方同源的基石）
 */
export function validateCreateSkillParams(args: unknown): CreateSkillCheck {
  const parsed = createSkillSchema.safeParse(args);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `参数不合法: ${parsed.error.issues[0]?.message ?? "结构错误"}`,
    };
  }
  const { name, description, files } = parsed.data;
  if (!NAME_RE.test(name)) {
    return {
      ok: false,
      reason: `技能名须为 kebab-case（^[a-z0-9][a-z0-9-]*$）: ${name}`,
    };
  }
  if (files.length > LIMITS.maxFiles) {
    return { ok: false, reason: `文件条目数超过上限（${LIMITS.maxFiles}）` };
  }
  let totalBytes = 0;
  for (const file of files) {
    const normalized = file.path.replace(/\\/g, "/");
    if (normalized.trim() === "" || normalized.endsWith("/")) {
      return { ok: false, reason: `文件路径不能为空或指向目录: ${file.path}` };
    }
    if (
      path.posix.isAbsolute(normalized) ||
      DRIVE_LETTER_RE.test(normalized) ||
      normalized.split("/").includes("..")
    ) {
      return {
        ok: false,
        reason: `存在不安全路径（禁止 .. 与绝对路径）: ${file.path}`,
      };
    }
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > LIMITS.maxFileBytes) {
      return {
        ok: false,
        reason: `单文件超过大小上限（${LIMITS.maxFileBytes} 字节）: ${file.path}`,
      };
    }
    totalBytes += bytes;
    if (totalBytes > LIMITS.maxTotalBytes) {
      return {
        ok: false,
        reason: `文件总量超过大小上限（${LIMITS.maxTotalBytes} 字节）`,
      };
    }
  }
  const skillMd = files.find(
    (file) => file.path.replace(/\\/g, "/") === "SKILL.md",
  );
  if (!skillMd) {
    return { ok: false, reason: "files 必须包含 SKILL.md" };
  }
  const meta = validateSkillMd(skillMd.content) as
    | { ok: false; reason: string }
    | { ok: true; name: string; description: string };
  if (!meta.ok)
    return { ok: false, reason: `SKILL.md 校验失败: ${meta.reason}` };
  if (meta.name !== name) {
    return {
      ok: false,
      reason: `SKILL.md frontmatter 的 name（${meta.name}）须与参数 name（${name}）一致`,
    };
  }
  return {
    ok: true,
    name,
    description,
    files: files.map((file) => ({
      ...file,
      path: file.path.replace(/\\/g, "/"),
    })),
  };
}

export function makeCreateSkillTool(deps: {
  skillsRoot: string;
  prisma: SkillRecordPrismaLike;
}): ToolDefinition<CreateSkillParams> {
  return {
    name: "create_skill",
    description:
      "创建一个新技能并安装到用户技能目录（写操作，需用户批准）。传入技能名、一句话描述与文件清单（必须包含 SKILL.md），下次对话即可使用；请先阅读 skill-creator 技能的创作规范再调用",
    parameters: createSkillSchema,
    kind: "write",
    execute: async (_ctx, args) => {
      const check = validateCreateSkillParams(args);
      if (!check.ok) return `错误: ${check.reason}`;
      const skillDir = path.join(deps.skillsRoot, check.name);
      if (existsSync(skillDir)) {
        return "错误: 技能已存在,请先在技能页卸载后重试";
      }
      try {
        mkdirSync(skillDir, { recursive: true });
        for (const file of check.files) {
          const dest = path.join(skillDir, file.path);
          // resolve 型复核：兜住校验层归一后仍可能放行的组合段
          if (!isInsideDir(dest, skillDir)) {
            throw new Error(`存在不安全路径: ${file.path}`);
          }
          mkdirSync(path.dirname(dest), { recursive: true });
          writeFileSync(dest, file.content, "utf8");
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        try {
          rmSync(skillDir, { recursive: true, force: true });
        } catch {
          // 清理失败不掩盖原错误；残留目录由技能页卸载兜底
        }
        return `错误: 技能写入失败（${message}），已清理半成品目录`;
      }
      const data = {
        slug: null,
        version: null,
        source: "local",
        dir: skillDir,
        description: check.description,
      };
      await deps.prisma.upsert({
        where: { name: check.name },
        create: { name: check.name, ...data },
        update: data,
      });
      return `已创建技能 ${check.name},可在技能页管理,下次对话即可使用`;
    },
  };
}
