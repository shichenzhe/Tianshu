// ChatRunnerService 端到端（临时库 + scripted 假模型注入）：
// 验证 run() 全链——用户消息落库 → 上下文组装（模型/助手/参数/时间行/
// 工作空间）→ 工具集装配 → runChatStream → assistant 落库 → finish chunk。
// DB 夹具走 test/support/test-db（prisma db push 建临时库），目录/造数/runner
// 构造走 test/support/chat-fixture（session-send.spec M2/M3 用例共用）。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import type { AgentStreamOptions } from 'src/core/tools/tool-gate';
import { ApprovalCoordinator } from 'src/core/tools/approval';
import {
  installBridgeRuntime,
  resetBridgeRuntime,
  respondBridgeTool,
} from 'src/core/tools/bridge/bridge-registry';
import type { ToolRequestPayload } from '@tianshu/protocol';
import type { ChatStreamChunk } from '@tianshu/protocol';
import { createTestDb, type TestDb } from '../support/test-db';
import { waitFor } from '../support/wait-for';
import {
  makeDirs,
  makeRunner,
  seedSession,
  type TestDirs,
} from '../support/chat-fixture';
import { HangingChatModel } from '../helpers/scripted-chat-model';

/** 私有成员经类型收窄取用面（assembleContext 产出的 agent 参数对象断言用） */
type RunnerInternals = {
  approvals: ApprovalCoordinator;
  assembleContext: (
    sessionId: number,
    userId: number,
  ) => Promise<{ agent: AgentStreamOptions }>;
};

