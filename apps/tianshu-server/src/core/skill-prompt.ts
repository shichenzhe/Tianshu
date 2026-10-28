/**
 * system prompt 技能清单注入（P2 渐进披露，设计 spec §2）
 * 纯函数（无 fs/外部依赖）：skills 为空原样返回 base——零 token 开销、
 * 无 skill 时行为与 P1 完全一致；目录扫描由调用方负责。
 *
 * 移植自 mirror electron/domains/ai/agent/skill-prompt.ts（5526304）：
 * SkillInfo（mirror skill-loader 形状）此处收敛为最小结构 SkillSummary
 * ——buildSystemPrompt 仅消费 name/description，完整 SkillInfo 可直接
 * 传入（结构兼容），工具层引入后无需改动本文件。
 *
 * RC-T5：本文件为 server 保留件（context-usage/expert-catalog 的类型
 * 收敛来源，mirror 侧闭包不纯未入 @tianshu/core），入 T7 drift manifest。
 */

/** 技能摘要（buildSystemPrompt 消费的最小形状；完整 SkillInfo 结构兼容） */
export interface SkillSummary {
  /** frontmatter name（同名去重键） */
  name: string;
  /** 一句话用途说明（注入 system prompt 供模型按需取用） */
  description: string;
}

/** 技能段模板首行（spec §2 逐字） */
const SKILL_SECTION_HEADER =
  '你可以使用以下技能（调用 read_skill 工具并传入技能名可获取完整使用指引）：';

/**
 * 组装最终 system prompt：base 存在 → base + 空行 + 技能段；
 * base undefined → 仅技能段；skills 为空 → 原样返回 base（可能 undefined）
 */
export function buildSystemPrompt(
  base: string | undefined,
  skills: SkillSummary[],
): string | undefined {
  if (skills.length === 0) {
    return base;
  }
  const section = [
    SKILL_SECTION_HEADER,
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
  ].join('\n');
  return base === undefined ? section : `${base}\n\n${section}`;
}
