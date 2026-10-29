// TB-T2/R3 缺口 2 直证（spec §4.2 本意）：桥 write 工具（browser_click/
// browser_type——发 tool.request 的）豁免 server 本机 write 门禁——default
// accessMode（autoDenyApprovals=true、无完全访问、无工具记忆）下不经
// APPROVAL_AUTO_DENIED_OUTPUT 本机拒绝，直接发出 tool.request 挂起等控制端
// respond；对照非桥非免审 write（rm——权限放宽 spec §4.4 后
// write 已免审直执行，兜底审批面剩余项）照旧本机自动拒绝（豁免面
// 精确到桥工具+免审集，非全部 write）。
import type { ToolRequestPayload } from '@tianshu/protocol';
import {
  installBridgeRuntime,
  resetBridgeRuntime,
  respondBridgeTool,
} from 'src/core/tools/bridge/bridge-registry';
import { BROWSER_BRIDGE_TOOLS } from 'src/core/tools/bridge/browser-bridge-tools';
import { FILE_TOOLS } from 'src/core/tools/file-tools';
import {
  APPROVAL_AUTO_DENIED_OUTPUT,
  runToolCall,
  type AgentStreamOptions,
} from 'src/core/tools/tool-gate';
import type { ChatStreamChunk } from '@tianshu/protocol';
import { waitFor } from '../support/wait-for';

const published: ToolRequestPayload[] = [];

/** 桥运行时替身：广播捕获 + 恒一订阅者（在线）+ 30s 超时 */
beforeEach(() => {
  published.length = 0;
  installBridgeRuntime({
    publishToolRequest: (payload) => published.push(payload),
    subscriberCount: () => 1,
    timeoutMs: () => 30_000,
    onSubscribersChanged: () => () => {},
  });
});

afterEach(() => {
  resetBridgeRuntime();
});

/** default accessMode 语义的 agent：write 必审批 + 无应答方自动拒绝 */
function defaultModeAgent(): AgentStreamOptions {
  return {
    sessionId: 7,
    fullAccess: () => false,
    isToolAllowed: () => Promise.resolve(false),
    requestApproval: () => Promise.resolve(false),
    autoDenyApprovals: true,
  };
}

function findTool(name: string) {
  const tool = BROWSER_BRIDGE_TOOLS.find((def) => def.name === name);
  if (!tool) throw new Error(`桥工具未注册: ${name}`);
  return tool;
}

describe('桥 write 工具豁免本机 write 门禁（TB-T2/R3）', () => {
  it('browser_click：default 模式下发出 tool.request（非本机拒绝 chunk），respond 成功回喂', async () => {
    const chunks: ChatStreamChunk[] = [];
    const pending = runToolCall(
      findTool('browser_click'),
      defaultModeAgent(),
      'tc1',
      { idx: 3 },
      undefined,
      (chunk) => chunks.push(chunk),
    );
    await waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]).toMatchObject({
      sessionId: 7,
      tool: 'browser_click',
      args: { idx: 3 },
    });
    expect(typeof published[0].requestId).toBe('string');

    respondBridgeTool(published[0].requestId, { ok: true, output: 'OK' });
    await expect(pending).resolves.toBe('OK');
    // 无 denied/awaiting-approval chunk：审批语义在控制端（spec §4.2）
    expect(
      chunks.filter(
        (chunk) =>
          chunk.type === 'tool-update' &&
          (chunk as { state: string }).state === 'denied',
      ),
    ).toHaveLength(0);
    expect(
      chunks.filter((chunk) => chunk.type === 'approval-request'),
    ).toHaveLength(0);
  });

  it('browser_click：控制端拒绝 → 工具错误文案回喂（循环继续，非本机拒绝）', async () => {
    const pending = runToolCall(
      findTool('browser_click'),
      defaultModeAgent(),
      'tc2',
      { idx: 1 },
      undefined,
    );
    await waitFor(() => expect(published).toHaveLength(1));
    respondBridgeTool(published[0].requestId, {
      ok: false,
      error: 'denied by user',
    });
    await expect(pending).resolves.toBe('错误: denied by user');
  });

  it('豁免面精确：rm（非桥非免审）default 模式照旧本机自动拒绝，不发 tool.request', async () => {
    const deleteFile = FILE_TOOLS.find((def) => def.name === 'rm');
    if (!deleteFile) throw new Error('rm 未注册');
    const chunks: ChatStreamChunk[] = [];
    const output = await runToolCall(
      deleteFile,
      { ...defaultModeAgent(), workspacePath: '/tmp/ws' },
      'tc3',
      { path: 'a.txt' },
      undefined,
      (chunk) => chunks.push(chunk),
    );
    expect(output).toBe(APPROVAL_AUTO_DENIED_OUTPUT);
    expect(published).toHaveLength(0);
    expect(
      chunks.filter(
        (chunk) =>
          chunk.type === 'tool-update' &&
          (chunk as { state: string }).state === 'denied',
      ),
    ).toHaveLength(1);
  });
});
