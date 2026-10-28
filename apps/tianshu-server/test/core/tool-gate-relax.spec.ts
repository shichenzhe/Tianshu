// 权限放宽批（2026-10-24 spec §4.4/§4.5）tool-gate 级用例——mirror
// tests/security/command-gate-integration.test.ts 的「权限放宽」两段同构
// 移植（server 侧 run_command 用替身 def，不落 shell；危险工具前置门/
// autoDenyApprovals 语义为 server 特有对照面）。审批面收窄为「高危询问」：
// 普通命令/write_file 工作空间内/DB 写/网络域直执行；危险分级
// HIGH/CRITICAL 两档均审批（full 亦不豁免，对齐 WorkBuddy bypass）。
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APPROVAL_AUTO_DENIED_OUTPUT,
  COMMAND_DISABLED_OUTPUT,
  runToolCall,
  type AgentStreamOptions,
} from 'src/core/tools/tool-gate';
import { makeFileTool } from 'src/core/tools/file-tools';
import type { ToolDefinition } from 'src/core/tools/tool-definition';
import type { SecurityEvent } from 'src/core/tools/security-events';
import type { ChatStreamChunk } from '@tianshu/protocol';

/** write_file 直执行用例的临时工作空间（真实落盘断言） */
let workspace = '';

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'tianshu-relax-'));
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function makeAgent(
  over: Partial<AgentStreamOptions>,
): AgentStreamOptions & { events: SecurityEvent[]; approvals: string[] } {
  const events: SecurityEvent[] = [];
  const approvals: string[] = [];
  return {
    sessionId: 5,
    fullAccess: () => false,
    isToolAllowed: () => Promise.resolve(false),
    requestApproval: async (id: string) => {
      approvals.push(id);
      return true;
    },
    onSecurityEvent: (e) => events.push(e),
    // 危险工具前置门放行（本组用例验的是放行后的判定链）
    allowDangerousTools: true,
    events,
    approvals,
    ...over,
  };
}

/** run_command 替身：name/kind 是门禁判定输入，execute 不落 shell——
 *  用例只验判定序与审批触发 */
const runCommandDef: ToolDefinition = {
  name: 'run_command',
  description: 'stub',
  parameters: {},
  kind: 'write',
  execute: async () => 'ok',
};

/** AUTO_EXEMPT/网络域免审面验证的最小 write stub（name 由用例覆写） */
const writeDefBase: ToolDefinition = {
  name: 'stub_write',
  description: 'stub',
  parameters: {},
  kind: 'write',
  execute: async () => 'ok',
};

/** denied 终态 chunk 计数（autoDeny 断言用） */
function countDenied(chunks: ChatStreamChunk[]): number {
  return chunks.filter(
    (chunk) =>
      chunk.type === 'tool-update' &&
      (chunk as { state: string }).state === 'denied',
  ).length;
}

describe('runToolCall 权限放宽：危险命令分级', () => {
  it('default 档普通命令直执行（兜底审批移除）', async () => {
    const agent = makeAgent({ decideCommand: () => 'default' });
    const out = await runToolCall(
      runCommandDef,
      agent,
      'c1',
      {
        command: 'ls -la',
      },
      undefined,
    );
    expect(out).toBe('ok');
    expect(agent.approvals).toHaveLength(0);
  });

  it('危险分级命中 default 档强制审批 + risk-table 事件（mirror 同构）', async () => {
    const agent = makeAgent({ decideCommand: () => 'default' });
    await runToolCall(
      runCommandDef,
      agent,
      'c2',
      {
        command: 'sudo rm -r x',
      },
      undefined,
    );
    expect(agent.approvals).toHaveLength(1);
    const riskEvent = agent.events.find(
      (e) => e.eventType === 'command-safety.needs-approval',
    );
    expect(riskEvent?.detail).toMatchObject({
      source: 'risk-table',
      risk: 'high',
    });
  });

  it('危险分级命中 full 档仍审批（对齐 WorkBuddy bypass）', async () => {
    const agent = makeAgent({
      fullAccess: () => true,
      decideCommand: () => 'default',
    });
    await runToolCall(
      runCommandDef,
      agent,
      'c3',
      {
        command: 'git reset --hard',
      },
      undefined,
    );
    expect(agent.approvals).toHaveLength(1);
  });

  it('cmdAsk 命中 full 档放行（full=免责+内置硬线）', async () => {
    const agent = makeAgent({
      fullAccess: () => true,
      decideCommand: () => 'ask',
    });
    const out = await runToolCall(
      runCommandDef,
      agent,
      'c4',
      {
        command: 'mytool x',
      },
      undefined,
    );
    expect(out).toBe('ok');
    expect(agent.approvals).toHaveLength(0);
  });

  it('cmdAsk 命中 default 档仍审批（full 短路豁免的对照面）', async () => {
    const agent = makeAgent({ decideCommand: () => 'ask' });
    await runToolCall(
      runCommandDef,
      agent,
      'c4b',
      { command: 'echo hi' },
      undefined,
    );
    expect(agent.approvals).toHaveLength(1);
  });

  it('autoDenyApprovals 对危险命中自动拒（T7 无头裁定，不挂起）', async () => {
    const agent = makeAgent({
      autoDenyApprovals: true,
      decideCommand: () => 'default',
    });
    const chunks: ChatStreamChunk[] = [];
    const out = await runToolCall(
      runCommandDef,
      agent,
      'c5',
      { command: 'sudo reboot' },
      undefined,
      (chunk) => chunks.push(chunk),
    );
    expect(out).toBe(APPROVAL_AUTO_DENIED_OUTPUT);
    expect(agent.approvals).toHaveLength(0);
    expect(countDenied(chunks)).toBe(1);
  });

  it('allowDangerousTools=false：危险工具前置门整体拒绝（先于分级判定）', async () => {
    const agent = makeAgent({
      allowDangerousTools: false,
      decideCommand: () => 'default',
    });
    const out = await runToolCall(
      runCommandDef,
      agent,
      'c0',
      {
        command: 'sudo rm -r x',
      },
      undefined,
    );
    expect(out).toBe(COMMAND_DISABLED_OUTPUT);
    expect(agent.approvals).toHaveLength(0);
  });
});

