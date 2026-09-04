/**
 * 工具注册表：P2 MCP 工具聚合进同一注册表（spec 决策 #10）
 */
import type { ToolDefinition } from "./file-tools";
import { FILE_TOOLS } from "./file-tools";

const definitions: ToolDefinition[] = [...FILE_TOOLS];

export const registry = {
  getDefinitions: () => definitions,
  find: (name: string) => definitions.find((tool) => tool.name === name),
};

export function registerTools(defs: ToolDefinition[]): void {
  definitions.push(...defs);
}
