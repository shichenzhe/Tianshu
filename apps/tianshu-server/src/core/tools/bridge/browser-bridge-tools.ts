/**
 * browser 四工具桥版定义（TB-T1，spec §3）：zod schema/description/kind 与
 * mirror electron/domains/ai/agent/browser-tools.ts 同构副本（定义段逐字；
 * 改动须双仓同步——drift manifest 入册见 TB-T3）。执行体不移植——
 * 无头端无 GuestControl，= emitToolRequest 广播 tool.request 后挂起等
 * 控制端桌面执行回传（bridge-registry.ts）：
 * - SSRF/URL 校验、页面脚本注入（JSON.stringify 转义铁律）全部留在
 *   控制端执行面（TB-T2 复用 mirror 工具函数），本侧零浏览器语义；
 * - kind 保持 mirror 原值（snapshot/navigate=read、click/type=write）：
 *   TB-T2/R3 裁定：桥 write 工具豁免 server 本机 write 门禁（无头端无人
 *   审批，spec §4.2 本意）——default accessMode 下仍发出 tool.request，
 *   审批转控制端桌面审批卡；豁免面经 BRIDGE_TOOL_NAMES 精确到桥工具
 *   （非全部 write）。
 */
import { z } from 'zod';
import type { ToolDefinition } from '../tool-definition';
import { fail } from '../file-tools';
import { emitToolRequest } from './bridge-registry';

/** 桥结果 → 工具输出（错误经 fail 统一「错误:」前缀回喂模型） */
function bridgeOutput(
  result: Awaited<ReturnType<typeof emitToolRequest>>,
): string {
  return result.ok ? result.output : fail(result.error);
}

/** 桥调用公共通道：args 原样（zod 已校验）随 tool.request 广播；图执行
 *  无会话 sessionId=null 照常发起（桥窗与本地会话 tab 无关） */
function callBridge(
  sessionId: number | null,
  tool:
    'browser_snapshot' | 'browser_navigate' | 'browser_click' | 'browser_type',
  args: Record<string, unknown>,
): Promise<string> {
  return emitToolRequest(sessionId, tool, args).then(bridgeOutput);
}

export function makeBrowserBridgeTools(): ToolDefinition[] {
  const snapshot: ToolDefinition<Record<string, never>> = {
    name: 'browser_snapshot',
    description: '读取浏览器页快照（可交互元素序号与正文摘要）',
    parameters: z.object({}),
    kind: 'read',
    execute: async (ctx, args) =>
      callBridge(ctx.sessionId, 'browser_snapshot', args),
  };

  const navigate: ToolDefinition<{ url: string }> = {
    name: 'browser_navigate',
    description: '导航会话浏览器页到新地址（http/https）',
    parameters: z.object({ url: z.string().describe('目标地址') }),
    kind: 'read',
    execute: async (ctx, { url }) =>
      callBridge(ctx.sessionId, 'browser_navigate', { url }),
  };

  const click: ToolDefinition<{ idx: number }> = {
    name: 'browser_click',
    description: '点击快照序号对应元素；页面刷新后序号失效需重新快照',
    parameters: z.object({
      idx: z.number().int().describe('快照里的元素序号'),
    }),
    kind: 'write',
    execute: async (ctx, { idx }) =>
      callBridge(ctx.sessionId, 'browser_click', { idx }),
  };

  const type: ToolDefinition<{ idx: number; text: string }> = {
    name: 'browser_type',
    description: '填入文本到快照序号对应的输入框',
    parameters: z.object({
      idx: z.number().int().describe('快照里的输入框序号'),
      text: z.string().describe('要输入的文本'),
    }),
    kind: 'write',
    execute: async (ctx, { idx, text }) =>
      callBridge(ctx.sessionId, 'browser_type', { idx, text }),
  };

  return [snapshot, navigate, click, type];
}

/** 注册表静态装配用的单例（定义无状态，进程内共享安全） */
export const BROWSER_BRIDGE_TOOLS = makeBrowserBridgeTools();

/** 桥工具名集合（TB-T2/R3）：tool-gate write 门禁豁免判定面——发
 *  tool.request 的工具不经本机 write 拒绝链（审批转控制端），非桥 write
 *  工具照旧走完整判定 */
export const BRIDGE_TOOL_NAMES = new Set<string>(
  BROWSER_BRIDGE_TOOLS.map((def) => def.name),
);
