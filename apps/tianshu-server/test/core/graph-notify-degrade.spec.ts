// 批1C 改进项 9：notify 节点无头端降级 trace 标注。无头端未注入 notify
// 钩子时桌面通知缺省 no-op——图作者不知通知未送达；executor 改为 trace
// 条目落 notifySkipped 原因码（no_channel 无通道 / send_failed 发送失败），
// 通道就绪且送达成功时不落标注。节点仍 success（通知尽力而为语义不变）。
import { GraphRepository } from 'src/modules/graph/graph.repository';
import {
  executeGraphRun,
  type GraphRow,
  type TraceEntry,
} from 'src/core/graph/graph-executor';
import {
  installGraphExecutorRuntime,
  resetGraphExecutorRuntime,
} from 'src/core/graph/executor-runtime';
import { createTestDb, type TestDb } from '../support/test-db';

/** 单 notify 节点图（无 IM webhook——只测桌面通知通道降级面） */
function notifyGraphJson(): string {
  return JSON.stringify({
    version: 1,
    inputSchema: { q: 'string' },
    nodes: [
      {
        id: 'n1',
        name: '通知',
        kind: 'notify',
        title: '任务完成 {{input.q}}',
      },
    ],
    edges: [{ from: 'n1', to: 'END' }],
  });
}

describe('notify 节点无头端降级标注（批1C 改进项 9）', () => {
  let db: TestDb;
  let repo: GraphRepository;
  let graphRow: GraphRow;
  let wsId: number;

  beforeAll(async () => {
    db = await createTestDb();
    repo = new GraphRepository(db.prisma);
    const ws = await db.prisma.workspace.create({
      data: { name: 'notify-ws', userId: 1 },
    });
    wsId = ws.id;
    graphRow = await db.prisma.graphDefinition.create({
      data: { name: 'notify 图', graphJson: notifyGraphJson(), userId: 1 },
    });
  }, 120_000);

  afterAll(async () => {
    resetGraphExecutorRuntime();
    await db.cleanup();
  });

  /** 单次执行：notify 钩子可选注入，返回终态/trace/runId */
  const runOnce = async (
    notify?: (title: string, body?: string) => void,
  ): Promise<{
    outcome: 'success' | 'failed';
    trace: TraceEntry[];
    runId: number;
  }> => {
    installGraphExecutorRuntime({
      db: db.prisma,
      runs: repo,
      publishRunUpdated: () => undefined,
      notify,
    });
    const outcome = await executeGraphRun({
      graph: graphRow,
      task: null,
      inputs: { q: '报告' },
      triggerType: 'manual',
      attempt: 1,
      abort: new AbortController().signal,
      workspace: { id: wsId, directoryPath: null },
    });
    const run = await db.prisma.automationRun.findFirstOrThrow({
      where: { graphId: graphRow.id },
      orderBy: { id: 'desc' },
    });
    return {
      outcome,
      runId: run.id,
      trace: JSON.parse(run.graphTrace ?? '[]') as TraceEntry[],
    };
  };

  it('未注入 notify 钩子（无头端缺省）：节点 success 但 trace 标注 notifySkipped=no_channel', async () => {
    const { outcome, trace, runId } = await runOnce();
    expect(outcome).toBe('success');
    expect(trace).toHaveLength(1);
    expect(trace[0].status).toBe('success');
    expect(trace[0].notifySkipped).toBe('no_channel');
    // 节点详情行照常 success（通知尽力而为，降级不炸节点）
    const nodeRow = await db.prisma.graphRunNode.findFirstOrThrow({
      where: { runId, nodeId: 'n1' },
    });
    expect(nodeRow.status).toBe('success');
  });

  it('注入 notify 钩子：钩子被调用且 trace 无降级标注', async () => {
    const calls: Array<{ title: string; body?: string }> = [];
    const { outcome, trace } = await runOnce((title, body) =>
      calls.push({ title, body }),
    );
    expect(outcome).toBe('success');
    expect(calls).toEqual([{ title: '任务完成 报告' }]);
    expect(trace[0].notifySkipped).toBeUndefined();
  });

  it('钩子抛错：节点继续 success，trace 标注 notifySkipped=send_failed', async () => {
    const { outcome, trace } = await runOnce(() => {
      throw new Error('channel down');
    });
    expect(outcome).toBe('success');
    expect(trace[0].status).toBe('success');
    expect(trace[0].notifySkipped).toBe('send_failed');
  });
});