describe('runToolCall 权限放宽：write 兜底收窄', () => {
  it('write_file default 档直执行（工作空间内免审），文件真实落盘', async () => {
    const agent = makeAgent({
      decideCommand: () => 'default',
      workspacePath: workspace,
    });
    const out = await runToolCall(
      makeFileTool('write_file'),
      agent,
      'c6',
      {
        path: 'relax.txt',
        content: 'x',
      },
      undefined,
    );
    expect(out).toContain('已写入');
    expect(agent.approvals).toHaveLength(0);
    expect(existsSync(join(workspace, 'relax.txt'))).toBe(true);
    // 直执行决策留痕（spec §4.7，mirror 同构）：auto-allowed info 事件
    const autoAllowed = agent.events.find(
      (e) => e.eventType === 'file-safety.auto-allowed',
    );
    expect(autoAllowed?.detail).toMatchObject({ reason: 'workspace-write' });
  });

  it('delete_file default 档仍审批（delete=ask 裁定，兜底审批面剩余项）', async () => {
    const agent = makeAgent({ decideCommand: () => 'default' });
    await runToolCall(
      { ...writeDefBase, name: 'delete_file' },
      agent,
      'c8',
      {
        path: 'a.txt',
      },
      undefined,
    );
    expect(agent.approvals).toHaveLength(1);
  });

  it('full 档其余 write（delete_file）直执行（询问面全豁免，mirror 3c 同构）', async () => {
    const agent = makeAgent({
      fullAccess: () => true,
      decideCommand: () => 'default',
    });
    await runToolCall(
      { ...writeDefBase, name: 'delete_file' },
      agent,
      'c10',
      {
        path: 'a.txt',
      },
      undefined,
    );
    expect(agent.approvals).toHaveLength(0);
  });

  it.each([
    'plan_create_item',
    'plan_update_status',
    'plan_append_summary',
    'create_skill',
  ])('DB 写工具 %s 直执行', async (name) => {
    const agent = makeAgent({ decideCommand: () => 'default' });
    const out = await runToolCall(
      { ...writeDefBase, name },
      agent,
      'c9-' + name,
      {},
      undefined,
    );
    expect(out).toBe('ok');
    expect(agent.approvals).toHaveLength(0);
  });
});

describe('网络域免审（2026-10-24 裁定重落：任何档位直执行）', () => {
  it.each([
    'web_fetch',
    'open_browser',
    'browser_snapshot',
    'browser_navigate',
    'browser_click',
    'browser_type',
    'mcp__anyServer_anyTool',
  ])('%s kind=write 直执行不审批', async (name) => {
    const agent = makeAgent({ decideCommand: () => 'default' });
    const out = await runToolCall(
      { ...writeDefBase, name },
      agent,
      'net-' + name,
      {},
      undefined,
    );
    expect(out).toBe('ok');
    expect(agent.approvals).toHaveLength(0);
  });
});
