// GA-T9/Ruling 14：automation/save 显式写入 enabled（控制端启停走 save
// 全量、无 toggle 端点——Ruling 12；server 静默丢弃该字段是契约缺口）。
// 服务级 + 调度器联动直证（e2e 契约面见 graph-api.spec 同批用例）：
// 1. save enabled=false → 任务行 enabled=false + 到期不再被调度
//    （tick 轰多轮：零 run 行、nextRunAt 不推进）
// 2. enabled 缺省不碰开关：已停任务全量保存开关保持 false（repo
//    buildTaskData「编辑不重置用户开关」忠实语义的默认路径不变）
// 3. save enabled=true 重启用 → 恢复调度（到期触发 run success +
//    nextRunAt 推进；toggleTask 恢复语义 status 回 active）
import { scriptedChatModel } from '../helpers/scripted-chat-model';

jest.mock('src/core/provider/model-factory', () => ({
  createChatModel: jest.fn(),
}));

import { createChatModel } from 'src/core/provider/model-factory';
import { GraphRepository } from 'src/modules/graph/graph.repository';
import { AutomationRepository } from 'src/modules/automation/automation.repository';
import { AutomationService } from 'src/modules/automation/automation.service';
import { AutomationScheduler } from 'src/modules/automation/automation-scheduler';
import { EventBusService } from 'src/commons/event-bus/event-bus.service';
import type { ServerEvent } from '@tianshu/protocol';
import {
  installGraphExecutorRuntime,
  resetGraphExecutorRuntime,
} from 'src/core/graph/executor-runtime';
import { createTestDb, type TestDb } from '../support/test-db';

const createChatModelMock = createChatModel as jest.Mock;

