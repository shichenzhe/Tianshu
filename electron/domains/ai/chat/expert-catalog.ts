/**
 * 专家目录运行时辅助（纯函数，专家 2.0）：专家附带技能并入会话技能清单
 * + 未绑专家会话的目录推荐指令段构造（WorkBuddy recommend-experts 语义）。
 * 无 fs/electron 依赖（仅引工具名常量），vitest 直测（skill-prompt 先例）。
 */
import type { SkillInfo } from "../agent/skill-loader";
import { RECOMMEND_TOOL_NAME } from "../agent/recommend-expert-tool";
import type { ExpertMarketItem } from "../../../../src-react/domains/ai/experts/data/marketplace";

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

/**
 * 专家目录推荐指令段（未绑专家的 agent 会话注入）：目录条目 +
 * recommend_expert 工具使用规则（文案给模型看，不进前端 i18n）。
 */
export function buildExpertCatalogPrompt(items: ExpertMarketItem[]): string {
  const lines = items.map(
    (e) => `- ${e.slug}｜${e.name}（${e.subtitle}）：${e.description}`,
  );
  return [
    "【专家目录】以下为可推荐的内置专家（按需选 1-3 位）：",
    ...lines,
    "",
    `当任务明显受益于某专业角色时，调用 ${RECOMMEND_TOOL_NAME} 工具渲染推荐卡` +
      "（参数 candidates 为 slug 数组、reason 一句话理由）。规则：当前会话" +
      "已绑定专家时禁止推荐；每次回复调用最多一次；用户未采纳不重复推荐；" +
      "不得代替用户启用专家；任务与目录无明显匹配时静默继续任务。",
  ].join("\n");
}
