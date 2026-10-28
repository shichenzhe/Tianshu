// A9 会话内工具批（spec 2026-10-26 §1 阶段 2/3）：POST session/compact
// （202 受理 + 异步写链——清态 → 摘要轮 → 回填 summary/compactedUpToId，
// 中止不回填，照桌面 chat.service compact 行为 golden）与 POST
// session/polish（同步一次性补全 30s 超时；模型解析回退链
// workspace 默认模型 → 首个启用 provider 的 id 最小启用模型）。
// fake model 经 CHAT_RUNNER_DEPS 注入点（session-send.spec 同款手法）。
import request from 'supertest';
import * as http from 'node:http';
import { INestApplication } from '@nestjs/common';
import { ChatCoreModule } from 'src/core/chat-core.module';
import { CHAT_RUNNER_DEPS } from 'src/core/chat-runner.service';
import { EventModule } from 'src/modules/event/event.module';
import { SessionModule } from 'src/modules/session/session.module';
import { EventBusModule } from 'src/commons/event-bus/event-bus.module';
import { EventBusService } from 'src/commons/event-bus/event-bus.service';
import type { ServerEvent } from '@tianshu/protocol';
import type { ChatResult } from '@langchain/core/outputs';
import type { BaseMessage } from '@langchain/core/messages';
import { createTestDb, type TestDb } from '../support/test-db';
import { createTestApp, WrappedBody } from '../support/test-app';
import { waitFor } from '../support/wait-for';
import { makeDirs, seedSession } from '../support/chat-fixture';
import {
  HangingChatModel,
  ScriptedChatModel,
} from '../helpers/scripted-chat-model';

/** polish 超时用假模型：非流式 _generate 挂起至 signal 中止后 reject
 * （真实 provider 半开连接形态——AbortSignal.timeout 触发即抛） */
class HangingGenerateModel extends ScriptedChatModel {
  override _generate(
    _messages: BaseMessage[],
    options?: { signal?: AbortSignal },
  ): Promise<ChatResult> {
    this.calls += 1;
    return new Promise<ChatResult>((_, reject) => {
      if (options?.signal?.aborted) {
        reject(new Error('aborted by timeout signal'));
        return;
      }
      options?.signal?.addEventListener(
        'abort',
        () => reject(new Error('aborted by timeout signal')),
        { once: true },
      );
    });
  }
}

