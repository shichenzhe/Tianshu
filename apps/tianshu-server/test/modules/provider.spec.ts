import request from 'supertest'; // esModuleInterop 开启后 export= 不可命名空间直调
import * as http from 'node:http';
import { INestApplication } from '@nestjs/common';
import { ProviderModule } from 'src/modules/provider/provider.module';
import { createTestDb, TestDb } from '../support/test-db';
import { createTestApp, WrappedBody } from '../support/test-app';

interface ProviderRow {
  id: number;
  name: string;
  type: string;
  baseUrl: string;
  enabled: boolean;
  userId: number | null;
  [key: string]: unknown;
}

interface ModelRow {
  id: number;
  providerId: number;
  modelId: string;
  type: string;
  enabled: boolean;
  [key: string]: unknown;
}

interface ProviderBundle {
  providers: ProviderRow[];
  models: ModelRow[];
}

/**
 * provider 模块 e2e：POST query/save（模型配置查存）。
 * save 为 upsert 数组语义（mirror 无全量覆盖先例，控制者裁定简化）：
 * 项带 id → 更新，不带 id → 新建，全部走事务。
 */
describe('ProviderController (e2e)', () => {
  let app: INestApplication;
  let server: http.Server;
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    const built = await createTestApp(db.prisma, [ProviderModule]);
    app = built.app;
    server = built.server;
  });

  afterAll(async () => {
    await app.close();
    await db.cleanup();
  });

  const post = (path: string, body?: Record<string, unknown>): request.Test =>
    request(server)
      .post(path)
      .send(body ?? {});

  const query = async (): Promise<ProviderBundle> =>
    (
      (await post('/provider/query').expect(200))
        .body as WrappedBody<ProviderBundle>
    ).data;

  const save = async (body: Record<string, unknown>) =>
    (await post('/provider/save', body).expect(200))
      .body as WrappedBody<ProviderBundle>;

  describe('POST /provider/query', () => {
    it('空库返回空 providers/models', async () => {
      const data = await query();
      expect(data.providers).toEqual([]);
      expect(data.models).toEqual([]);
    });
  });

  describe('POST /provider/save', () => {
    it('无 id → 新建（userId=1 伴生语义），返回全量状态且 query 可见', async () => {
      const body = await save({
        providers: [
          {
            name: 'ollama',
            type: 'ollama',
            baseUrl: 'http://127.0.0.1:11434',
          },
        ],
        models: [],
      });
      expect(body.success).toBe(true);
      expect(body.data.providers).toHaveLength(1);
      expect(body.data.providers[0].id).toBeGreaterThan(0);
      expect(body.data.providers[0].userId).toBe(1);
      expect(body.data.providers[0].enabled).toBe(true);
      expect(body.data.models).toEqual([]);

      const data = await query();
      expect(data.providers).toHaveLength(1);
      expect(data.providers[0].name).toBe('ollama');
    });

    it('带 id → 更新；model 新增与更新（upsert 数组语义，未传维度不动）', async () => {
      const created = await save({
        providers: [
          { name: 'p1', type: 'openai-compatible', baseUrl: 'http://x' },
        ],
      });
      const providerId = created.data.providers.find(
        (p) => p.name === 'p1',
      )!.id;

      // 更新 provider + 新增 model
      const updated = await save({
        providers: [
          {
            id: providerId,
            name: 'p1改',
            type: 'openai-compatible',
            baseUrl: 'http://y',
          },
        ],
        models: [{ providerId, modelId: 'qwen2.5:7b', type: 'llm' }],
      });
      const updatedProvider = updated.data.providers.find(
        (p) => p.id === providerId,
      )!;
      expect(updatedProvider.name).toBe('p1改');
      expect(updatedProvider.baseUrl).toBe('http://y');
      expect(updated.data.models).toHaveLength(1);
      expect(updated.data.models[0].modelId).toBe('qwen2.5:7b');
      expect(updated.data.models[0].type).toBe('llm');
      const modelId = updated.data.models[0].id;

      // 未传 providers 维度不丢（计数沿用保存后现值）；model 带 id → 更新
      const providerCount = updated.data.providers.length;
      const again = await save({
        models: [{ id: modelId, providerId, modelId: 'qwen2.5:14b' }],
      });
      expect(again.data.providers).toHaveLength(providerCount);
      expect(again.data.models).toHaveLength(1);
      expect(again.data.models[0].modelId).toBe('qwen2.5:14b');
    });

    it('model 可选字段 null 清除、undefined 保留（A1 终审 F3 三态契约）', async () => {
      const seeded = await save({
        providers: [
          {
            name: 'model-tri-state',
            type: 'openai-compatible',
            baseUrl: 'http://tri-state',
          },
        ],
      });
      const providerId = seeded.data.providers.find(
        (p) => p.name === 'model-tri-state',
      )!.id;
      const created = await save({
        models: [
          {
            providerId,
            modelId: 'tri-state-model',
            name: 'old-name',
            temperature: 0.7,
            topP: 0.9,
            maxTokens: 4096,
            contextWindow: 8192,
          },
        ],
      });
      const id = created.data.models.find(
        (m) => m.providerId === providerId && m.modelId === 'tri-state-model',
      )!.id;

      await save({ models: [{ id, providerId, modelId: 'tri-state-model' }] });
      const preserved = await db.prisma.model.findUnique({ where: { id } });
      expect(preserved).toMatchObject({
        name: 'old-name',
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 4096,
        contextWindow: 8192,
      });

      await save({
        models: [
          {
            id,
            providerId,
            modelId: 'tri-state-model',
            name: null,
            temperature: null,
            topP: null,
            maxTokens: null,
            contextWindow: null,
          },
        ],
      });
      const cleared = await db.prisma.model.findUnique({ where: { id } });
      expect(cleared).toMatchObject({
        name: null,
        temperature: null,
        topP: null,
        maxTokens: null,
        contextWindow: null,
      });
    });

    it('provider 更新省略 apiKey/extraHeaders 不清空现值（F4-1：undefined 保留、null 清除）', async () => {
      const created = await save({
        providers: [
          {
            name: 'keepkey',
            type: 'openai-compatible',
            baseUrl: 'http://keep',
            apiKey: 'sk-keep-me',
            extraHeaders: '{"X-Trace":"1"}',
          },
        ],
      });
      const id = created.data.providers.find((p) => p.name === 'keepkey')!.id;

      // 更新项省略两字段 → 保留现值（不因缺省被清空）；query 面已脱敏
      // （M5），真实值直读库断言
      await save({
        providers: [
          {
            id,
            name: 'keepkey改',
            type: 'openai-compatible',
            baseUrl: 'http://keep2',
          },
        ],
      });
      const after = await db.prisma.provider.findUnique({ where: { id } });
      expect(after?.apiKey).toBe('sk-keep-me');
      expect(after?.extraHeaders).toBe('{"X-Trace":"1"}');
      const redacted = (await query()).providers.find((p) => p.id === id)!;
      expect(redacted.apiKey).toBe('__REDACTED__');

      // 显式传 null 仍可主动清除（与 undefined 保留语义并存）
      await save({
        providers: [
          {
            id,
            name: 'keepkey清',
            type: 'openai-compatible',
            baseUrl: 'http://keep3',
            apiKey: null,
            extraHeaders: null,
          },
        ],
      });
      const cleared = await db.prisma.provider.findUnique({ where: { id } });
      expect(cleared?.apiKey).toBeNull();
      expect(cleared?.extraHeaders).toBeNull();
    });

    it('save 回传 REDACTED 掩码不清空现值（防远控端误回写，M5）', async () => {
      const created = await save({
        providers: [
          {
            name: 'mask-echo',
            type: 'openai-compatible',
            baseUrl: 'http://mask',
            apiKey: 'sk-keep-me',
            extraHeaders: '{"X-Trace":"t"}',
          },
        ],
      });
      const id = created.data.providers.find((p) => p.name === 'mask-echo')!.id;

      // 控制端把脱敏响应原样回传：apiKey 整串掩码、extraHeaders 含掩码值
      const masked = created.data.providers.find(
        (p) => p.name === 'mask-echo',
      )!;
      const maskedApiKey = masked.apiKey as string;
      const maskedExtraHeaders = masked.extraHeaders as string;
      expect(maskedApiKey).toBe('__REDACTED__');
      const body = await save({
        providers: [
          {
            id,
            name: 'mask-echo改',
            type: 'openai-compatible',
            baseUrl: 'http://mask2',
            apiKey: maskedApiKey,
            extraHeaders: maskedExtraHeaders,
          },
        ],
      });
      expect(body.success).toBe(true);
      // query 面已脱敏——真实值直读库断言（掩码按未传处理，未覆盖现值）
      const row = await db.prisma.provider.findUnique({ where: { id } });
      expect(row?.apiKey).toBe('sk-keep-me');
      expect(row?.extraHeaders).toBe('{"X-Trace":"t"}');

      // 真实值仍可正常改写（掩码检测不误伤正常更新）
      await save({
        providers: [
          {
            id,
            name: 'mask-echo再改',
            type: 'openai-compatible',
            baseUrl: 'http://mask3',
            apiKey: 'sk-new',
            extraHeaders: '{"X-Trace":"t2"}',
          },
        ],
      });
      const rewritten = await db.prisma.provider.findUnique({
        where: { id },
      });
      expect(rewritten?.apiKey).toBe('sk-new');
      expect(rewritten?.extraHeaders).toBe('{"X-Trace":"t2"}');
    });

    it('provider 引用不存在 id：业务错误 4040 且整批回滚（事务）', async () => {
      const before = await query();
      const providerId = before.providers[0].id;

      const body = await save({
        providers: [{ id: 999999, name: 'x', type: 't', baseUrl: 'http://z' }],
        models: [{ providerId, modelId: 'should-rollback' }],
      });
      expect(body.success).toBe(false);
      expect(body.code).toBe('4040');

      const after = await query();
      expect(after.models.some((m) => m.modelId === 'should-rollback')).toBe(
        false,
      );
      expect(after.models.length).toBe(before.models.length);
    });

    it('model 引用不属于伴生用户的 provider：业务错误 4040', async () => {
      // 直接造一行他人 provider（userId=2），save 的 model 不允许挂靠
      const foreign = await db.prisma.provider.create({
        data: {
          name: 'foreign',
          type: 'openai-compatible',
          baseUrl: 'http://foreign',
          userId: 2,
        },
      });
      const body = await save({
        models: [{ providerId: foreign.id, modelId: 'm' }],
      });
      expect(body.success).toBe(false);
      expect(body.code).toBe('4040');
      const count = await db.prisma.model.count();
      // 前序用例建的 model 仍在，本条未新增
      const data = await query();
      expect(data.models.length).toBe(count);
    });

    it('query 有值 apiKey/extraHeaders 以 REDACTED 掩码返回；空值原样（M5 脱敏）', async () => {
      const body = await save({
        providers: [
          {
            name: 'secret',
            type: 'openai-compatible',
            baseUrl: 'http://secret',
            apiKey: 'sk-real',
            extraHeaders: '{"X-Key":"hv-real","X-Empty":""}',
          },
          { name: 'plain', type: 'ollama', baseUrl: 'http://plain' },
        ],
      });
      // save 响应（内部走 query）同口径脱敏
      expect(body.data.providers.find((p) => p.name === 'secret')!.apiKey).toBe(
        '__REDACTED__',
      );
      expect(body.data.providers.find((p) => p.name === 'plain')!.apiKey).toBe(
        null,
      );

      const data = await query();
      const secret = data.providers.find((p) => p.name === 'secret')!;
      // 有值 → 掩码；extraHeaders 键名保留、逐值掩码（空值不掩）
      expect(secret.apiKey).toBe('__REDACTED__');
      expect(secret.extraHeaders).toBe('{"X-Key":"__REDACTED__","X-Empty":""}');
      // 空值原样（空与已配置可区分）
      const plain = data.providers.find((p) => p.name === 'plain')!;
      expect(plain.apiKey).toBeNull();
      expect(plain.extraHeaders).toBeNull();
    });

    it('异常 extraHeaders 形状 fail-closed 脱敏，不回泄嵌套秘密（A1 终审 F1）', async () => {
      const fixtures = [
        { name: 'headers-array', value: '["sk-real-array"]' },
        { name: 'headers-scalar', value: '"sk-real-scalar"' },
        { name: 'headers-number', value: '42' },
        {
          name: 'headers-nested',
          value: '{"X-Auth":{"token":"sk-real-nested"},"X-Count":2}',
        },
      ];
      for (const fixture of fixtures) {
        await db.prisma.provider.create({
          data: {
            name: fixture.name,
            type: 'openai-compatible',
            baseUrl: 'http://headers',
            extraHeaders: fixture.value,
            userId: 1,
          },
        });
      }

      const data = await query();
      const rows = fixtures.map((fixture) =>
        data.providers.find((p) => p.name === fixture.name),
      );
      expect(rows[0]?.extraHeaders).toBe('__REDACTED__');
      expect(rows[1]?.extraHeaders).toBe('__REDACTED__');
      expect(rows[2]?.extraHeaders).toBe('__REDACTED__');
      expect(rows[3]?.extraHeaders).toBe(
        '{"X-Auth":"__REDACTED__","X-Count":"__REDACTED__"}',
      );
      expect(JSON.stringify(rows)).not.toContain('sk-real');
    });
  });

  describe('POST /provider/delete', () => {
    it('providerIds 级联清 models；modelIds 单删；归属外 id 幂等跳过', async () => {
      // 共享库清场：前序用例残留的 providers 全删（级联清其 models）
      const stale = await query();
      if (stale.providers.length > 0) {
        await post('/provider/delete', {
          providerIds: stale.providers.map((p) => p.id),
        }).expect(200);
      }
      const seeded = await save({
        providers: [
          { name: 'p1', type: 'openai-compatible', baseUrl: 'http://x' },
          { name: 'p2', type: 'openai-compatible', baseUrl: 'http://y' },
        ],
      });
      const p1 = seeded.data.providers.find((p) => p.name === 'p1')!.id;
      const p2 = seeded.data.providers.find((p) => p.name === 'p2')!.id;
      const withModels = await save({
        models: [
          { providerId: p1, modelId: 'm1' },
          { providerId: p1, modelId: 'm2' },
          { providerId: p2, modelId: 'm3' },
        ],
      });
      const m2 = withModels.data.models.find((m) => m.modelId === 'm2')!.id;

      // 单删 m2
      const afterModel = await post('/provider/delete', {
        modelIds: [m2],
      }).expect(200);
      expect(
        afterModel.body.data.models.map((m: ModelRow) => m.modelId).sort(),
      ).toEqual(['m1', 'm3']);
      // 级联删 p1（m1 随之消失）+ 归属外 id 静默
      const afterProvider = await post('/provider/delete', {
        providerIds: [p1, 99999],
      }).expect(200);
      expect(
        afterProvider.body.data.providers.map((p: ProviderRow) => p.name),
      ).toEqual(['p2']);
      expect(
        afterProvider.body.data.models.map((m: ModelRow) => m.modelId),
      ).toEqual(['m3']);
    });
  });

  describe('POST /provider/test 与 /provider/fetchModels', () => {
    const realFetch = global.fetch;
    afterEach(() => {
      (global as { fetch: typeof fetch }).fetch = realFetch;
    });

    it('fetchModels：openai-compatible 拼 /models 解析 data[].id；连通失败结构化 success=false', async () => {
      const seeded = await save({
        providers: [
          {
            name: 'openai',
            type: 'openai-compatible',
            baseUrl: 'http://up.test/v1',
            apiKey: 'sk-1',
          },
        ],
      });
      const providerId = seeded.data.providers[0].id;

      (global as { fetch: unknown }).fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: 'gpt-x', name: 'GPT X' }, { id: 'gpt-y' }],
        }),
      } as never);
      const okBody = (
        await post('/provider/fetchModels', { providerId }).expect(200)
      ).body as WrappedBody<{
        success: boolean;
        models: Array<{ modelId: string; name?: string }>;
      }>;
      expect(okBody.data.success).toBe(true);
      expect(okBody.data.models).toEqual([
        { modelId: 'gpt-x', name: 'GPT X' },
        { modelId: 'gpt-y' },
      ]);
      // 鉴权头随请求携带
      expect(
        (global.fetch as jest.Mock).mock.calls[0][1].headers.Authorization,
      ).toBe('Bearer sk-1');

      (global as { fetch: unknown }).fetch = jest
        .fn()
        .mockRejectedValue(new Error('ECONNREFUSED'));
      const failBody = (
        await post('/provider/fetchModels', { providerId }).expect(200)
      ).body as WrappedBody<{ success: boolean; errorCode: string }>;
      expect(failBody.data.success).toBe(false);
      expect(failBody.data.errorCode).toBe('UNREACHABLE');
    });

    it('test：上游可达即 ok=true；HTTP 非 2xx 即 ok=false', async () => {
      const seeded = await save({
        providers: [
          { name: 't', type: 'openai-compatible', baseUrl: 'http://up.test' },
        ],
      });
      const providerId = seeded.data.providers[0].id;

      (global as { fetch: unknown }).fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      } as never);
      expect(
        (await post('/provider/test', { providerId }).expect(200)).body.data,
      ).toMatchObject({ ok: true });

      (global as { fetch: unknown }).fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({}),
      } as never);
      expect(
        (await post('/provider/test', { providerId }).expect(200)).body.data,
      ).toMatchObject({ ok: false });
    });

    it('归属外 providerId → 业务错 4040', async () => {
      (await post('/provider/test', { providerId: 424242 }).expect(200)).body;
      const notFound = await post('/provider/fetchModels', {
        providerId: 424242,
      }).expect(200);
      expect(notFound.body.success).toBe(false);
    });
  });
});
