// GA-T5：automation-runner/scheduler 副本核心链路（tickMs=50 快进 + 真实
// 临时库 + 假模型经 createChatModel 模块 mock 注入——mirror runner 测试的
// vi.mock(chat.service) 手法在 jest 的同构，模型工厂是 runner 唯一 IO 缝）。
// 覆盖（任务面）：
// 1. 到期触发：nextRunAt 过期（≥ 进程启动）→ execute → run success +
//    nextRunAt 推进 + 建会话 + 消息对落库（变量替换断言）
// 2. catchUp 语义（决策树忠实）：nextRunAt < 进程启动——catchUpOnce 补跑
//    一次（过期多周期只补一次）；skip 策略落 skipped run 行 + nextRunAt 推进
// 3. inflight 互斥：手动触发在途 → 二次 runNow 拒 TASK_ALREADY_RUNNING；
//    tick 对在途任务不并发双跑；stop abort 全部在途
// 4. runNow 手动触发不消耗调度字段（nextRunAt/lastRunAt/status/enabled 不动）
// 5. 无人值守高危拒绝路径：allowDangerousTools=false（config 联动）时
//    run_command 被 tool-gate 门拒绝——denied tool_call 块落 assistant
//    消息（accessMode=full 亦受 config 门，spec §6）
// 6. 启动恢复失败 catch 收敛：recoverInterruptedRuns 拒绝 → 记 error 不
//    unhandledRejection（终审 F2）
// 决策树纯函数（decideTick）六分支已由 mirror automation-scheduler.test
// 覆盖，此处不重复；本文件走真实调度链路（tick → launch → executeTask）。
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  scriptedChatModel,
  HangingChatModel,
} from '../helpers/scripted-chat-model';

jest.mock('src/core/provider/model-factory', () => ({
  createChatModel: jest.fn(),
}));

import { createChatModel } from 'src/core/provider/model-factory';
import { GraphRepository } from 'src/modules/graph/graph.repository';
import { AutomationRepository } from 'src/modules/automation/automation.repository';
import { AutomationScheduler } from 'src/modules/automation/automation-scheduler';
import { inflight } from 'src/modules/automation/automation-inflight';
import { executeTask } from 'src/modules/automation/automation-runner';
import {
  installGraphExecutorRuntime,
  resetGraphExecutorRuntime,
} from 'src/core/graph/executor-runtime';
import { createTestDb, type TestDb } from '../support/test-db';

