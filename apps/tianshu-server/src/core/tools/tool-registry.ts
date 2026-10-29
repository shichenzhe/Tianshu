/**
 * 工具注册表（自 mirror electron/domains/ai/agent/tool-registry.ts 移植）：
 * 初始集 = 内置文件五件 + bash + fetch（无头集）+ browser 四件
 * 桥版（TB-T1，spec §2.3：桥工具默认注册，无静态 capability 变化——运行
 * 时可用性由「有无活跃控制端连接」决定，离线即拒「桌面控制端不在线」）
 * + library_search（PL-2，spec §2.2：资料库语义检索，本地执行不依赖
 * 控制端；PL-3 裁定后无工作空间 graph/automation 会话亦常驻注入）；
 * plan_*（项目会话）与 create_skill（技能目录）由 ChatRunnerService 按
 * 会话装配 registerTools 注册先例。widget/mcp__ 与 dispatch 等渲染层/
 * 编排专属工具不注册。
 */
import type { ToolDefinition } from './tool-definition';
import { FILE_TOOLS } from './file-tools';
import { makeRunCommandTool } from './command-tool';
import { makeWebTools } from './web-tools';
import { BROWSER_BRIDGE_TOOLS } from './bridge/browser-bridge-tools';
import { LIBRARY_SEARCH_TOOL } from '../library/library-tools';
import { canonicalToolName } from '@tianshu/core';

const definitions: ToolDefinition[] = [
  ...FILE_TOOLS,
  makeRunCommandTool(),
  ...makeWebTools(),
  ...BROWSER_BRIDGE_TOOLS,
  // PL-2：library_search 资料库语义检索（read；db 经 graphExecutorRuntime
  // 取用时解析——注册先例同 BROWSER_BRIDGE_TOOLS，graph LLM 节点 tools:true
  // 经 registry 获得，PL-3 裁定后无工作空间会话亦常驻——collectTools 白
  // 名单点名，不再须绑工作空间或 node.tools 点名；chat 会话另经
  // collectToolDefinitions 显式 prisma 注入）
  LIBRARY_SEARCH_TOOL,
];

export const registry = {
  getDefinitions: () => definitions,
  // 老名归一（2026-10-29 改名批次，mirror 同款）：历史回喂/编辑重发的
  // 老名 tool_call 经 canonicalToolName 路由到新名工具，DB blocks 不迁移
  find: (name: string) =>
    definitions.find((tool) => tool.name === canonicalToolName(name)),
};

export function registerTools(defs: ToolDefinition[]): void {
  definitions.push(...defs);
}

/**
 * 按名注销工具，就地过滤以保持 getDefinitions 返回的活数组引用有效。
 * 返回移除数量。
 */
export function unregisterTools(names: string[]): number {
  const remove = new Set(names);
  const before = definitions.length;
  for (let i = definitions.length - 1; i >= 0; i--) {
    if (remove.has(definitions[i].name)) definitions.splice(i, 1);
  }
  return before - definitions.length;
}

/** 注入层过滤：禁用=对模型不存在。双侧经 canonicalToolName 归一成别名
 *  等价比较（mirror 同款）——DB 存老名（read_file 等）禁用语义跨改名延续 */
export function filterDisabledTools<T extends { name: string }>(
  defs: T[],
  disabled: Iterable<string>,
): T[] {
  const disabledSet = new Set([...disabled].map(canonicalToolName));
  return defs.filter(
    (def) => !disabledSet.has(canonicalToolName(def.name)),
  );
}
