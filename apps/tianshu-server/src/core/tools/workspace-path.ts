/**
 * 工作空间路径规范化（自 mirror electron/domains/ai/agent/workspace-path.ts
 * 逐字移植）：resolve 绝对化并去尾部分隔符。
 */
import path from 'node:path';

export function normalizeWorkspacePath(directoryPath: string): string {
  const resolved = path.resolve(directoryPath);
  return resolved.length > 1 && resolved.endsWith(path.sep)
    ? resolved.slice(0, -1)
    : resolved;
}
