/**
 * 技能对账纯函数(P-A spec §4):目录为文件源、DB 为状态源。
 * key = frontmatter name(与 skill-loader 去重键一致);无 electron/fs 依赖,可直测
 */
import path from "node:path";

export interface SkillRecordRow {
  id: number;
  name: string;
  source: string;
  dir: string;
  version: string | null;
  description: string | null;
}

export interface SkillInsert {
  name: string;
  source: string;
  dir: string;
  description: string;
}

export interface SkillUpdate {
  id: number;
  dir: string;
  description: string;
}

export interface SkillSyncPlan {
  toInsert: SkillInsert[];
  toDeleteIds: number[];
  toUpdate: SkillUpdate[];
}

export function syncSkillRecords(
  scanned: Array<{ name: string; description: string; dir: string }>,
  records: SkillRecordRow[],
): SkillSyncPlan {
  const byName = new Map(records.map((row) => [row.name, row]));
  const seen = new Set<string>();
  const toInsert: SkillInsert[] = [];
  const toUpdate: SkillUpdate[] = [];
  for (const item of scanned) {
    seen.add(item.name);
    const row = byName.get(item.name);
    if (!row) {
      toInsert.push({
        name: item.name,
        source: "local",
        dir: item.dir,
        description: item.description,
      });
    } else if (row.dir !== item.dir || row.description !== item.description) {
      toUpdate.push({
        id: row.id,
        dir: item.dir,
        description: item.description,
      });
    }
  }
  const toDeleteIds = records
    .filter((row) => !seen.has(row.name))
    .map((row) => row.id);
  return { toInsert, toDeleteIds, toUpdate };
}

export function filterDisabledSkills<
  T extends { name: string; source: string },
>(skills: T[], disabled: Set<string>): T[] {
  return skills.filter((s) => !(s.source === "user" && disabled.has(s.name)));
}

/** target 是否位于 root 目录内(path.resolve 归一后前缀校验,防 ../ 逃逸) */
export function isInsideDir(target: string, root: string): boolean {
  const t = path.resolve(target);
  const r = path.resolve(root);
  return t === r || t.startsWith(r + path.sep);
}
