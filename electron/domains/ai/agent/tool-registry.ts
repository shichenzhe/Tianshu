/**
 * 工具注册表：P2 MCP 工具聚合进同一注册表（spec 决策 #10）。
 * 初始集 = 内置文件四件 + bash 终端工具（P3 spec §3）+ web 工具
 * （fetch/browse，spec 2026-10-13-ai-web-tools）+ browser_use
 * 工具组（操控会话绑定的右栏浏览器 tab，guest 注册表解析操控目标）；
 * mcp__ 动态注册
 */
import type { ToolDefinition } from "./file-tools";
import { FILE_TOOLS } from "./file-tools";
import { makeRunCommandTool } from "./command-tool";
import { makeWebTools } from "./web-tools";
import { makeBrowserTools } from "./browser-tools";
import { guestControlResolver } from "../browser/guest-registry-ipc";
import { canonicalToolName } from "@tianshu/core";

const definitions: ToolDefinition[] = [
  ...FILE_TOOLS,
  makeRunCommandTool(),
  ...makeWebTools(),
  ...makeBrowserTools(guestControlResolver),
];

export const registry = {
  getDefinitions: () => definitions,
  // 老名归一（2026-10-29 改名批次）：历史回喂/编辑重发的老名 tool_call
  // 经 canonicalToolName 路由到新名工具，DB blocks 不迁移
  find: (name: string) =>
    definitions.find((tool) => tool.name === canonicalToolName(name)),
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

/** 注入层过滤（SP6 裁定 1）：禁用=对模型不存在；只作用于内置工具名。
 *  双侧经 canonicalToolName 归一成别名等价比较——toolPermission DB 存老名
 *  （read_file 等老名），改名后禁用语义跨改名延续；过渡期老名 def 同样命中
 *  （终态生产面 def 恒新名） */
export function filterDisabledTools<T extends { name: string }>(
  defs: T[],
  disabled: Iterable<string>,
): T[] {
  const disabledSet = new Set([...disabled].map(canonicalToolName));
  return defs.filter(
    (def) => !disabledSet.has(canonicalToolName(def.name)),
  );
}
