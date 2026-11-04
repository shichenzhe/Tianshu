/**
 * 专家目录运行时辅助（纯函数，专家 2.0）：专家附带技能并入会话技能清单。
 * 目录推荐指令段已删（2026-11-01 目录出 system 批，spec
 * docs/superpowers/specs/2026-11-01-expert-catalog-to-tool-design.md）：
 * 目录改随 list_experts 工具结果两跳注入。
 * 无 fs/electron 依赖（仅引工具名常量），vitest 直测（skill-prompt 先例）。
 */
import type { SkillInfo } from "../agent/skill-loader";

/**
 * JSON 数组字符串列解析（assistant 行 tags/quickPrompts/skillNames 同款）：
 * 坏数据回退空数组不抛错——展示/清单字段，行存在即不应让 send 失败。
 * assistant.repo 原私有 parseStringArray 收敛至此复用（避免双份实现）。
 */
export function parseJsonStringArray(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * 专家附带技能并入技能清单：并入 = skills ∪ (allSkills ∩ skillNames)，
 * 保持 skills 原序，新增项按 skillNames 序追加；skillNames 空/undefined
 * 原样返回（同一引用，未绑专家零成本）；已卸载（不在 allSkills）静略
 * ——按 name 匹配（与扫描同名去重键一致）。
 */
export function mergeExpertSkills(
  skills: SkillInfo[],
  skillNames: string[] | undefined,
  allSkills: SkillInfo[],
): SkillInfo[] {
  if (!skillNames || skillNames.length === 0) {
    return skills;
  }
  const present = new Set(skills.map((s) => s.name));
  const byName = new Map(allSkills.map((s) => [s.name, s]));
  const merged = [...skills];
  for (const name of skillNames) {
    const skill = byName.get(name);
    if (skill && !present.has(name)) {
      merged.push(skill);
      present.add(name);
    }
  }
  return merged;
}