describe('ChatRunnerService run', () => {
  let db: TestDb;
  let dirs: TestDirs;

  beforeAll(async () => {
    db = await createTestDb();
    dirs = makeDirs();
  }, 120_000);

  afterAll(async () => {
    await db.cleanup();
    dirs.cleanup();
  });

  it('approveRemember（审批记忆批）：记忆先落表后 respond，isToolAllowed 查表免审', async () => {
    const { session } = await seedSession(db, dirs);
    const { runner } = makeRunner(db, dirs, []);
    const internals = runner as unknown as RunnerInternals;
    // 挂起一个审批（等价 manual 模式 awaiting-approval 态）
    const pending = internals.approvals.request('tc-mem', 'x', 5_000);
    const r = await runner.approveRemember(
      session.id,
      'tc-mem',
      true,
      true,
      'write_file',
    );
    expect(r).toEqual({ hit: true, remembered: true });
    // 记忆行已落（workspaceId 取会话行——先落防竞速；seedSession 返回
    // 窄类型无 workspaceId，此处现查）
    const sessionRow = await db.prisma.sessionRecord.findUnique({
      where: { id: session.id },
      select: { workspaceId: true },
    });
    const row = await db.prisma.toolPermission.findUnique({
      where: {
        workspaceId_toolName: {
          workspaceId: sessionRow!.workspaceId,
          toolName: 'write_file',
        },
      },
    });
    expect(row).not.toBeNull();
    // pending 被 resolve 为批准
    await expect(pending).resolves.toBe(true);
    // isToolAllowed 查表：记忆工具免审、未记忆仍审批
    const ctx = await internals.assembleContext(session.id, 1);
    await expect(ctx.agent.isToolAllowed('write_file')).resolves.toBe(true);
    await expect(ctx.agent.isToolAllowed('run_command')).resolves.toBe(false);
  });

  it('纯文本轮：chunks 顺序 text-delta…finish 收尾，双消息落库（usage 块收尾）', async () => {
    const { session } = await seedSession(db, dirs);
    const { runner } = makeRunner(db, dirs, [
      {
        steps: [
          { kind: 'text', delta: '你好' },
          { kind: 'text', delta: '！' },
        ],
        usage: { input: 4, output: 6 },
      },
    ]);
    const chunks: ChatStreamChunk[] = [];

    await runner.run({
      sessionId: session.id,
      content: '打个招呼',
      onChunk: (chunk) => chunks.push(chunk),
    });

    // chunk 序列：文本增量按序、finish 收尾（usage 不是 chunk，块收尾）
    expect(chunks).toEqual([
      { type: 'text-delta', text: '你好' },
      { type: 'text-delta', text: '！' },
      { type: 'finish' },
    ]);

    const messages = await db.prisma.messageRecord.findMany({
      where: { sessionId: session.id },
      orderBy: { id: 'asc' },
    });
    expect(messages).toHaveLength(2);
    expect(JSON.parse(messages[0].blocks)).toEqual([
      { type: 'text', text: '打个招呼' },
    ]);
    expect(JSON.parse(messages[1].blocks)).toEqual([
      { type: 'text', text: '你好！' },
      { type: 'usage', input: 4, output: 6 },
    ]);
    expect(messages[1].modelId).toBe(session.currentModelId);
    expect(messages[1].error).toBeNull();
  });

  it('FA-T1 images：user 消息 blocks 含 text+image 块（imagePath 原样/mime 按扩展名）；越界前缀拒', async () => {
    const { session } = await seedSession(db, dirs);
    const { runner } = makeRunner(db, dirs, [
      { steps: [{ kind: 'text', delta: '收到' }] },
    ]);

    await runner.run({
      sessionId: session.id,
      content: '看图',
      images: ['attachments/mvgk1/截图.png', 'attachments/mvgk2/photo.jpeg'],
      onChunk: () => {},
    });

    const messages = await db.prisma.messageRecord.findMany({
      where: { sessionId: session.id, role: 'user' },
    });
    expect(JSON.parse(messages[0].blocks)).toEqual([
      { type: 'text', text: '看图' },
      {
        type: 'image',
        imagePath: 'attachments/mvgk1/截图.png',
        mime: 'image/png',
        name: '截图.png',
      },
      {
        type: 'image',
        imagePath: 'attachments/mvgk2/photo.jpeg',
        mime: 'image/jpeg',
        name: 'photo.jpeg',
      },
    ]);

    // 越界前缀（非 attachments/ 起）拒——防任意路径注入引用（code 稳定）
    const escape = await runner
      .run({
        sessionId: session.id,
        content: '坏图',
        images: ['../secrets/x.png'],
        onChunk: () => {},
      })
      .catch((e: { code?: string }) => e.code ?? String(e));
    expect(escape).toBe('FILES_IMAGE_PATH_INVALID');
  });

  it('run_command：allowDangerousTools=false 时整体拒绝（denied 终态块，命令不执行）', async () => {
    const { session } = await seedSession(db, dirs);
    const { runner, model } = makeRunner(db, dirs, [
      {
        steps: [
          {
            kind: 'tool',
            toolCallId: 't1',
            toolName: 'run_command',
            input: { command: 'echo hi' },
          },
        ],
      },
      { steps: [{ kind: 'text', delta: '命令不可用' }] },
    ]);
    const chunks: ChatStreamChunk[] = [];

    await runner.run({
      sessionId: session.id,
      content: '跑个命令',
      onChunk: (chunk) => chunks.push(chunk),
    });

    // 一次工具调用 + 一次续答；拒绝终态进块
    expect(model.calls).toBe(2);
    const denied = chunks.filter(
      (chunk) =>
        chunk.type === 'tool-update' &&
        (chunk as { state: string }).state === 'denied',
    );
    expect(denied).toHaveLength(1);
    expect((denied[0] as { output: string }).output).toContain(
      'allowDangerousTools',
    );
    const messages = await db.prisma.messageRecord.findMany({
      where: { sessionId: session.id, role: 'assistant' },
    });
    const persistedBlocks = JSON.parse(messages[0].blocks) as Array<{
      type: string;
    }>;
    const toolBlocks = persistedBlocks.filter(
      (block) => block.type === 'tool_call',
    );
    expect(toolBlocks).toEqual([
      {
        type: 'tool_call',
        toolCallId: 't1',
        toolName: 'run_command',
        args: { command: 'echo hi' },
        state: 'denied',
        output: expect.stringContaining('allowDangerousTools'),
      },
    ]);
  });

  it('技能启用态过滤（spec §13 项 4）：用户级禁用剔除、工作空间级豁免，重启用即时生效', async () => {
    // 用户级 + 工作空间级技能目录各造一枚（frontmatter name/description 齐全）
    const userSkillDir = join(dirs.dataRoot, 'skills', 'user-skill');
    mkdirSync(userSkillDir, { recursive: true });
    writeFileSync(
      join(userSkillDir, 'SKILL.md'),
      '---\nname: user-skill\ndescription: 用户级技能\n---\n正文',
    );
    const wsSkillDir = join(dirs.workspace, '.tianshu', 'skills', 'ws-skill');
    mkdirSync(wsSkillDir, { recursive: true });
    writeFileSync(
      join(wsSkillDir, 'SKILL.md'),
      '---\nname: ws-skill\ndescription: 工作空间技能\n---\n正文',
    );
    // 两枚都落禁用记录：用户级应剔除，工作空间级不受全局开关管
    // （mirror filterDisabledSkills 同构：仅 source=user 受管）
    for (const name of ['user-skill', 'ws-skill']) {
      await db.prisma.skillRecord.create({
        data: { name, source: 'user', dir: 'unused', enabled: false },
      });
    }

    /** 最近一次 run 的首次模型调用入参拼接（system prompt 含技能清单段） */
    let seenBase = 0;
    const messageText = (m: BaseMessage): string =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    const systemTextOf = (): string =>
      model.seenInputs[seenBase].map(messageText).join('\n');

    const { session } = await seedSession(db, dirs);
    const { runner, model } = makeRunner(db, dirs, [
      { steps: [{ kind: 'text', delta: 'ok' }] },
      { steps: [{ kind: 'text', delta: 'ok' }] },
    ]);
    await runner.run({ sessionId: session.id, content: '第一轮' });
    expect(systemTextOf()).toContain('ws-skill');
    expect(systemTextOf()).not.toContain('user-skill');

    // 禁用对模型=不存在是即时语义：重新启用后下一轮即恢复（免重启）
    await db.prisma.skillRecord.update({
      where: { name: 'user-skill' },
      data: { enabled: true },
    });
    seenBase = model.seenInputs.length;
    await runner.run({ sessionId: session.id, content: '第二轮' });
    expect(systemTextOf()).toContain('ws-skill');
    expect(systemTextOf()).toContain('user-skill');
  });

  it('write_file 默认模式直执行（权限放宽 spec §4.4）：工作空间内免审，文件落盘且循环继续', async () => {
    const { session } = await seedSession(db, dirs);
    const { runner, model } = makeRunner(db, dirs, [
      {
        steps: [
          {
            kind: 'tool',
            toolCallId: 't1',
            toolName: 'write_file',
            input: { path: 'a.txt', content: 'hi' },
          },
        ],
      },
      { steps: [{ kind: 'text', delta: '写好了' }] },
    ]);
    const chunks: ChatStreamChunk[] = [];

    await runner.run({
      sessionId: session.id,
      content: '写个文件',
      onChunk: (chunk) => chunks.push(chunk),
    });

    // 兜底审批移除：无审批 chunk（不挂起也不自动拒），直执行后循环继续
    expect(model.calls).toBe(2);
    expect(
      chunks.filter((chunk) => chunk.type === 'approval-request'),
    ).toHaveLength(0);
    const denied = chunks.filter(
      (chunk) =>
        chunk.type === 'tool-update' &&
        (chunk as { state: string }).state === 'denied',
    );
    expect(denied).toHaveLength(0);

    // 文件真实落盘；done 终态块（已写入文案）+ 终文本 + finish
    expect(existsSync(join(dirs.workspace, 'a.txt'))).toBe(true);
    const messages = await db.prisma.messageRecord.findMany({
      where: { sessionId: session.id, role: 'assistant' },
    });
    expect(JSON.parse(messages[0].blocks)).toEqual([
      {
        type: 'tool_call',
        toolCallId: 't1',
        toolName: 'write_file',
        args: { path: 'a.txt', content: 'hi' },
        state: 'done',
        output: expect.stringContaining('已写入'),
      },
      { type: 'text', text: '写好了' },
    ]);
    expect(chunks[chunks.length - 1]).toEqual({ type: 'finish' });
  });

  it('write_file auto-approve 模式：静默放行，文件落盘', async () => {
    const { session } = await seedSession(db, dirs);
    const { runner } = makeRunner(
      db,
      dirs,
      [
        {
          steps: [
            {
              kind: 'tool',
              toolCallId: 'w1',
              toolName: 'write_file',
              input: { path: 'b.txt', content: '落盘内容' },
            },
          ],
        },
        { steps: [{ kind: 'text', delta: '写好了' }] },
      ],
      { accessMode: 'auto-approve' },
    );
    const chunks: ChatStreamChunk[] = [];

    await runner.run({
      sessionId: session.id,
      content: '写个文件',
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(existsSync(join(dirs.workspace, 'b.txt'))).toBe(true);
    const done = chunks.filter(
      (chunk) =>
        chunk.type === 'tool-update' &&
        (chunk as { state: string }).state === 'done',
    );
    expect(done).toHaveLength(1);
    expect(chunks[chunks.length - 1]).toEqual({ type: 'finish' });
  });

  it('双 null 兜底（P1）：空会话模型+空 workspace 默认 → 取首个启用 llm 模型发送；全无可用模型 → NO_MODEL', async () => {
    // 清场：禁用此前用例 seed 的模型，模拟 fresh 库全空
    await db.prisma.model.updateMany({ data: { enabled: false } });
    const workspace = await db.prisma.workspace.create({
      data: { name: 'fallback-ws', userId: 1 },
    });
    const session = await db.prisma.sessionRecord.create({
      data: { workspaceId: workspace.id, title: 't', userId: 1 },
    });
    const { runner } = makeRunner(db, dirs, [
      { steps: [{ kind: 'text', delta: '兜底成功' }] },
    ]);

    // 全空（无启用模型）→ 维持 NO_MODEL
    await expect(
      runner.run({ sessionId: session.id, content: 'hi' }),
    ).rejects.toThrow('NO_MODEL');

    // 配置可用模型：embedding 模型与禁用 provider 的 llm 模型应被跳过，
    // 兜底命中启用 provider 下首个启用 llm 模型（id 序更小也无妨，跳过条件为准）
    const disabledProvider = await db.prisma.provider.create({
      data: {
        name: 'p-off',
        type: 'openai-compatible',
        baseUrl: 'http://localhost:9/v1',
        enabled: false,
        userId: 1,
      },
    });
    await db.prisma.model.create({
      data: {
        providerId: disabledProvider.id,
        modelId: 'embed-model',
        type: 'embedding',
        enabled: true,
      },
    });
    await db.prisma.model.create({
      data: {
        providerId: disabledProvider.id,
        modelId: 'orphan-llm',
        type: 'llm',
        enabled: true,
      },
    });
    const provider = await db.prisma.provider.create({
      data: {
        name: 'p-on',
        type: 'openai-compatible',
        baseUrl: 'http://localhost:9/v1',
        apiKey: 'sk-test',
        userId: 1,
      },
    });
    const model = await db.prisma.model.create({
      data: {
        providerId: provider.id,
        modelId: 'fallback-llm',
        type: 'llm',
        enabled: true,
      },
    });

    const chunks: ChatStreamChunk[] = [];
    await runner.run({
      sessionId: session.id,
      content: 'hi',
      onChunk: (chunk) => chunks.push(chunk),
    });

    // 正常发送收尾 + assistant 落库模型即兜底命中的 llm 模型
    expect(chunks[chunks.length - 1]).toEqual({ type: 'finish' });
    const assistant = await db.prisma.messageRecord.findFirst({
      where: { sessionId: session.id, role: 'assistant' },
      orderBy: { id: 'desc' },
    });
    expect(assistant?.modelId).toBe(model.id);
  });

  it('无效 modelId 前置校验（M4）：MODEL_OR_PROVIDER_MISSING，用户消息未落库且会话当前模型未被写穿', async () => {
    const { session } = await seedSession(db, dirs);
    const { runner, model } = makeRunner(db, dirs, [
      { steps: [{ kind: 'text', delta: 'x' }] },
    ]);
    // 库中不存在的 model id（远端脏请求/模型已被删除的旧引用）
    const bogusModelId = 999_999;

    await expect(
      runner.run({
        sessionId: session.id,
        content: 'hi',
        modelId: bogusModelId,
      }),
    ).rejects.toThrow('MODEL_OR_PROVIDER_MISSING');

    // 干净失败：用户消息未落库、模型未被调用
    const messages = await db.prisma.messageRecord.findMany({
      where: { sessionId: session.id },
    });
    expect(messages).toHaveLength(0);
    expect(model.calls).toBe(0);
    // currentModelId 未被无效值写穿（仍是 seed 的模型）
    const after = await db.prisma.sessionRecord.findUnique({
      where: { id: session.id },
    });
    expect(after?.currentModelId).toBe(session.currentModelId);
  });

  it('未配模型/并发守卫：NO_MODEL 与 CONCURRENT_REQUEST 错误码', async () => {
    // 兜底链存在后 NO_MODEL 需全库无启用模型（此前用例 seed 的已禁用）
    await db.prisma.model.updateMany({ data: { enabled: false } });
    const workspace = await db.prisma.workspace.create({
      data: { name: 'empty-ws', userId: 1 },
    });
    const noModelSession = await db.prisma.sessionRecord.create({
      data: { workspaceId: workspace.id, title: 't', userId: 1 },
    });
    const { runner } = makeRunner(db, dirs, [
      { steps: [{ kind: 'text', delta: 'x' }] },
    ]);

    await expect(
      runner.run({ sessionId: noModelSession.id, content: 'hi' }),
    ).rejects.toThrow('NO_MODEL');

    // 并发守卫：挂起流（永不产出的模型）期间二次 run 拒绝
    const { session } = await seedSession(db, dirs);
    const hangingRunner = makeRunner(db, dirs, new HangingChatModel());
    const first = hangingRunner.runner.run({
      sessionId: session.id,
      content: 'hi',
    });
    await expect(
      hangingRunner.runner.run({ sessionId: session.id, content: 'again' }),
    ).rejects.toThrow('CONCURRENT_REQUEST');
    hangingRunner.runner.stop(session.id);
    await first; // 中止后收尾不抛（已生成部分保留）
  });

  it('中止挂起流：stop 后 run 收尾（finish chunk）且不抛错', async () => {
    const { session } = await seedSession(db, dirs);
    const chunks: ChatStreamChunk[] = [];
    const { runner, model } = makeRunner(db, dirs, new HangingChatModel());
    const pending = runner.run({
      sessionId: session.id,
      content: 'hi',
      onChunk: (chunk) => chunks.push(chunk),
    });
    await waitFor(() => expect(model.calls).toBeGreaterThan(0));
    runner.stop(session.id);
    await pending;
    expect(chunks[chunks.length - 1]).toEqual({ type: 'finish' });
  });

  it('桥工具装配（TB-T2/R3 缺口 1）：session/send 组装的工具表含 browser 四件', async () => {
    const { session } = await seedSession(db, dirs);
    const { runner, model } = makeRunner(db, dirs, [
      { steps: [{ kind: 'text', delta: 'ok' }] },
    ]);
    await runner.run({ sessionId: session.id, content: 'hi' });
    const names = model.callsLog[0].toolNames;
    for (const name of [
      'browser_snapshot',
      'browser_navigate',
      'browser_click',
      'browser_type',
    ]) {
      expect(names).toContain(name);
    }
  });

  it('桥 write 豁免端到端（TB-T2/R3）：default accessMode 下 browser_click 发出 tool.request 并回喂 respond 结果', async () => {
    const published: ToolRequestPayload[] = [];
    installBridgeRuntime({
      publishToolRequest: (payload) => published.push(payload),
      subscriberCount: () => 1,
      timeoutMs: () => 30_000,
      onSubscribersChanged: () => () => {},
    });
    try {
      const { session } = await seedSession(db, dirs);
      const { runner } = makeRunner(db, dirs, [
        {
          steps: [
            {
              kind: 'tool',
              toolCallId: 'b1',
              toolName: 'browser_click',
              input: { idx: 3 },
            },
          ],
        },
        { steps: [{ kind: 'text', delta: '已点击' }] },
      ]);
      const chunks: ChatStreamChunk[] = [];
      const running = runner.run({
        sessionId: session.id,
        content: '点一下',
        onChunk: (chunk) => chunks.push(chunk),
      });
      await waitFor(() => expect(published).toHaveLength(1));
      expect(published[0]).toMatchObject({
        sessionId: session.id,
        tool: 'browser_click',
        args: { idx: 3 },
      });
      // default accessMode（makeRunner 缺省）下不是本机拒绝——等控制端应答
      respondBridgeTool(published[0].requestId, { ok: true, output: 'OK' });
      await running;
      expect(
        chunks.filter(
          (chunk) =>
            chunk.type === 'tool-update' &&
            (chunk as { state: string }).state === 'denied',
        ),
      ).toHaveLength(0);
      const done = chunks.find(
        (chunk) =>
          chunk.type === 'tool-update' &&
          (chunk as { state: string }).state === 'done',
      ) as { output: string } | undefined;
      expect(done?.output).toBe('OK');
      expect(chunks[chunks.length - 1]).toEqual({ type: 'finish' });
    } finally {
      resetBridgeRuntime();
    }
  });

  it('manual 模式 requestApproval 挂起等待 approvals.request，autoDenyApprovals=false', async () => {
    const { session } = await seedSession(db, dirs);
    const { runner } = makeRunner(
      db,
      dirs,
      [{ steps: [{ kind: 'text', delta: 'x' }] }],
      { accessMode: 'manual' },
    );
    const internals = runner as unknown as RunnerInternals;
    const spy = jest.spyOn(internals.approvals, 'request');

    const manual = await internals.assembleContext(session.id, 1);
    expect(manual.agent.autoDenyApprovals).toBe(false);
    const viaAgent = manual.agent.requestApproval('tc1', '摘要');
    // 挂起语义：返回 === approvals.request 同一 Promise（spy 透传），
    // 超时按缺省 300s（config approvalTimeoutMs 未配置）
    expect(spy).toHaveBeenCalledWith('tc1', '摘要', 300_000);
    expect(viaAgent).toBe(spy.mock.results[spy.mock.results.length - 1].value);
    // 远程应答经 respond 决议进同一 Promise
    expect(internals.approvals.respond('tc1', true)).toBe(true);
    await expect(viaAgent).resolves.toBe(true);

    spy.mockRestore();

    // 对照：default 模式不挂起（requestApproval 直拒）且 autoDenyApprovals=true
    const { runner: defaultRunner } = makeRunner(db, dirs, [
      { steps: [{ kind: 'text', delta: 'x' }] },
    ]);
    const defaultInternals = defaultRunner as unknown as RunnerInternals;
    const fallback = await defaultInternals.assembleContext(session.id, 1);
    expect(fallback.agent.autoDenyApprovals).toBe(true);
    await expect(fallback.agent.requestApproval('tc2', '摘要')).resolves.toBe(
      false,
    );
  });
});
