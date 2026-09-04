/**
 * read_skill 内置工具（P2）：按名查 skills 表读 SKILL.md 正文
 * 纯 Node 实现（禁止 import electron），可被 vitest 直接测试；
 * execute 只查表内 name，不拼接任何外部路径 → 表外路径天然不可达
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { SkillInfo } from "./skill-loader";
import type { ToolDefinition } from "./file-tools";

/** 正文读取字节上限，超出截断并标注 */
const BODY_LIMIT = 256 * 1024;

/** 截断尾部标记 */
const TRUNCATED_SUFFIX = "\n…（已截断）";

export function makeReadSkillTool(
  skills: SkillInfo[],
): ToolDefinition<{ name: string }> {
  return {
    name: "read_skill",
    description: "读取指定技能的完整使用指引（SKILL.md 正文）",
    parameters: z.object({
      name: z.string().describe("技能名，来自系统提示中的技能清单"),
    }),
    kind: "read",
    execute: async (_ctx, args) => {
      // 精确匹配表内 name：查不到直接返回，不触任何磁盘读取
      const skill = skills.find((s) => s.name === args.name);
      if (!skill) return "错误: 技能不存在";
      let buf: Buffer;
      try {
        buf = readFileSync(skill.bodyPath);
      } catch {
        return "错误: 技能文件读取失败";
      }
      if (buf.byteLength > BODY_LIMIT) {
        return `${buf.subarray(0, BODY_LIMIT).toString("utf8")}${TRUNCATED_SUFFIX}`;
      }
      return buf.toString("utf8");
    },
  };
}
