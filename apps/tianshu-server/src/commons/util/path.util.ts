/**
 * 路径工具：~ 展开 + 数据根解析（files.service 原私有实现提取——
 * backup-root 同源消费，两处各留一份会漂移，DRY 收口）。
 */
import os from 'node:os';
import path from 'node:path';

/** ~ 展开为 home（files.service 原实现提取，backup-root 同源消费） */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** 数据根解析：TIANSHU_DATA_ROOT 环境变量 > 配置值 */
export function resolveDataRoot(configured: string): string {
  return process.env.TIANSHU_DATA_ROOT
    ? process.env.TIANSHU_DATA_ROOT
    : expandHome(configured);
}
