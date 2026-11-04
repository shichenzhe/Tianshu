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

/**
 * 「我安装的」分区(纯函数):按 source 划分用户技能与系统技能——
 * builtin 为启动自愈预置(不可卸载,仅可禁用),单独成组展示
 */
export function partitionSkillRecords(records: SkillRecord[]): {
  user: SkillRecord[];
  system: SkillRecord[];
} {
  const user: SkillRecord[] = [];
  const system: SkillRecord[] = [];
  for (const r of records) {
    (r.source === "builtin" ? system : user).push(r);
  }
  return { user, system };
}
