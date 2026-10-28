// EB 批（2026-10-27）：事件总线单测——matchEventTasks 匹配矩阵 +
// MAX_CHAIN_DEPTH 防环上限 + publishAutomationEvent 行为（链深超限/在途
// 互斥/inputs 透传/safety 透传/收官广播/异常吞掉链续）。用例集对齐 mirror
// tests/ai/automation-event-bus.test.ts（副本逐段移植的对照面）；
// jest.mock automation-runner 时 taskFinishedEvent 经 requireActual 保真
//（server 版该函数在 runner——mirror 版在 event-bus 自身，mock 边界差异），
// executeTask 置 jest.fn 断言行为不跑真执行链。
jest.mock('src/core/provider/model-factory', () => ({
  createChatModel: jest.fn(),
}));
jest.mock('src/modules/automation/automation-runner', () => {
  const actual = jest.requireActual('src/modules/automation/automation-runner');
  return { ...actual, executeTask: jest.fn() };
});

import {
  createAutomationEventBus,
  matchEventTasks,
  MAX_CHAIN_DEPTH,
  type AutomationEventBus,
} from 'src/modules/automation/automation-event-bus';
import { executeTask } from 'src/modules/automation/automation-runner';
import { inflight } from 'src/modules/automation/automation-inflight';
import type { AutomationChangedPayload } from '@tianshu/protocol';

const executeTaskMock = executeTask as jest.Mock;

/** 匹配视图最小行（行为行另带 taskFinishedEvent 需要的 targetKind/graphId） */
const task = (id: number, eventJson: string | null) => ({
  id,
  eventJson,
  enabled: true,
  status: 'active',
});

/** 行为测试行 */
const row = (id: number, eventJson: string | null) => ({
  ...task(id, eventJson),
  targetKind: 'prompt',
  graphId: null,
});
const APP_STARTED = JSON.stringify({ source: 'appStarted' });
const onTask = (targetId: number, on: 'success' | 'failed' | 'any') =>
  JSON.stringify({ source: 'taskFinished', targetType: 'task', targetId, on });

describe('automation-event-bus matchEventTasks', () => {
  it('appStarted 命中', () => {
    const hits = matchEventTasks(
      [task(1, JSON.stringify({ source: 'appStarted' }))],
      { source: 'appStarted' },
    );
    expect(hits).toHaveLength(1);
  });

  it('taskFinished 按 targetType/targetId/on 过滤，并注入 outcome', () => {
    const rows = [
      task(
        1,
        JSON.stringify({
          source: 'taskFinished',
          targetType: 'task',
          targetId: 3,
          on: 'success',
        }),
      ),
      task(
        2,
        JSON.stringify({
          source: 'taskFinished',
          targetType: 'graph',
          targetId: 7,
          on: 'any',
        }),
      ),
      task(
        3,
        JSON.stringify({
          source: 'taskFinished',
          targetType: 'task',
          targetId: 3,
          on: 'failed',
        }),
      ),
    ];
    const hits = matchEventTasks(rows, {
      source: 'taskFinished',
      targetType: 'task',
      targetId: 3,
      outcome: 'success',
    });
    expect(hits.map((h) => h.task.id)).toEqual([1]);
    expect(hits[0].inputs).toEqual({ outcome: 'success' });
  });

  it('坏 eventJson 行静默跳过；disabled/error 不入选（findMany where 已滤，函数再容错）', () => {
    expect(
      matchEventTasks([task(1, '{bad')], { source: 'appStarted' }),
    ).toHaveLength(0);
    const disabled = { ...task(2, APP_STARTED), enabled: false };
    const errored = { ...task(3, APP_STARTED), status: 'error' };
    expect(
      matchEventTasks([disabled, errored], { source: 'appStarted' }),
    ).toHaveLength(0);
  });

  it('链深上限常量为 5', () => expect(MAX_CHAIN_DEPTH).toBe(5));
});

