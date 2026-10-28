// 技能详情页取数（技能市场详情页化批）：v1 无 detail 端点，概要从
// marketItems 尽力解析——直找 → fallback 标记 → searchMarket({keyword:
// slug}, true) 回捞再查 → 仍无则 missing「不存在/已下架」占位。
// resolveSkillDetail 为纯函数（slug 查找/fallback/占位三分支单测）；
// loadSkillDetail 为编排（store 注入经模块 mock 测）。
import type { SkillHubSkillDto } from "@tianshu/protocol";

import { useSkillsStore } from "../store/skills.store";

export type SkillDetailResolution =
  | { kind: "found"; skill: SkillHubSkillDto }
  /** marketItems 无此 slug（深链进入/被筛选替换）——需 searchMarket 回捞 */
  | { kind: "fallback" }
  /** slug 非法或回捞后仍无——不存在/已下架 */
  | { kind: "missing" };

/** 纯函数：marketItems 按 slug 找 */
export function resolveSkillDetail(
  items: SkillHubSkillDto[],
  slug: string | null,
): SkillDetailResolution {
  if (typeof slug !== "string" || slug === "") return { kind: "missing" };
  const skill = items.find((item) => item.slug === slug);
  return skill ? { kind: "found", skill } : { kind: "fallback" };
}

/** 编排：直找 → 回捞（skillhub 无能力时 searchMarket 静默短路，结果仍
 *  归 missing——占位兜底）→ 再查，fallback 收敛为 missing */
export async function loadSkillDetail(
  slug: string | null,
): Promise<SkillDetailResolution> {
  const direct = resolveSkillDetail(
    useSkillsStore.getState().marketItems,
    slug,
  );
  if (direct.kind !== "fallback") return direct;
  await useSkillsStore.getState().searchMarket({ keyword: slug ?? "" }, true);
  const after = resolveSkillDetail(useSkillsStore.getState().marketItems, slug);
  return after.kind === "fallback" ? { kind: "missing" } : after;
}
