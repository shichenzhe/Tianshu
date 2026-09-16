/**
 * 工具注册表：P2 MCP 工具聚合进同一注册表（spec 决策 #10）。
 * 初始集 = 内置文件四件 + run_command 终端工具（P3 spec §3）；mcp__ 动态注册
 */
import type { ToolDefinition } from "./file-tools";
import { FILE_TOOLS } from "./file-tools";
import { makeRunCommandTool } from "./command-tool";

const definitions: ToolDefinition[] = [...FILE_TOOLS, makeRunCommandTool()];

export const registry = {
  getDefinitions: () => definitions,
  find: (name: string) => definitions.find((tool) => tool.name === name),
};

export function registerTools(defs: ToolDefinition[]): void {
  definitions.push(...defs);
}

/**
 * 按 name 前缀批量注销工具（MCP 重连/停用时清旧注册），就地过滤以保持
 * getDefinitions 返回的活数组引用有效。返回移除数量。
 */
export function unregisterTools(prefix: string): number {
  const before = definitions.length;
  for (let i = definitions.length - 1; i >= 0; i--) {
    if (definitions[i].name.startsWith(prefix)) definitions.splice(i, 1);
  }
  return before - definitions.length;
}

/** 注入层过滤（SP6 裁定 1）：禁用=对模型不存在；只作用于内置工具名 */
export function filterDisabledTools<T extends { name: string }>(
  defs: T[],
  disabled: Iterable<string>,
): T[] {
  const disabledSet = new Set(disabled);
  return defs.filter((def) => !disabledSet.has(def.name));
}