describe('automation-event-bus publishAutomationEvent 行为', () => {
  let findMany: jest.Mock;
  let runCreate: jest.Mock;
  let changed: jest.Mock;
  let publish: AutomationEventBus;
  let safetyCalls: unknown[];

  beforeEach(() => {
    findMany = jest.fn(async () => [] as unknown[]);
    runCreate = jest.fn(async () => ({ id: 1 }));
    changed = jest.fn();
    safetyCalls = [];
    publish = createAutomationEventBus({
      prisma: {
        automationTask: { findMany },
        automationRun: { create: runCreate },
      } as never,
      publishAutomationChanged: changed,
      safety: () => {
        safetyCalls.push('read');
        return {
          allowDangerousTools: false,
          deleteProtection: true,
          trashRoot: '/tmp/trash',
        };
      },
    });
    executeTaskMock.mockReset();
    executeTaskMock.mockResolvedValue('success');
    inflight.clear();
  });

  it('链深超限落 skipped(chain_depth_exceeded) 且不调 executeTask', async () => {
    findMany.mockResolvedValue([row(1, APP_STARTED)]);
    await publish({ source: 'appStarted' }, MAX_CHAIN_DEPTH + 1);
    expect(runCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taskId: 1,
          triggerType: 'event',
          status: 'skipped',
          error: 'chain_depth_exceeded',
        }),
      }),
    );
    expect(executeTaskMock).not.toHaveBeenCalled();
  });

  it('在途互斥：inflight 占用落 skipped(event_skipped_running)', async () => {
    findMany.mockResolvedValue([row(2, APP_STARTED)]);
    inflight.set(2, new AbortController());
    await publish({ source: 'appStarted' });
    expect(runCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taskId: 2,
          triggerType: 'event',
          status: 'skipped',
          error: 'event_skipped_running',
        }),
      }),
    );
    expect(executeTaskMock).not.toHaveBeenCalled();
  });

  it('appStarted 匹配任务注入空 inputs 执行，safety 经 deps 透传', async () => {
    findMany.mockResolvedValueOnce([row(3, APP_STARTED)]);
    await publish({ source: 'appStarted' });
    expect(executeTaskMock).toHaveBeenCalledTimes(1);
    expect(executeTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 3 }),
      expect.objectContaining({
        triggerType: 'event',
        attempt: 1,
        inputs: {},
        safety: {
          allowDangerousTools: false,
          deleteProtection: true,
          trashRoot: '/tmp/trash',
        },
      }),
    );
  });

  it('事件触发 run 收尾广播 automation.changed（taskId 级刷新信号）', async () => {
    findMany.mockResolvedValueOnce([row(3, APP_STARTED)]);
    await publish({ source: 'appStarted' });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith({
      taskId: 3,
    } as AutomationChangedPayload);
  });

  it('taskFinished 匹配执行透传 inputs={outcome}，链式向下游发布', async () => {
    const target = row(5, APP_STARTED);
    const listener = row(9, onTask(5, 'success'));
    findMany
      .mockResolvedValueOnce([target]) // appStarted 匹配 target
      .mockResolvedValueOnce([listener]); // taskFinished(5) 匹配 listener
    await publish({ source: 'appStarted' });
    expect(executeTaskMock).toHaveBeenCalledTimes(2);
    expect(executeTaskMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 5 }),
      expect.objectContaining({ inputs: {} }),
    );
    expect(executeTaskMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 9 }),
      expect.objectContaining({
        triggerType: 'event',
        inputs: { outcome: 'success' },
      }),
    );
  });

  it('executeTask 抛错被吞且链续（outcome=failed 向下游发布）', async () => {
    const target = row(6, APP_STARTED);
    const listener = row(10, onTask(6, 'failed'));
    findMany
      .mockResolvedValueOnce([target])
      .mockResolvedValueOnce([listener])
      .mockResolvedValue([]);
    executeTaskMock.mockResolvedValueOnce(
      new Promise(() => {
        throw new Error('boom');
      }),
    );
    await publish({ source: 'appStarted' });
    // 上游异常吞掉（.catch → failed），下游 on=failed 仍被链式拉起
    expect(executeTaskMock).toHaveBeenCalledTimes(2);
    expect(executeTaskMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 10 }),
      expect.objectContaining({ inputs: { outcome: 'failed' } }),
    );
  });
});