describe('session/compact + session/polish (A9 会话内工具批)', () => {
  let app: INestApplication;
  let server: http.Server;
  let db: TestDb;
  let bus: EventBusService;
  /** 每用例置换的假模型（modelFactory 实时取引用） */
  let activeModel: ScriptedChatModel;
  /** modelFactory 收到的 SDK 模型标识序列（模型解析回退链断言用） */
  let factoryModelIds: string[];
  /** EventBus 全量事件序列（每用例清零重收） */
  let events: ServerEvent[];
  let unsubscribe: () => void;

  beforeAll(async () => {
    db = await createTestDb();
    activeModel = new ScriptedChatModel([]);
    const built = await createTestApp(
      db.prisma,
      [EventBusModule, SessionModule, ChatCoreModule, EventModule],
      (builder) =>
        builder.overrideProvider(CHAT_RUNNER_DEPS).useValue({
          modelFactory: (_provider, modelId) => {
            factoryModelIds.push(modelId);
            return activeModel;
          },
          config: () => ({
            dataRoot: db.dataRoot,
            allowDangerousTools: false,
            deleteProtection: true,
            accessMode: 'default',
          }),
        }),
    );
    app = built.app;
    server = built.server;
    bus = app.get(EventBusService);
    events = [];
    factoryModelIds = [];
    unsubscribe = bus.subscribe((event) => events.push(event));
  }, 120_000);

  afterAll(async () => {
    unsubscribe();
    await app.close();
    await db.cleanup();
  });

  const post = (path: string, body?: Record<string, unknown>): request.Test =>
    request(server).post(path).send(body ?? {});

  beforeEach(() => {
    events.length = 0;
    factoryModelIds.length = 0;
  });

  describe('POST /session/compact', () => {
    it('202 受理 → 清旧压缩态 → 摘要轮落库 → 末条 assistant 文本回填 summary/compactedUpToId + session.updated 事件', async () => {
      const { session } = await seedSession(db, makeDirs());
      // 既有历史 + 旧压缩态（验证「清态先行」：摘要基于全量历史）
      await db.prisma.messageRecord.create({
        data: {
          sessionId: session.id,
          role: 'user',
          blocks: JSON.stringify([{ type: 'text', text: '问题一' }]),
        },
      });
      const oldAssistant = await db.prisma.messageRecord.create({
        data: {
          sessionId: session.id,
          role: 'assistant',
          blocks: JSON.stringify([{ type: 'text', text: '旧回答' }]),
        },
      });
      await db.prisma.sessionRecord.update({
        where: { id: session.id },
        data: { summary: '旧摘要', compactedUpToId: oldAssistant.id },
      });
      // createdAt 拉开档次：compact 回填按 createdAt desc 取末条——同毫秒
      // 并列时排序不确定（桌面 golden 语义，真实场景消息间隔秒级）
      await db.prisma.messageRecord.update({
        where: { id: oldAssistant.id },
        data: { createdAt: new Date(Date.now() - 60_000) },
      });
      activeModel = new ScriptedChatModel([
        { steps: [{ kind: 'text', delta: '新摘要内容' }] },
      ]);

      const res = await post('/session/compact', {
        sessionId: session.id,
      }).expect(202);
      expect((res.body as WrappedBody<{ accepted: boolean }>).data).toEqual({
        accepted: true,
      });

      // 完成信号：enriched session.updated（写链已提交——含中止在内的
      // 正常收尾都发该事件，DB 断言在其后做，避免轮询异步断言）
      await waitFor(() =>
        expect(
          events.some(
            (e) => e.type === 'session.updated' && e.payload.id === session.id,
          ),
        ).toBe(true),
      );

      const row = await db.prisma.sessionRecord.findUniqueOrThrow({
        where: { id: session.id },
      });
      expect(row.summary).toBe('新摘要内容');
      expect(row.compactedUpToId).not.toBe(oldAssistant.id);
      // 回填点 = 摘要轮 assistant 消息 id（倒序末条）
      const summaryMessage = await db.prisma.messageRecord.findUniqueOrThrow({
        where: { id: row.compactedUpToId ?? -1 },
      });
      expect(summaryMessage.role).toBe('assistant');
      expect(summaryMessage.blocks).toContain('新摘要内容');
      // 指令轮：user 行落库（压缩指令走普通发送轮——流式可见同桌面）
      const userRows = await db.prisma.messageRecord.findMany({
        where: { sessionId: session.id, role: 'user' },
      });
      expect(userRows.some((m) => m.blocks.includes('压缩为一份简洁'))).toBe(
        true,
      );
      expect(events.some((e) => e.type === 'session.error')).toBe(false);
    });

    it('中止不回填：清态保持 null，无 summary/compactedUpToId 写入（桌面 golden）', async () => {
      const { session } = await seedSession(db, makeDirs());
      await db.prisma.sessionRecord.update({
        where: { id: session.id },
        data: { summary: '旧摘要', compactedUpToId: 1 },
      });
      activeModel = new HangingChatModel();

      await post('/session/compact', { sessionId: session.id }).expect(202);
      // 等摘要轮进入模型节点（指令已落库、清态已发生）
      await waitFor(() => expect(activeModel.calls).toBe(1));
      const cleared = await db.prisma.sessionRecord.findUniqueOrThrow({
        where: { id: session.id },
      });
      expect(cleared.summary).toBeNull();
      expect(cleared.compactedUpToId).toBeNull();

      await post('/session/abort', { sessionId: session.id }).expect(200);
      await waitFor(() =>
        expect(
          events.some((e) => e.type === 'session.updated'),
        ).toBe(true),
      );
      // 中止后不回填：压缩态维持清空态（摘要轮为残文，桌面同语义）
      const after = await db.prisma.sessionRecord.findUniqueOrThrow({
        where: { id: session.id },
      });
      expect(after.summary).toBeNull();
      expect(after.compactedUpToId).toBeNull();
    });

    it('会话不存在：业务错 4040', async () => {
      const res = await post('/session/compact', { sessionId: 999999 });
      expect((res.body as WrappedBody<null>).code).toBe('4040');
    });

    it('进行中的流并发 compact：runner 并发守卫 → session.error CONCURRENT_REQUEST', async () => {
      const { session } = await seedSession(db, makeDirs());
      activeModel = new HangingChatModel();
      await post('/session/send', {
        sessionId: session.id,
        content: '挂着',
      }).expect(202);
      await waitFor(() => expect(activeModel.calls).toBe(1));
      events.length = 0;

      await post('/session/compact', { sessionId: session.id }).expect(202);
      await waitFor(() =>
        expect(
          events.some(
            (e) =>
              e.type === 'session.error' &&
              e.payload.sessionId === session.id &&
              e.payload.code === 'CONCURRENT_REQUEST',
          ),
        ).toBe(true),
      );
      await post('/session/abort', { sessionId: session.id });
    });
  });

  describe('POST /session/polish', () => {
    it('workspace 默认模型优先：system 承载改写指令 + human 为原文，同步返回改写文本', async () => {
      const { session, model } = await seedSession(db, makeDirs());
      activeModel = new ScriptedChatModel([
        { steps: [{ kind: 'text', delta: '润色后的文本' }] },
      ]);

      const res = await post('/session/polish', {
        workspaceId: 999999,
        text: '帮我把这段改专业点',
        style: 'professional',
      });
      // 错误空间 4040；改用真实 workspaceId 再走成功路径
      expect((res.body as WrappedBody<null>).code).toBe('4040');

      const workspace = await db.prisma.workspace.findFirstOrThrow({
        where: { defaultModelId: model.id },
      });
      factoryModelIds.length = 0;
      const ok = await post('/session/polish', {
        workspaceId: workspace.id,
        text: '帮我把这段改专业点',
        style: 'professional',
      });
      expect((ok.body as WrappedBody<{ text: string }>).data).toEqual({
        text: '润色后的文本',
      });
      // 模型解析：workspace 默认模型（SDK 模型标识透传工厂）
      expect(factoryModelIds).toEqual(['test-model']);
      // 消息形状：SystemMessage 改写指令 + HumanMessage 原文
      const messages = activeModel.seenInputs.at(-1) ?? [];
      expect(messages).toHaveLength(2);
      expect(messages[0].getType()).toBe('system');
      expect(String(messages[0].content)).toContain('专业、正式');
      expect(messages[1].getType()).toBe('human');
      expect(messages[1].content).toBe('帮我把这段改专业点');
      // 不落库不建会话：消息表无新增（本会话无消息）
      expect(
        await db.prisma.messageRecord.count({ where: { sessionId: session.id } }),
      ).toBe(0);
    });

    it('回退链：无默认模型 → 首个启用 provider 的 id 最小启用模型；未知 style 回退 professional', async () => {
      const { model } = await seedSession(db, makeDirs());
      // 第二个 provider（enabled 缺省 true）+ 更大 id 模型：回退链应仍取
      // id 最小的首个启用模型（model 与 provider 无 relation，两步查）
      const provider2 = await db.prisma.provider.create({
        data: {
          name: 'p2',
          type: 'openai-compatible',
          baseUrl: 'http://localhost:9/v1',
          userId: 1,
        },
      });
      await db.prisma.model.create({
        data: {
          providerId: provider2.id,
          modelId: 'other-model',
          name: '另一模型',
        },
      });
      const workspace = await db.prisma.workspace.findFirstOrThrow({
        where: { defaultModelId: model.id },
      });
      await db.prisma.workspace.update({
        where: { id: workspace.id },
        data: { defaultModelId: null },
      });
      activeModel = new ScriptedChatModel([
        { steps: [{ kind: 'text', delta: '精简结果' }] },
      ]);

      const res = await post('/session/polish', {
        workspaceId: workspace.id,
        text: '一段很长很长的话',
        style: '不存在的风格',
      });
      expect((res.body as WrappedBody<{ text: string }>).data).toEqual({
        text: '精简结果',
      });
      expect(factoryModelIds).toEqual(['test-model']);
      // 未知 style 回退 professional 指令
      const messages = activeModel.seenInputs.at(-1) ?? [];
      expect(String((messages[0] as { content: unknown }).content)).toContain(
        '专业、正式',
      );
    });

    it('无可用模型：5000 有用文案（全部 provider 禁用）', async () => {
      const { model } = await seedSession(db, makeDirs());
      const workspace = await db.prisma.workspace.findFirstOrThrow({
        where: { defaultModelId: model.id },
      });
      await db.prisma.workspace.update({
        where: { id: workspace.id },
        data: { defaultModelId: null },
      });
      await db.prisma.provider.updateMany({
        where: { userId: 1 },
        data: { enabled: false },
      });
      const res = await post('/session/polish', {
        workspaceId: workspace.id,
        text: 'hi',
      });
      const body = res.body as WrappedBody<null>;
      expect(body.code).toBe('5000');
      expect(body.message).toContain('未配置可用模型');
    });

    it('30s 超时：AbortSignal.timeout 触发 → 5000 业务错（半开连接不永久挂起）', async () => {
      const { model } = await seedSession(db, makeDirs());
      const workspace = await db.prisma.workspace.findFirstOrThrow({
        where: { defaultModelId: model.id },
      });
      activeModel = new HangingGenerateModel([]);
      // 缩短超时窗口：真实 AbortSignal.timeout(30_000) 不可测，spy 为
      // 10ms 触发（信号语义不变——模型侧 abort 协作同真实 provider）
      const timeoutSpy = jest
        .spyOn(AbortSignal, 'timeout')
        .mockImplementation(() => {
          const controller = new AbortController();
          setTimeout(() => controller.abort(), 10);
          return controller.signal;
        });
      try {
        const res = await post('/session/polish', {
          workspaceId: workspace.id,
          text: '会挂起的文本',
        });
        expect((res.body as WrappedBody<null>).code).toBe('5000');
      } finally {
        timeoutSpy.mockRestore();
      }
    });
  });
});
