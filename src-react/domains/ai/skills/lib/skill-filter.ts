/**
 * 技能列表本地搜索过滤(纯函数):匹配 name/slug/description,不区分大小写
 */
import type { SkillRecord } from "../api/skill.api";

export function filterSkillRecords(
  records: SkillRecord[],
  keyword: string,
): SkillRecord[] {
  const q = keyword.trim().toLowerCase();
  if (!q) {
    return records;
  }
  return records.filter(
    (r) =>
      r.name.toLowerCase().includes(q) ||
      (r.slug ?? "").toLowerCase().includes(q) ||
      (r.description ?? "").toLowerCase().includes(q),
  );
}
