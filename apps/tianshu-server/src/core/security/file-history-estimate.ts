/**
 * 批量删除预估（自 mirror electron/domains/security/file-history.ts 的
 * countFilesForEstimate 摘取，模块级纯函数）：walk 计数，达
 * ESTIMATE_COUNT_LIMIT 即停。根为文件计 1，不存在计 0。
 * 完整备份服务（FileHistoryService：快照/manifest/配额 LRU）未随本批
 * 移植——onBackupFile 回调契约保留，装配缺席时 write 覆盖前不备份
 * （fail-open 与 mirror 一致）。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

const ESTIMATE_COUNT_LIMIT = 10_000;

export async function countFilesForEstimate(root: string): Promise<number> {
  const st = await fsp.stat(root).catch(() => null);
  if (st === null) return 0;
  if (st.isFile()) return 1;
  let count = 0;
  const stack = [root];
  while (stack.length > 0 && count < ESTIMATE_COUNT_LIMIT) {
    const cur = stack.pop() as string;
    const entries = await fsp
      .readdir(cur, { withFileTypes: true })
      .catch(() => []);
    for (const ent of entries) {
      if (count >= ESTIMATE_COUNT_LIMIT) break;
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile()) count += 1;
    }
  }
  return count;
}
