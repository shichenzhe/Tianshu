// 技能市场排序纯函数（detail 批）：综合=score / 热门=downloads / 最新=
// createdAt（epoch ms）desc——照专家市场排序三档先例同口径；缺 createdAt
// 行沉底（旧被控端未下发可选段，0 参与倒序自然落尾）；copy+sort 不变更
// 输入、同键稳定不重排（sort 稳定语义）。
import type { SkillHubSkillDto } from "@tianshu/protocol";

export type MarketSortMode = "comprehensive" | "hot" | "newest";

export function sortMarketItems(
  items: SkillHubSkillDto[],
  mode: MarketSortMode,
): SkillHubSkillDto[] {
  if (mode === "newest") {
    return [...items].sort(
      (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
    );
  }
  const key = mode === "hot" ? "downloads" : "score";
  return [...items].sort((a, b) => b[key] - a[key]);
}
