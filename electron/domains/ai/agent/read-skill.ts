/**
 * read_skill 内置工具（P2）：按名查 skills 表读 SKILL.md 正文；
 * 可选 path 读技能包内子文件（references/*.md 等渐进披露文档）
 * 纯 Node 实现（禁止 import electron），可被 vitest 直接测试；
 * execute 只查表内 name，path 以命中技能的 dir 为锚做双重边界校验
 * （resolve 前缀 + realpath 跟随）→ 包外路径天然不可达。
 * 项目会话传全量启用扫描集（挂载集是预设而非围墙，预设外技能
 * 会话中按需可读，见 project-prompt 预设能力声明）
 * onRead（读取即意图信号）：成功读取后以 (ctx, skill) 触发，返回串以
 * 空行追加在正文尾（截断路径同样触发；查无/读败/越界不触发）——工作流组
 * 开门（chat.service 会话意图集）经它挂载，双份副本同构
 */
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { SkillInfo } from "./skill-loader";
import type { ToolContext, ToolDefinition } from "./file-tools";

/** 正文读取字节上限，超出截断并标注 */
const BODY_LIMIT = 256 * 1024;

/** 截断尾部标记 */
const TRUNCATED_SUFFIX = "\n…（已截断）";

/**
 * 对可能不存在的路径取 realpath：沿祖先上溯到存在的一级，再拼回缺失段
 * （与 file-tools realPathLenient 同构；本文件禁 import electron 故不复用其导出）
 */
function realPathLenient(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    const parent = path.dirname(target);
    if (parent === target) return target;
    return path.join(realPathLenient(parent), path.basename(target));
  }
}

/**
 * 技能包内相对路径安全解析：resolve 前缀校验 + realpath 跟随后再校验
 * （防 ../ 字面逃逸与包内 symlink 指向包外），越界返回 null
 */
function resolveWithinSkillDir(dir: string, rel: string): string | null {
  const abs = path.resolve(dir, rel);
  if (abs !== dir && !abs.startsWith(dir + path.sep)) return null;
  const realDir = realPathLenient(dir);
  const realAbs = realPathLenient(abs);
  if (realAbs !== realDir && !realAbs.startsWith(realDir + path.sep)) {
    return null;
  }
  return abs;
}

export function makeReadSkillTool(
  skills: SkillInfo[],
  onRead?: (ctx: ToolContext, skill: SkillInfo) => string | void,
): ToolDefinition<{ name: string; path?: string }> {
  return {
    name: "read_skill",
    description:
      "读取技能使用指引：传技能名读 SKILL.md 正文；可传 path 读技能包内文件（如 references/jira.md）",
    parameters: z.object({
      name: z.string().describe("技能名，来自系统提示中的技能清单"),
      path: z
        .string()
        .optional()
        .describe(
          "技能包内相对路径（如 references/jira.md），缺省读 SKILL.md 正文",
        ),
    }),
    kind: "read",
    execute: async (ctx, args) => {
      // 精确匹配表内 name：查不到直接返回，不触任何磁盘读取
      const skill = skills.find((s) => s.name === args.name);
      if (!skill) return "错误: 技能不存在";
      // path 缺省读正文；给定则以技能目录为锚解析，越界即拒绝（不触读）
      const target = args.path
        ? resolveWithinSkillDir(skill.dir, args.path)
        : skill.bodyPath;
      if (!target) return "错误: 路径超出技能目录";
      let buf: Buffer;
      try {
        buf = readFileSync(target);
      } catch {
        return "错误: 技能文件读取失败";
      }
      if (buf.includes(0)) return "错误: 文件含二进制内容（NUL），不支持读取";
      const body =
        buf.byteLength > BODY_LIMIT
          ? `${buf.subarray(0, BODY_LIMIT).toString("utf8")}${TRUNCATED_SUFFIX}`
          : buf.toString("utf8");
      const note = onRead?.(ctx, skill);
      return note ? `${body}\n\n${note}` : body;
    },
  };
}
