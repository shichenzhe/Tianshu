// SK-1：OpenAPI 导出契约（spec §2.1）——buildOpenApiDocument 产物含核心
// 端点路径、operationId 与请求 schema 引用（scripts/export-openapi.mjs 与
// main.ts Swagger UI 共用的文档构建面，openapi-typescript 类型生成的输入）。
// 装配沿 session/graph e2e 同款先例（test/support/test-app + 临时库——
// buildOpenApiDocument 本身纯元数据扫描，临时库只为 app.init() 的
// session/webhook 生命周期钩子兜底供数）。
import { INestApplication } from '@nestjs/common';
import { EventBusModule } from 'src/commons/event-bus/event-bus.module';
import { buildOpenApiDocument } from 'src/commons/swagger-document';
import { GraphModule } from 'src/modules/graph/graph.module';
import { SessionModule } from 'src/modules/session/session.module';
import { ToolModule } from 'src/modules/tool/tool.module';
import { createTestApp } from './support/test-app';
import { createTestDb, type TestDb } from './support/test-db';

/** 核心端点断言面：method + 请求体 schema $ref（webhook 触发体为外部
 * 系统自由 JSON（@Body() unknown，无 DTO 面板）——只断言路径与 operationId） */
const corePaths: Record<string, { method: 'post' | 'get'; schemaRef?: string }> =
  {
    '/session/query': {
      method: 'post',
      schemaRef: '#/components/schemas/SessionQueryDto',
    },
    '/session/send': {
      method: 'post',
      schemaRef: '#/components/schemas/SessionSendDto',
    },
    // P1 未读角标批：已读上报端点入册
    '/session/read': {
      method: 'post',
      schemaRef: '#/components/schemas/SessionReadDto',
    },
    '/graph/run': {
      method: 'post',
      schemaRef: '#/components/schemas/GraphRunDto',
    },
    '/tool/respond': {
      method: 'post',
      schemaRef: '#/components/schemas/ToolRespondDto',
    },
    '/webhook/{token}': { method: 'post' },
  };

describe('buildOpenApiDocument（SK-1 导出契约）', () => {
  let app: INestApplication;
  let db: TestDb;
  let document: ReturnType<typeof buildOpenApiDocument>;
  let paths: Record<string, Record<string, any>>;

  beforeAll(async () => {
    db = await createTestDb();
    const built = await createTestApp(db.prisma, [
      EventBusModule,
      SessionModule,
      GraphModule, // 内联装配 WebhookModule（GA-T7 共驻）
      ToolModule,
    ]);
    app = built.app;
    document = buildOpenApiDocument(app);
    paths = document.paths as Record<string, Record<string, any>>;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await db.cleanup();
  });

  it('信息面：OpenAPI 3.x + Basic/Bearer 双安全方案（main.ts 迁移保持）', () => {
    expect(document.openapi).toMatch(/^3\./);
    expect(document.info.title).toBeTruthy();
    expect(Object.keys(document.components?.securitySchemes ?? {})).toEqual(
      expect.arrayContaining(['basic', 'bearer']),
    );
  });

  it.each(Object.entries(corePaths))(
    '%s：路径存在 + operationId 非空 + 请求 schema 引用可达',
    (path, { method, schemaRef }) => {
      const operation = paths[path]?.[method];
      expect(operation).toBeDefined();
      expect(operation.operationId).toMatch(/.+/);

      if (schemaRef) {
        const bodySchema = operation.requestBody?.content?.['application/json']
          ?.schema;
        expect(bodySchema?.$ref).toBe(schemaRef);
        // $ref 目标 schema 真实存在（防悬空引用——生成类型的前提）
        const schemaName = schemaRef.split('/').pop() as string;
        expect(document.components?.schemas?.[schemaName]).toBeDefined();
      }
    },
  );

  it('webhook 路径参数化：{token} 触发 + {token}/jobs/{id} 轮询', () => {
    expect(paths['/webhook/{token}']?.post).toBeDefined();
    expect(paths['/webhook/{token}']?.post.parameters?.[0]).toMatchObject({
      name: 'token',
    });
    expect(paths['/webhook/{token}/jobs/{id}']?.get).toBeDefined();
  });
});
