/**
 * system prompt 技能清单注入（P2 渐进披露，设计 spec §2）
 * 纯函数（无 fs/electron 依赖）：skills 为空原样返回 base——零 token 开销、
 * 无 skill 时行为与 P1 完全一致；目录扫描由调用方（chat.service）负责
 */
import type { SkillInfo } from "./skill-loader";

/** 技能段模板首行（spec §2 逐字） */
const SKILL_SECTION_HEADER =
  "你可以使用以下技能（调用 read_skill 工具并传入技能名可获取完整使用指引）：";

/**
 * 组装最终 system prompt：base 存在 → base + 空行 + 技能段；
 * base undefined → 仅技能段；skills 为空 → 原样返回 base（可能 undefined）
 */
export function buildSystemPrompt(
  base: string | undefined,
  skills: SkillInfo[],
): string | undefined {
  if (skills.length === 0) {
    return base;
  }
  const section = [
    SKILL_SECTION_HEADER,
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
  ].join("\n");
  return base === undefined ? section : `${base}\n\n${section}`;
}
