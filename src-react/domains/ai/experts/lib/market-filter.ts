/**
 * 市场过滤/排序纯函数（内存数据，无 IPC）
 */
import type { ExpertMarketItem } from "../data/marketplace";

export type ExpertSortBy = "comprehensive" | "hot" | "newest";

/** 关键词匹配：名称/身份标签/描述/标签，大小写不敏感 includes */
function matchesKeyword(item: ExpertMarketItem, keyword: string): boolean {
  const haystacks = [item.name, item.subtitle, item.description, ...item.tags];
  return haystacks.some((text) => text.toLowerCase().includes(keyword));
}

export function filterExperts(
  items: ExpertMarketItem[],
  filter: {
    keyword?: string;
    type?: "expert" | "team";
    category?: string;
    scenarioSlugs?: Set<string>;
  },
): ExpertMarketItem[] {
  const keyword = filter.keyword?.trim().toLowerCase();
  return items.filter((item) => {
    if (keyword && !matchesKeyword(item, keyword)) {
      return false;
    }
    if (filter.type && item.type !== filter.type) {
      return false;
    }
    if (filter.category && item.category !== filter.category) {
      return false;
    }
    if (filter.scenarioSlugs && !filter.scenarioSlugs.has(item.slug)) {
      return false;
    }
    return true;
  });
}

export function sortExperts(
  items: ExpertMarketItem[],
  sortBy: ExpertSortBy,
): ExpertMarketItem[] {
  const keyOf = (item: ExpertMarketItem): number | string =>
    sortBy === "comprehensive"
      ? item.score
      : sortBy === "hot"
        ? item.downloads
        : item.createdAt;
  // 同分稳定：sort 已是稳定实现，相等键不重排
  return [...items].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka === kb) {
      return 0;
    }
    return ka < kb ? 1 : -1;
  });
}