/** 异步断言轮询（support/wait-for 仅收同步断言——异步回调的拒绝会被其
 * try/catch 漏接造成假通过，本组 DB 轮询用例需异步版；同步检查亦可收） */
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
      if (Date.now() - startedAt > timeoutMs) {
        throw e;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

const createChatModelMock = createChatModel as jest.Mock;

/** 间隔 5 分钟调度（advanceTask/skip 推进后 nextRunAt 必在 5 分钟外，
 * 测试窗口内不二跳——computeNextRun interval 语义） */
const INTERVAL_5MIN = JSON.stringify({
  mode: 'interval',
  value: 5,
  unit: 'minute',
});

/** 任务行工厂（automationTask 表形状；nextRunAt/missedPolicy/accessMode
 * 按用例覆写） */
async function createTask(
  db: TestDb,
  wsId: number,
  modelId: number,
  overrides: Record<string, unknown> = {},
) {
  return db.prisma.automationTask.create({
    data: {
      name: 't',
      prompt: 'p',
      workspaceId: wsId,
      modelId,
      scheduleJson: INTERVAL_5MIN,
      scheduleText: '每 5 分钟',
      missedPolicy: 'skip',
      accessMode: 'default',
      enabled: true,
      status: 'active',
      targetKind: 'prompt',
      userId: 1,
      ...overrides,
    },
  });
}

/** 假模型注入（runner 的 createChatModel 消费面） */
function useModel(model: BaseChatModel | HangingChatModel): void {
  createChatModelMock.mockImplementation(() => model);
}

describe('automation runner/scheduler 副本（GA-T5）', () => {
  let db: TestDb;
  let graphRepo: GraphRepository;
  let automations: AutomationRepository;
  let changedCount: () => number;
  let scheduler: AutomationScheduler;
  let wsId: number;
  let modelId: number;

  beforeAll(async () => {
    db = await createTestDb();
    graphRepo = new GraphRepository(db.prisma);
    // runner 副本经 graphExecutorRuntime().db 取库（改造点 1）；runs 原语
    // 经 GA-T3 仓储（graph 分支本组用例不触达，装配完整即可）
    installGraphExecutorRuntime({ db: db.prisma, runs: graphRepo });
    const provider = await db.prisma.provider.create({
      data: {
        name: 'p1',
        type: 'openai-compatible',
        baseUrl: 'http://localhost:9',
        apiKey: 'k',
        userId: 1,
      },
    });
    const modelRow = await db.prisma.model.create({
      data: { providerId: provider.id, modelId: 'test-model' },
    });
    modelId = modelRow.id;
    const ws = await db.prisma.workspace.create({
      data: { name: 'automation-ws', userId: 1 },
    });
    wsId = ws.id;
  }, 120_000);

  afterAll(async () => {
    resetGraphExecutorRuntime();
    await db.cleanup();
  });

  beforeEach(() => {
    createChatModelMock.mockReset();
    let changed = 0;
    changedCount = () => changed;
    // 每用例新建 scheduler：processStartTime 随之刷新（catchUp 用例依赖
    // nextRunAt < processStartTime 的「错过」语义）
    const makeScheduler = () =>
      new AutomationScheduler(db.prisma, {
        config: () => ({
          tickMs: 50,
          allowDangerousTools: false,
          deleteProtection: true,
          dataRoot: db.dataRoot,
        }),
        publishAutomationChanged: () => {
          changed += 1;
        },
      });
    scheduler = makeScheduler();
    automations = new AutomationRepository(db.prisma, {
      safety: () => ({
        allowDangerousTools: false,
        deleteProtection: true,
        trashRoot: `${db.dataRoot}/trash`,
      }),
      publishAutomationChanged: () => {
        changed += 1;
      },
    });
  });

  afterEach(() => {
    scheduler.stop();
  });

  it('到期触发：nextRunAt 过期 → 执行（schedule）→ run success + nextRunAt 推进 + 会话与消息对落库', async () => {
    useModel(
      scriptedChatModel([
        {
          steps: [{ kind: 'text', delta: '报告完成' }],
          usage: { input: 7, output: 11 },
        },
      ]).model,
    );
    // nextRunAt=now ≥ scheduler 构造时刻（processStartTime）→ 决策树 execute
    const task = await createTask(db, wsId, modelId, {
      name: '定时简报',
      prompt: '现在 {{time}} 的简报',
      nextRunAt: new Date(),
    });
    scheduler.start();

    await waitForDb(async () => {
      const row = await db.prisma.automationTask.findUniqueOrThrow({
        where: { id: task.id },
      });
      if (row.lastRunAt === null) throw new Error('未推进');
    });

    const [run] = await db.prisma.automationRun.findMany({
      where: { taskId: task.id },
    });
    expect(run).toMatchObject({
      triggerType: 'schedule',
      status: 'success',
      attempt: 1,
      promptTokens: 7,
      completionTokens: 11,
    });
    expect(run.sessionId).not.toBeNull();
    expect(run.finishedAt).not.toBeNull();

    // 调度字段推进：nextRunAt = lastRunAt + 5min（interval 相位）
    const row = await db.prisma.automationTask.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(row.lastRunAt).not.toBeNull();
    expect(
      (row.nextRunAt?.getTime() ?? 0) - row.lastRunAt!.getTime(),
    ).toBeGreaterThanOrEqual(5 * 60_000 - 1000);

    // prompt 分支产物：建会话（agent 模式，标题=任务名）+ 消息对
    // （用户消息为引用解析+变量替换后的注入文本）
    const session = await db.prisma.sessionRecord.findUniqueOrThrow({
      where: { id: run.sessionId ?? 0 },
    });
    expect(session.title).toBe('定时简报');
    expect(session.mode).toBe('agent');
    const messages = await db.prisma.messageRecord.findMany({
      where: { sessionId: session.id },
      orderBy: { id: 'asc' },
    });
    expect(messages).toHaveLength(2);
    // 变量替换（{{time}} → HH:mm；跨分钟边界稳定断言形态）
    const userBlocks = JSON.parse(messages[0].blocks) as Array<{
      type: string;
      text: string;
    }>;
    expect(userBlocks).toEqual([
      {
        type: 'text',
        // jest 非对称匹配器返回 any（typed-lint 误报，与既有 spec 同况）
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        text: expect.stringMatching(/^现在 \d{2}:\d{2} 的简报$/),
      },
    ]);
    expect(JSON.parse(messages[1].blocks)).toEqual([
      { type: 'text', text: '报告完成' },
      { type: 'usage', input: 7, output: 11 },
    ]);
    expect(messages[1].modelId).toBe(modelId);

    // 任务级事件出口（mirror AUTOMATION_CHANGED 广播 → 钩子）
    expect(changedCount()).toBeGreaterThan(0);
  });

  it('错过触发点（nextRunAt < 进程启动）：catchUpOnce 补跑一次（过期多周期只补一次）；skip 落 skipped run 行并推进', async () => {
    useModel(
      scriptedChatModel([{ steps: [{ kind: 'text', delta: '补跑完成' }] }])
        .model,
    );
    // 任务先行创建（nextRunAt 十分钟前），scheduler 后构造 → 进程启动晚于
    // 触发点 → catchUp/skip 分支；5 分钟间隔错过 10 分钟 = 两个周期
    const missedAt = new Date(Date.now() - 10 * 60_000);
    const catchUpTask = await createTask(db, wsId, modelId, {
      missedPolicy: 'catchUpOnce',
      nextRunAt: missedAt,
    });
    const skipTask = await createTask(db, wsId, modelId, {
      missedPolicy: 'skip',
      nextRunAt: missedAt,
    });
    scheduler.start();

    await waitForDb(async () => {
      const runs = await db.prisma.automationRun.findMany({
        where: { taskId: catchUpTask.id },
      });
      if (!runs.some((r) => r.status === 'success')) throw new Error('未补跑');
    });

    // catchUpOnce：补跑一次（triggerType=catchUp），过期两周期不双跑
    const catchUpRuns = await db.prisma.automationRun.findMany({
      where: { taskId: catchUpTask.id },
    });
    expect(catchUpRuns).toHaveLength(1);
    expect(catchUpRuns[0]).toMatchObject({
      triggerType: 'catchUp',
      status: 'success',
    });
    const catchUpRow = await db.prisma.automationTask.findUniqueOrThrow({
      where: { id: catchUpTask.id },
    });
    expect(catchUpRow.status).toBe('active');
    expect(catchUpRow.nextRunAt?.getTime()).toBeGreaterThan(Date.now());

    // skip 策略：留痕 skipped run 行（triggerType=schedule）+ nextRunAt 推进
    const skipRuns = await db.prisma.automationRun.findMany({
      where: { taskId: skipTask.id },
    });
    expect(skipRuns).toHaveLength(1);
    expect(skipRuns[0]).toMatchObject({
      triggerType: 'schedule',
      status: 'skipped',
    });
    expect(skipRuns[0].finishedAt).not.toBeNull();
    const skipRow = await db.prisma.automationTask.findUniqueOrThrow({
      where: { id: skipTask.id },
    });
    expect(skipRow.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
    expect(skipRow.lastRunAt).toBeNull();
  });

  it('inflight 互斥：手动触发在途 → 二次 runNow 拒 TASK_ALREADY_RUNNING；tick 不并发双跑；stop abort 在途', async () => {
    useModel(new HangingChatModel());
    const task = await createTask(db, wsId, modelId, { nextRunAt: new Date() });
    await automations.runNow(task.id, 1);
    await waitForDb(() => {
      if (!inflight.has(task.id)) throw new Error('未注册在途');
    });

    // 同任务在途：手动二次触发直接拒发
    await expect(automations.runNow(task.id, 1)).rejects.toThrow(
      'TASK_ALREADY_RUNNING',
    );

    // 到期任务 + tick 轰几轮：在途不决策不双跑（run 行恒 1 条）
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const runs = await db.prisma.automationRun.findMany({
      where: { taskId: task.id },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('running');

    // stop：abort 全部在途 → 执行收尾（中止非错误：errorCode 不落，run 以
    // 已生成部分记 success——core runChatStream 中止语义，chat-runner
    // abort 用例同款）、注册表清空
    scheduler.stop();
    await waitForDb(async () => {
      const [run] = await db.prisma.automationRun.findMany({
        where: { taskId: task.id },
      });
      if (run.status === 'running') throw new Error('未收尾');
    });
    expect(inflight.has(task.id)).toBe(false);
  });

  it('runNow 手动触发：建会话落消息但不消耗调度字段（nextRunAt/lastRunAt/status/enabled 不动）', async () => {
    useModel(
      scriptedChatModel([{ steps: [{ kind: 'text', delta: '手动结果' }] }])
        .model,
    );
    const future = new Date(Date.now() + 60 * 60_000);
    const task = await createTask(db, wsId, modelId, {
      nextRunAt: future,
      name: '手动任务',
    });
    await automations.runNow(task.id, 1);

    await waitForDb(async () => {
      const [run] = await db.prisma.automationRun.findMany({
        where: { taskId: task.id },
      });
      if (!run || run.status !== 'success') throw new Error('未完成');
    });
    const [run] = await db.prisma.automationRun.findMany({
      where: { taskId: task.id },
    });
    expect(run).toMatchObject({ triggerType: 'manual', status: 'success' });
    expect(run.sessionId).not.toBeNull();

    // 调度字段原样（advanceTask manual 直返——once 不 expired、相位不动）
    const row = await db.prisma.automationTask.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(row.nextRunAt?.getTime()).toBe(future.getTime());
    expect(row.lastRunAt).toBeNull();
    expect(row.status).toBe('active');
    expect(row.enabled).toBe(true);

    const messages = await db.prisma.messageRecord.findMany({
      where: { sessionId: run.sessionId ?? 0 },
      orderBy: { id: 'asc' },
    });
    expect(messages).toHaveLength(2);
    expect(JSON.parse(messages[1].blocks)).toEqual([
      { type: 'text', text: '手动结果' },
    ]);
  });

  it('无人值守高危拒绝：allowDangerousTools=false 时 run_command 被拒（denied 块落 assistant 消息，任务继续至终文本）', async () => {
    useModel(
      scriptedChatModel([
        {
          steps: [
            {
              kind: 'tool',
              toolCallId: 'cmd1',
              toolName: 'run_command',
              input: { command: 'echo hi' },
            },
          ],
        },
        { steps: [{ kind: 'text', delta: '命令不可用，改为直接回答' }] },
      ]).model,
    );
    // accessMode=full：任务级审批放行仍不越过 config 危险工具门（spec §6 联动）
    const task = await createTask(db, wsId, modelId, {
      accessMode: 'full',
      nextRunAt: new Date(),
    });
    scheduler.start();

    await waitForDb(async () => {
      const [run] = await db.prisma.automationRun.findMany({
        where: { taskId: task.id },
      });
      if (!run || run.status !== 'success') throw new Error('未完成');
    });
    const [run] = await db.prisma.automationRun.findMany({
      where: { taskId: task.id },
    });
    expect(run.status).toBe('success');

    // assistant 消息：run_command denied 终态 + 拒绝原因（config 门文案）+
    // 模型收到拒绝反馈后的终文本（循环继续不中断）
    const [assistant] = await db.prisma.messageRecord.findMany({
      where: { sessionId: run.sessionId ?? 0, role: 'assistant' },
      orderBy: { id: 'desc' },
    });
    const blocks = JSON.parse(assistant.blocks) as Array<{
      type: string;
      state?: string;
      output?: string;
      text?: string;
    }>;
    const denied = blocks.find((b) => b.type === 'tool_call');
    expect(denied).toMatchObject({
      toolCallId: 'cmd1',
      toolName: 'run_command',
      state: 'denied',
    });
    expect(denied?.output).toContain('allowDangerousTools');
    expect(
      blocks.some(
        (b) => b.type === 'text' && b.text === '命令不可用，改为直接回答',
      ),
    ).toBe(true);
  });

  it('executeTask 异常吞掉落库（failRun 补建 run 行），绝不向调度器抛', async () => {
    // 模型工厂抛错：executeTask catch → classifyError → failRun 落 failed run
    createChatModelMock.mockImplementation(() => {
      throw new Error('provider unreachable');
    });
    const task = await createTask(db, wsId, modelId, { nextRunAt: new Date() });
    const outcome = await executeTask(task, {
      triggerType: 'manual',
      attempt: 1,
      abort: new AbortController().signal,
    });
    expect(outcome).toBe('failed');
    const [run] = await db.prisma.automationRun.findMany({
      where: { taskId: task.id },
    });
    expect(run.status).toBe('failed');
    expect(run.finishedAt).not.toBeNull();
  });

  it('启动恢复失败不崩：recoverInterruptedRuns 拒绝 → catch 记 error（无 unhandledRejection，终审 F2）', async () => {
    // private 面结构化收窄（graph-api.spec deps 直读同款）
    const internals = scheduler as unknown as {
      recoverInterruptedRuns: () => Promise<void>;
      logger: { error: (message: string) => void };
    };
    jest
      .spyOn(internals, 'recoverInterruptedRuns')
      .mockRejectedValue(new Error('first db touch down'));
    const loggerSpy = jest.spyOn(internals.logger, 'error');

    // 无修复：start() 的 void this.recoverInterruptedRuns() 即
    // unhandledRejection（首 DB 触点抖动崩进程）；有修复：拒绝被 catch 收敛
    scheduler.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(loggerSpy).toHaveBeenCalledTimes(1);
    expect(String(loggerSpy.mock.calls[0][0])).toContain('first db touch down');
  });
});
