import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { resolveDataRoot } from 'src/commons/util/path.util';

/** 备份根 env 名（容器部署 -e 映射宿主机卷；TIANSHU_* 同族命名，
 *  不走 config.yml 覆写链——db-url.ts 头注释 DATABASE_URL 冲掉坑） */
export const BACKUP_DIR_ENV = 'TIANSHU_BACKUP_DIR';

/** 备份根目录单一解析出口（防调用方散拼字符串）：
 * TIANSHU_BACKUP_DIR > <server 数据根>/backups */
export function resolveBackupRoot(): string {
  const root = process.env[BACKUP_DIR_ENV]?.trim()
    ? path.resolve(process.env[BACKUP_DIR_ENV]!.trim())
    : path.join(resolveDataRoot('~/.tianshu-server'), 'backups');
  mkdirSync(root, { recursive: true });
  return root;
}
