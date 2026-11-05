// P0-2（spec monitoring.md §6）：server 端事件保留期裁剪——对齐桌面
// ensureEventStatMaintenance 的 cutoff 口径（createdAt < now - 90 天，无
// userId 过滤）；长驻进程每日 setInterval 周期跑 + 启动即跑一次。
// 裁剪语义用真临时库直测 service；周期接线用 fake timers + spy（不触库）。
import { MonitorService } from 'src/modules/monitor/monitor.service';
import {
  MONITOR_PRUNE_INTERVAL_MS,
  MONITOR_RETENTION_DAYS,
} from 'src/modules/monitor/monitor.service';
import { createTestDb, type TestDb } from '../support/test-db';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('MonitorService 事件保留期裁剪（P0-2）', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  }, 120_000);

  afterAll(async () => {
    await db.cleanup();
  });

  beforeEach(async () => {
    await db.prisma.llmCallEvent.deleteMany({});
    await db.prisma.toolCallEvent.deleteMany({});
  });

  it('常量契约：保留 90 天、每日跑一次（桌面 cutoff 口径对齐）', () => {
    expect(MONITOR_RETENTION_DAYS).toBe(90);
    expect(MONITOR_PRUNE_INTERVAL_MS).toBe(DAY_MS);
  });

  it('91 天前事件裁掉、89 天前保留（llm/tool 两表同口径）', async () => {
    const now = Date.now();
    const oldLlm = await db.prisma.llmCallEvent.create({
      data: {
        scene: 'chat',
        userId: 1,
        inputTokens: 10,
        outputTokens: 5,
        createdAt: new Date(now - (MONITOR_RETENTION_DAYS + 1) * DAY_MS),
      },
    });
    const freshLlm = await db.prisma.llmCallEvent.create({
      data: {
        scene: 'chat',
        userId: 1,
        inputTokens: 20,
        outputTokens: 8,
        createdAt: new Date(now - (MONITOR_RETENTION_DAYS - 1) * DAY_MS),
      },
    });
    const oldTool = await db.prisma.toolCallEvent.create({
      data: {
        scene: 'chat',
        userId: 1,
        toolName: 'write',
        state: 'done',
        createdAt: new Date(now - (MONITOR_RETENTION_DAYS + 1) * DAY_MS),
      },
    });
    const freshTool = await db.prisma.toolCallEvent.create({
      data: {
        scene: 'chat',
        userId: 1,
        toolName: 'write',
        state: 'error',
        createdAt: new Date(now - (MONITOR_RETENTION_DAYS - 1) * DAY_MS),
      },
    });

    const service = new MonitorService(db.prisma);
    const deleted = await service.pruneMonitorEvents();

    expect(deleted).toBe(2);
    await expect(
      db.prisma.llmCallEvent.findUnique({ where: { id: oldLlm.id } }),
    ).resolves.toBeNull();
    await expect(
      db.prisma.llmCallEvent.findUnique({ where: { id: freshLlm.id } }),
    ).resolves.toBeTruthy();
    await expect(
      db.prisma.toolCallEvent.findUnique({ where: { id: oldTool.id } }),
    ).resolves.toBeNull();
    await expect(
      db.prisma.toolCallEvent.findUnique({ where: { id: freshTool.id } }),
    ).resolves.toBeTruthy();
  });

  it('幂等：二次裁剪零删除', async () => {
    await db.prisma.llmCallEvent.create({
      data: {
        scene: 'graph',
        userId: 1,
        graphId: 3,
        inputTokens: 1,
        outputTokens: 1,
        createdAt: new Date(Date.now() - 400 * DAY_MS),
      },
    });
    const service = new MonitorService(db.prisma);
    await service.pruneMonitorEvents();
    await expect(service.pruneMonitorEvents()).resolves.toBe(0);
  });
});

describe('MonitorService 裁剪周期接线（lifecycle）', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('启动即跑一次 + 每 24h 周期跑；onModuleDestroy 停表', async () => {
    jest.useFakeTimers();
    const service = new MonitorService({} as never);
    const prune = jest
      .spyOn(service, 'pruneMonitorEvents')
      .mockResolvedValue(0);

    service.onModuleInit();
    expect(prune).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(MONITOR_PRUNE_INTERVAL_MS);
    // await 微任务清空（fire-and-forget void 调用链）
    await Promise.resolve();
    expect(prune).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(MONITOR_PRUNE_INTERVAL_MS - 1);
    await Promise.resolve();
    expect(prune).toHaveBeenCalledTimes(2);

    service.onModuleDestroy();
    jest.advanceTimersByTime(MONITOR_PRUNE_INTERVAL_MS * 2);
    await Promise.resolve();
    expect(prune).toHaveBeenCalledTimes(2);
  });

  it('裁剪失败不抛（吞错记日志——对齐埋点静默哲学，不阻塞启动）', () => {
    jest.useFakeTimers();
    const service = new MonitorService({} as never);
    jest
      .spyOn(service, 'pruneMonitorEvents')
      .mockRejectedValue(new Error('db down'));
    expect(() => service.onModuleInit()).not.toThrow();
    service.onModuleDestroy();
  });
});