/** 异步断言轮询（automation-scheduler.spec waitForDb 同款） */
async function waitForDb(
  check: () => void | Promise<void>,
  timeoutMs = 5000,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      await check();
      return;
    } catch (e) {
      if (Date.now() - startedAt > timeoutMs) throw e;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

/** 间隔 5 分钟调度（推进后 nextRunAt 必在 5 分钟外，测试窗口内不二跳） */
const INTERVAL_5MIN = { mode: 'interval', value: 5, unit: 'minute' } as const;

/** save 全量载荷工厂（update 用例复用；enabled 按用例附加） */
function saveParams(wsId: number, modelId: number) {
  return {
    name: '启停任务',
    prompt: '只回复 pong',
    workspaceId: wsId,
    modelId,
    schedule: INTERVAL_5MIN,
    scheduleText: '每 5 分钟',
    missedPolicy: 'skip' as const,
  };
}

describe('automation/save enabled 显式写入（GA-T9/Ruling 14）', () => {
  let db: TestDb;
  let service: AutomationService;
  let scheduler: AutomationScheduler;
  let bus: EventBusService;
  let changedEvents: Array<{ taskId: number; nextRunAt?: string | null }>;
  let wsId: number;
  let modelId: number;

  beforeAll(async () => {
    db = await createTestDb();
    installGraphExecutorRuntime({
      db: db.prisma,
      runs: new GraphRepository(db.prisma),
    });
    const provider = await db.prisma.provider.create({
      data: {
        name: 'p1',
        type: 'openai-compatible',
        baseUrl: 'http://localhost:9',
        apiKey: 'k',
        userId: 1,
      },
    });
    modelId = (
      await db.prisma.model.create({
        data: { providerId: provider.id, modelId: 'test-model' },
      })
    ).id;
    wsId = (
      await db.prisma.workspace.create({
        data: { name: 'enabled-ws', userId: 1 },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    resetGraphExecutorRuntime();
    await db.cleanup();
  });

  beforeEach(() => {
    createChatModelMock.mockReset();
    bus = new EventBusService();
    changedEvents = [];
    bus.subscribe((event: ServerEvent) => {
      if (event.type === 'automation.changed') {
        changedEvents.push(event.payload);
      }
    });
    service = new AutomationService(
      db.prisma,
      new AutomationRepository(db.prisma),
      bus,
    );
    scheduler = new AutomationScheduler(db.prisma, {
      config: () => ({
        tickMs: 50,
        allowDangerousTools: false,
        deleteProtection: true,
        dataRoot: db.dataRoot,
      }),
    });
  });

  afterEach(() => {
    scheduler.stop();
  });

  it('save enabled=false：任务行 enabled=false + 到期不再被调度（零 run 行、nextRunAt 不推进）', async () => {
    createChatModelMock.mockImplementation(
      () =>
        scriptedChatModel([{ steps: [{ kind: 'text', delta: 'pong' }] }]).model,
    );
    const created = await service.save(saveParams(wsId, modelId));
    expect(created.enabled).toBe(true);
    expect(changedEvents.map((e) => e.taskId)).toEqual([created.id]);

    // 全量保存显式携 enabled=false（Ruling 12 控制端启停载荷形态）
    const disabled = await service.save({
      id: created.id,
      ...saveParams(wsId, modelId),
      enabled: false,
    });
    expect(disabled.enabled).toBe(false);
    const row = await db.prisma.automationTask.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.enabled).toBe(false);
    expect(row.status).toBe('active');

    // 到期不再被调度：nextRunAt 拨到过去（模拟已到期），tick 轰多轮——
    // tick 只选 enabled+active 任务，停用任务不决策不推进（事件零增量）
    const dueAt = new Date(Date.now() - 1000);
    await db.prisma.automationTask.update({
      where: { id: created.id },
      data: { nextRunAt: dueAt },
    });
    const changedBefore = changedEvents.length;
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const runs = await db.prisma.automationRun.findMany({
      where: { taskId: created.id },
    });
    expect(runs).toHaveLength(0);
    const after = await db.prisma.automationTask.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(after.enabled).toBe(false);
    expect(after.nextRunAt?.getTime()).toBe(dueAt.getTime());
    expect(changedEvents.length).toBe(changedBefore);
  });

  it('enabled 缺省不碰开关：已停任务全量保存（不携 enabled）开关保持 false', async () => {
    const created = await service.save(saveParams(wsId, modelId));
    await service.save({
      id: created.id,
      ...saveParams(wsId, modelId),
      enabled: false,
    });

    const untouched = await service.save({
      id: created.id,
      ...saveParams(wsId, modelId),
    });
    expect(untouched.enabled).toBe(false);
    const row = await db.prisma.automationTask.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.enabled).toBe(false);
  });

  it('save enabled=true 重启用：恢复调度——到期触发 run success + nextRunAt 推进', async () => {
    createChatModelMock.mockImplementation(
      () =>
        scriptedChatModel([{ steps: [{ kind: 'text', delta: 'pong' }] }]).model,
    );
    const created = await service.save(saveParams(wsId, modelId));
    await service.save({
      id: created.id,
      ...saveParams(wsId, modelId),
      enabled: false,
    });

    const enabled = await service.save({
      id: created.id,
      ...saveParams(wsId, modelId),
      enabled: true,
    });
    expect(enabled.enabled).toBe(true);
    expect(enabled.status).toBe('active');

    // 重启用后再到期（save 全量会重算 nextRunAt=+5min，此处拨到当下模拟
    // 到期——不早于 scheduler 构造时刻 processStartTime，否则走 missed
    // skip 分支），下一 tick 即触发
    await db.prisma.automationTask.update({
      where: { id: created.id },
      data: { nextRunAt: new Date() },
    });
    scheduler.start();
    await waitForDb(async () => {
      const runs = await db.prisma.automationRun.findMany({
        where: { taskId: created.id },
      });
      if (!runs.some((r) => r.status === 'success')) {
        throw new Error('未触发');
      }
    });
    const [run] = await db.prisma.automationRun.findMany({
      where: { taskId: created.id },
    });
    expect(run.triggerType).toBe('schedule');
    const row = await db.prisma.automationTask.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
  });
});
