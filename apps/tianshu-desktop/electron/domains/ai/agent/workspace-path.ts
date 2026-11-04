/** 工作空间路径规范化（自 chat.service 抽出解环，终审 deferred 批次 4）：
 * chat.service / orchestration graph-executor / automation-runner 共用。
 * 纯函数仅依赖 node:path，落位 agent/ 与 tool-gate 同层——graph-executor
 * 不再为这一个函数传递拉取整个 chat.service。语义与抽出前逐行为等价。 */
import path from "node:path";

/** resolve 绝对化并去尾部分隔符（T2 review carry） */
export function normalizeWorkspacePath(directoryPath: string): string {
  const resolved = path.resolve(directoryPath);
  return resolved.length > 1 && resolved.endsWith(path.sep)
    ? resolved.slice(0, -1)
    : resolved;
}
