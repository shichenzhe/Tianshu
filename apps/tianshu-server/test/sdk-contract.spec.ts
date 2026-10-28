/**
 * SK-2（spec §2.2）：SDK 生成契约 ↔ @tianshu/protocol 手写契约兼容性
 * witness——防「openapi schema（外部 SDK 消费面）」与「手写协议类型
 * （内部 source of truth）」两端漂移。
 *
 * **类型层（编译期——失败=本文件编译红而非用例红）**：import
 * sdk/api-types.d.ts 生成类型（openapi-typescript 产物）与协议手写契约
 * 做可赋值性断言。断言语义取务实面：生成类型是 schema 形（可选性平铺、
 * 无判别联合），手写契约是 TS 形（字面量收窄/联合），不强求 Equal：
 * - 双向可赋值：session/approve ↔ ApproveParams（形状全等）；
 *   session/send ↔ ChatSendParams（双方额外字段均可选——excess 不阻
 *   结构兼容；overrides/images 为 mirror IPC 面、assistantId 为无头
 *   HTTP 面，各自可选不破兼容）；
 * - 单向（协议→生成）：tool/respond 的 result ↔ BridgeToolResult——
 *   OpenAPI 3.0 无法表达判别联合，生成形是协议联合的宽松超集（ok 平铺
 *   为 boolean、output/error 条件可选），反向收敛由 server 侧
 *   toBridgeToolResult 运行时保证；
 * - graph/run、session/query：协议无对应入参类型（query 为 starter 分页
 *   面、run 入参属地未收编协议）——锚生成形自身字段在场；
 * - automation/save 的 schedule：DTO 内手工镜像的 ScheduleConfig 判别联合
 *   OpenAPI 形 ↔ @tianshu/core 类型双向可赋值（终审 F2——zod runtime
 *   schema 无法直出 Swagger 管线，手工镜像靠 witness 封漂移）。
 *
 * **JSON 层（运行时）**：openapi.json 路径表覆盖协议 ENDPOINTS 全部
 * 无头端端点（ui/* 与 image 为桌面被控端专属，排除）；核心端点
 * requestBody schema 解析出 properties 须含手写契约字段名清单；关键
 * requiredness（BridgeToolResultDto 仅 ok 必填——output/error 为
 * ValidateIf 条件字段）。
 *
 * **响应面（SK-R 批 2026-10-27 + 补齐批）**：71 段经 @ApiWrappedOk/Accepted
 * 标注 wrapper schema（{code,success,data,message}，data=$ref 响应 class
 * 或 inline）——核心编排域 40 + assistant/skills/library/permission 31
 * （assistant detail/save/delete/marketList/marketDetail 与 skills
 * setScenarios/uninstall 为桌面被控面专属，本仓不实现）；其余域渐进
 * 补标。响应 wire 形状仍由 mirror E2E 双重守护。
 *
 * **产物缺失**：openapi.json / sdk/api-types.d.ts 任一缺失即
 * describe.skip（提示先 npm run sdk:generate）；类型层 import 经
 * tsconfig paths `#sdk/api-types` 回退 test/support/sdk-types-fallback.d.ts
 * 桩保编译（桩形 any——skip 门禁封死其以 any 形静默放行断言的可能）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ENDPOINTS,
  type ApproveParams,
  type BridgeToolResult,
  type ChatSendParams,
  type SessionCompactParams,
  type SessionPolishParams,
} from '@tianshu/protocol';
import type { ScheduleConfig } from '@tianshu/core';
import type { components as GeneratedComponents } from '#sdk/api-types';

/* ── 类型层 witness（编译期；export 规避 no-unused-vars）── */

type ExpectTrue<T extends true> = T;
/** 字段存在性（K 为联合时分发：全部在场才 true） */
type FieldsPresent<T, K extends string> = K extends keyof T ? true : false;

type Schemas = GeneratedComponents['schemas'];

// session/approve ↔ ApproveParams：双向可赋值（协议形与生成形全等面）。
// 方向断言一律元组包裹（[X] extends [Y]）——防 any 桩（编译兜底）触发
// 条件类型 any 特例（any extends T 产 boolean 误红/误绿）
export type ApproveProtocolAssignableToGenerated = ExpectTrue<
  [ApproveParams] extends [Schemas['SessionApproveDto']] ? true : false
>;
export type ApproveGeneratedAssignableToProtocol = ExpectTrue<
  [Schemas['SessionApproveDto']] extends [ApproveParams] ? true : false
>;

// session/send ↔ ChatSendParams：双向可赋值（额外字段均可选，见头注释）。// images 不参与比对——wire DTO 为 string[]（数据根相对路径，FA-T1），
// ChatSendParams.images 为 ChatSendImage[]（absPath，mirror IPC 内部形态），
// 两形态在被控面桥（server-face routes.ts）做 string[]→{absPath} 转换——
// 属既有 FA 分歧，非本契约面
type SendComparableWire = Omit<ChatSendParams, 'images'>;
type SendComparableDto = Omit<Schemas['SessionSendDto'], 'images'>;
export type SendProtocolAssignableToGenerated = ExpectTrue<
  [SendComparableWire] extends [SendComparableDto] ? true : false
>;
export type SendGeneratedAssignableToProtocol = ExpectTrue<
  [SendComparableDto] extends [SendComparableWire] ? true : false
>;

// A9 会话内工具批：session/compact ↔ SessionCompactParams 双向可赋值；
// session/polish 协议→生成单向（wire DTO style 缺省回退 professional，
// 协议形必填——控制端契约），workspaceId 双端可选
export type CompactProtocolAssignableToGenerated = ExpectTrue<
  [SessionCompactParams] extends [Schemas['SessionCompactDto']] ? true : false
>;
export type CompactGeneratedAssignableToProtocol = ExpectTrue<
  [Schemas['SessionCompactDto']] extends [SessionCompactParams] ? true : false
>;
export type PolishProtocolAssignableToGenerated = ExpectTrue<
  [SessionPolishParams] extends [Schemas['SessionPolishDto']] ? true : false
>;
export type PolishFieldsPresent = ExpectTrue<
  FieldsPresent<Schemas['SessionPolishDto'], 'workspaceId' | 'text' | 'style'>
>;

// tool/respond 的 result ↔ BridgeToolResult：协议→生成单向（判别联合的
// schema 超集方向）+ 协议字段在场
export type BridgeResultProtocolAssignableToGenerated = ExpectTrue<
  [BridgeToolResult] extends [Schemas['BridgeToolResultDto']] ? true : false
>;
export type BridgeResultFieldsPresent = ExpectTrue<
  FieldsPresent<Schemas['BridgeToolResultDto'], 'ok' | 'output' | 'error'>
>;
export type ToolRespondRequestIdIsString = ExpectTrue<
  [string] extends [Schemas['ToolRespondDto']['requestId']] ? true : false
>;

// graph/run：协议无 run 入参类型——锚生成形自身（graphId: number、
// inputs 为字符串值对象、workspaceId 可选 number）
export type GraphRunGraphIdIsNumber = ExpectTrue<
  [number] extends [Schemas['GraphRunDto']['graphId']] ? true : false
>;
export type GraphRunInputsIsStringRecord = ExpectTrue<
  [Record<string, string>] extends [
    NonNullable<Schemas['GraphRunDto']['inputs']>,
  ]
    ? true
    : false
>;
export type GraphRunWorkspaceIdOptionalNumber = ExpectTrue<
  [number | undefined] extends [Schemas['GraphRunDto']['workspaceId']]
    ? true
    : false
>;

// session/query：starter 分页面——锚生成形字段在场（A11 批增 activityAfter
// 时间筛选）
export type SessionQueryFieldsPresent = ExpectTrue<
  FieldsPresent<
    Schemas['SessionQueryDto'],
    | 'page'
    | 'pageSize'
    | 'workspaceId'
    | 'keyword'
    | 'archived'
    | 'activityAfter'
  >
>;

// automation/save 的 schedule：wire 真实形态为必填对象（终审 F2 裁定，
// repo buildTaskData 保存期 zod 深校验）——DTO 内手工镜像的 ScheduleConfig
// 判别联合 OpenAPI 形 ↔ @tianshu/core 类型双向可赋值，防手工镜像漂移
export type ScheduleProtocolAssignableToGenerated = ExpectTrue<
  [ScheduleConfig] extends [Schemas['AutomationSaveDto']['schedule']]
    ? true
    : false
>;
export type ScheduleGeneratedAssignableToProtocol = ExpectTrue<
  [Schemas['AutomationSaveDto']['schedule']] extends [ScheduleConfig]
    ? true
    : false
>;

/* ── JSON 层 witness（运行时，openapi.json 解析）── */

const rootDir = path.join(__dirname, '..');
const openapiPath = path.join(rootDir, 'openapi.json');
const apiTypesPath = path.join(rootDir, 'sdk', 'api-types.d.ts');

const missingArtifacts = [
  !fs.existsSync(openapiPath) && 'openapi.json（npm run sdk:export）',
  !fs.existsSync(apiTypesPath) && 'sdk/api-types.d.ts（npm run sdk:generate）',
].filter((hint): hint is string => Boolean(hint));

const describeSdk = missingArtifacts.length === 0 ? describe : describe.skip;
if (missingArtifacts.length > 0) {
  console.warn(
    `[sdk-contract] SKIP：缺失 ${missingArtifacts.join('、')}——先 npm run sdk:generate 生成 SDK 产物`,
  );
}

type OpenApiSchemaRef = {
  $ref?: string;
  allOf?: OpenApiSchemaRef[];
  properties?: Record<string, OpenApiSchemaRef>;
  required?: string[];
};
type OpenApiOperation = {
  requestBody?: {
    content?: Record<string, { schema?: OpenApiSchemaRef }>;
  };
  /** SK-R 批：响应面断言消费（wrapper schema 形） */
  responses?: Record<
    string,
    { content?: Record<string, { schema?: OpenApiSchemaRef }> }
  >;
};
type OpenApiDocument = {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: { schemas: Record<string, OpenApiSchemaRef> };
};

/** 逻辑端点（无前导斜杠、:param）→ openapi 路径（/ 前缀、{param}） */
const toOpenApiPath = (logical: string) =>
  `/${logical.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`;

const derefSchema = (
  openapi: OpenApiDocument,
  schema: OpenApiSchemaRef,
): OpenApiSchemaRef => {
  if (schema.$ref) {
    const schemaName = schema.$ref.split('/').pop() as string;
    return openapi.components.schemas[schemaName] ?? {};
  }
  return schema;
};

/** $ref/allOf 展平后的 properties 合并视图（result 嵌套引用用） */
const mergedProperties = (
  openapi: OpenApiDocument,
  schema: OpenApiSchemaRef,
): Record<string, OpenApiSchemaRef> => {
  const target = derefSchema(openapi, schema);
  const properties: Record<string, OpenApiSchemaRef> = {
    ...(target.properties ?? {}),
  };
  for (const sub of target.allOf ?? []) {
    Object.assign(properties, mergedProperties(openapi, sub));
  }
  return properties;
};

/** 协议 ENDPOINTS 无头端面（ui/* 与 image 为桌面被控端专属——本仓不实现） */
const headlessEndpointExpectations = [
  { logical: ENDPOINTS.info, method: 'get' as const },
  ...Object.values(ENDPOINTS.session).map((logical) => ({
    logical,
    method: 'post' as const,
  })),
  ...Object.values(ENDPOINTS.provider).map((logical) => ({
    logical,
    method: 'post' as const,
  })),
  ...Object.values(ENDPOINTS.graph).map((logical) => ({
    logical,
    method: 'post' as const,
  })),
  ...Object.values(ENDPOINTS.automation).map((logical) => ({
    logical,
    method: 'post' as const,
  })),
  { logical: ENDPOINTS.tool.respond, method: 'post' as const },
  { logical: ENDPOINTS.webhook.trigger, method: 'post' as const },
  { logical: ENDPOINTS.webhook.jobStatus, method: 'get' as const },
  // MO 批（2026-10-27）：monitor/stats 只读聚合面（monitor 组不在自动覆盖组）
  { logical: ENDPOINTS.monitor.stats, method: 'post' as const },
  // WH 批（2026-10-27）：webhook 管理三段（enable/disable/status——逻辑
  // 路径 graph/webhook/*，业务语义受 TIANSHU_TOKEN 守卫，非触发面豁免段）
  ...(['enable', 'disable', 'status'] as const).map((key) => ({
    logical: ENDPOINTS.webhook[key],
    method: 'post' as const,
  })),
  // A8 工作空间批：workspace 不在自动覆盖组（仅 session/provider/graph/
  // automation+tool/webhook）——四段显式入册
  { logical: ENDPOINTS.workspace.query, method: 'post' as const },
  { logical: ENDPOINTS.workspace.create, method: 'post' as const },
  { logical: ENDPOINTS.workspace.update, method: 'post' as const },
  { logical: ENDPOINTS.workspace.delete, method: 'post' as const },
  // A10 审批记忆批：permission 不在自动覆盖组——五段显式入册（remembered
  // 表读删 + full 运行态 list/clear）
  ...Object.values(ENDPOINTS.permission).map((logical) => ({
    logical,
    method: 'post' as const,
  })),
  // A2 尾/A3 尾：assistant/skills 不在自动覆盖组——export/import 与
  // installUpload/stats 显式入册（技能市场 skillhub 为桌面被控面专属，
  // 本仓不实现——与既有 skillhub 段不在表一致）；SK-R 补齐批补登历史
  // 缺口四段（assistant/query、skills/query|read|setEnabled——本仓实际
  // 实现的地段，早于尾批落地面未随批入册）
  { logical: ENDPOINTS.assistant.query, method: 'post' as const },
  { logical: ENDPOINTS.assistant.export, method: 'post' as const },
  { logical: ENDPOINTS.assistant.import, method: 'post' as const },
  { logical: ENDPOINTS.skills.query, method: 'post' as const },
  { logical: ENDPOINTS.skills.read, method: 'post' as const },
  { logical: ENDPOINTS.skills.setEnabled, method: 'post' as const },
  { logical: ENDPOINTS.skills.installUpload, method: 'post' as const },
  { logical: ENDPOINTS.skills.stats, method: 'post' as const },
  // library 批（spec 2026-10-26）：library 不在自动覆盖组——十八段显式入册
  // （list/tree/search/listRecent/listFavorites/createFolder/createFile/
  //  addLink/rename/move/delete/subtreeCount/toggleFavorite/markViewed/
  //  read/readImage/writeContent/uploadFile）
  ...Object.values(ENDPOINTS.library).map((logical) => ({
    logical,
    method: 'post' as const,
  })),
];

/** 核心端点请求字段清单（send/approve 取协议类型共同面；query/run 协议
 * 无对应入参类型——取 DTO 单源字段，限界见头注释与任务报告） */
const coreRequestFieldExpectations = [
  {
    path: '/session/query',
    schemaName: 'SessionQueryDto',
    fields: [
      'page',
      'pageSize',
      'workspaceId',
      'keyword',
      'archived',
      'activityAfter',
    ],
  },
  {
    path: '/session/send',
    schemaName: 'SessionSendDto',
    fields: ['sessionId', 'content', 'modelId'],
  },
  {
    path: '/session/approve',
    schemaName: 'SessionApproveDto',
    fields: ['sessionId', 'toolCallId', 'approved'],
  },
  {
    // P1 未读角标批：已读上报入参（单调推进不回退）
    path: '/session/read',
    schemaName: 'SessionReadDto',
    fields: ['sessionId', 'messageId'],
  },
  {
    // A9 会话内工具批：compact {sessionId} / polish {workspaceId?,text,style}
    path: '/session/compact',
    schemaName: 'SessionCompactDto',
    fields: ['sessionId'],
  },
  {
    path: '/session/polish',
    schemaName: 'SessionPolishDto',
    fields: ['workspaceId', 'text', 'style'],
  },
  {
    path: '/graph/run',
    schemaName: 'GraphRunDto',
    fields: ['graphId', 'inputs', 'workspaceId'],
  },
  {
    path: '/automation/save',
    schemaName: 'AutomationSaveDto',
    fields: ['name', 'schedule', 'scheduleText', 'missedPolicy'],
  },
  {
    path: '/tool/respond',
    schemaName: 'ToolRespondDto',
    fields: ['requestId', 'result'],
  },
  // A8 工作空间写面：save 载荷四字段（id update 用）+ delete 按 id
  {
    path: '/workspace/create',
    schemaName: 'WorkspaceSaveDto',
    fields: ['id', 'name', 'icon', 'defaultModelId'],
  },
  {
    path: '/workspace/update',
    schemaName: 'WorkspaceSaveDto',
    fields: ['id', 'name', 'icon', 'defaultModelId'],
  },
  {
    path: '/workspace/delete',
    schemaName: 'WorkspaceIdDto',
    fields: ['id'],
  },
  // A10 审批记忆批：单条撤销按 id（list/revokeAll 无入参面）
  {
    path: '/permission/revokeRemembered',
    schemaName: 'PermissionRevokeRememberedDto',
    fields: ['id'],
  },
  // A2 尾专家导入导出：export {id} / import {json} 内容面
  {
    path: '/assistant/export',
    schemaName: 'AssistantExportDto',
    fields: ['id'],
  },
  {
    path: '/assistant/import',
    schemaName: 'AssistantImportDto',
    fields: ['json'],
  },
  // A3 尾技能 zip 上传/统计：installUpload {name, base64}（stats 无入参面）
  {
    path: '/skills/installUpload',
    schemaName: 'SkillInstallUploadDto',
    fields: ['name', 'base64'],
  },
  // library 批：核心请求面（list/tree/listRecent/listFavorites 无入参面；
  // createFolder/createFile 同 DTO 形状 {name,parentId}）
  {
    path: '/library/search',
    schemaName: 'LibrarySearchDto',
    fields: ['keyword'],
  },
  {
    path: '/library/createFolder',
    schemaName: 'LibraryCreateDto',
    fields: ['name', 'parentId'],
  },
  {
    path: '/library/addLink',
    schemaName: 'LibraryAddLinkDto',
    fields: ['url', 'title', 'parentId'],
  },
  {
    path: '/library/rename',
    schemaName: 'LibraryRenameDto',
    fields: ['id', 'name'],
  },
  {
    path: '/library/move',
    schemaName: 'LibraryMoveDto',
    fields: ['ids', 'targetParentId'],
  },
  {
    path: '/library/delete',
    schemaName: 'LibraryDeleteDto',
    fields: ['ids'],
  },
  {
    path: '/library/subtreeCount',
    schemaName: 'LibraryIdDto',
    fields: ['id'],
  },
  {
    path: '/library/writeContent',
    schemaName: 'LibraryWriteContentDto',
    fields: ['id', 'content'],
  },
  // library 上传批：uploadFile {name, base64} 必填（parentId 可空）
  {
    path: '/library/uploadFile',
    schemaName: 'LibraryUploadFileDto',
    fields: ['name', 'base64', 'parentId'],
  },
];

describeSdk('SDK 生成契约 ↔ @tianshu/protocol 手写契约（SK-2）', () => {
  let openapi: OpenApiDocument;

  beforeAll(() => {
    openapi = JSON.parse(
      fs.readFileSync(openapiPath, 'utf8'),
    ) as OpenApiDocument;
  });

  describe('端点覆盖：协议 ENDPOINTS 无头端面全量入册', () => {
    it.each(headlessEndpointExpectations)(
      '$method $logical 在路径表',
      ({ logical, method }) => {
        expect(openapi.paths[toOpenApiPath(logical)]?.[method]).toBeDefined();
      },
    );

    it('桌面被控端专属端点（image、ui/*）不在本仓 openapi 面', () => {
      expect(openapi.paths['/image']).toBeUndefined();
      expect(openapi.paths['/ui/openSession']).toBeUndefined();
      expect(openapi.paths['/ui/notify']).toBeUndefined();
      expect(openapi.paths['/ui/openRoute']).toBeUndefined();
    });
  });

  describe('核心端点请求面：字段存在 + requiredness', () => {
    it.each(coreRequestFieldExpectations)(
      '$path：requestBody $ref 解析含字段清单',
      ({ path, schemaName, fields }) => {
        const operation = openapi.paths[path]?.post;
        const bodySchema =
          operation?.requestBody?.content?.['application/json']?.schema;
        expect(bodySchema?.$ref).toBe(`#/components/schemas/${schemaName}`);
        expect(
          Object.keys(mergedProperties(openapi, bodySchema ?? {})),
        ).toEqual(expect.arrayContaining(fields));
      },
    );

    it('/tool/respond result 载荷：BridgeToolResultDto 含协议 BridgeToolResult 字段清单', () => {
      const toolRespond = openapi.components.schemas['ToolRespondDto'];
      const resultProperties = mergedProperties(
        openapi,
        toolRespond.properties?.result ?? {},
      );
      expect(Object.keys(resultProperties)).toEqual(
        expect.arrayContaining(['ok', 'output', 'error']),
      );
    });

    it('requiredness：send 必填 sessionId/content；approve 三字段全必填；bridge 仅 ok（output/error 为 ValidateIf 条件字段）', () => {
      const send = openapi.components.schemas['SessionSendDto'];
      expect(send.required).toHaveLength(2);
      expect(send.required).toEqual(
        expect.arrayContaining(['sessionId', 'content']),
      );

      const approve = openapi.components.schemas['SessionApproveDto'];
      expect(approve.required).toEqual(
        expect.arrayContaining(['sessionId', 'toolCallId', 'approved']),
      );

      const bridge = openapi.components.schemas['BridgeToolResultDto'];
      expect(bridge.required).toContain('ok');
      expect(bridge.required).not.toContain('output');
      expect(bridge.required).not.toContain('error');

      // automation/save 的 schedule：wire 真实形态为必填对象（终审 F2
      // 裁定非可选——class-validator @IsObject 无 @IsOptional 同款）
      const automationSave = openapi.components.schemas['AutomationSaveDto'];
      expect(automationSave.required).toContain('schedule');
    });

    it('响应 schema 齐：核心编排域 40 + assistant/skills/library/permission 31 = 71 段（wrapper {code,success,data,message} + data $ref/inline）', () => {
      // 71 段 = 核心编排域 40（session 15 + provider 5 + graph 5 +
      // automation 4 + webhook 管理 3 + workspace 4 + files 3 + tool 1）+
      // 其余天枢域 31（assistant 3——detail/save/delete/marketList/
      // marketDetail 为桌面被控面专属本仓不实现，仅 query/export/import；
      // skills 5——setScenarios/uninstall 同前；library 18；permission 5）；
      // starter 面（user/auth/operationlog/actuator）以实际响应为准留档
      const expected: Array<[string, string]> = [
        ...(
          ['session/create', 'session/query', 'session/getById'] as const
        ).map((e) => [e, '200'] as [string, string]),
        ['session/send', '202'],
        ['session/abort', '200'],
        ['session/approve', '200'],
        ['session/delete', '200'],
        ['session/update', '200'],
        ['session/editAndResend', '202'],
        ['session/usage', '200'],
        ['session/accessMode', '200'],
        ['session/regenerate', '202'],
        ['session/read', '200'],
        ['session/compact', '202'],
        ['session/polish', '200'],
        ['provider/query', '200'],
        ['provider/save', '200'],
        ['provider/delete', '200'],
        ['provider/test', '200'],
        ['provider/fetchModels', '200'],
        ['graph/query', '200'],
        ['graph/save', '200'],
        ['graph/delete', '200'],
        ['graph/run', '202'],
        ['graph/runAbort', '200'],
        ['automation/query', '200'],
        ['automation/save', '200'],
        ['automation/delete', '200'],
        ['automation/runNow', '202'],
        ['graph/webhook/enable', '200'],
        ['graph/webhook/disable', '200'],
        ['graph/webhook/status', '200'],
        ['workspace/query', '200'],
        ['workspace/create', '200'],
        ['workspace/update', '200'],
        ['workspace/delete', '200'],
        ['files/list', '200'],
        ['files/read', '200'],
        ['files/uploadImage', '200'],
        ['tool/respond', '200'],
        // ── SDK 响应面补齐批（2026-10-27 其余天枢域）──
        ['assistant/query', '200'],
        ['assistant/export', '200'],
        ['assistant/import', '200'],
        ['skills/query', '200'],
        ['skills/read', '200'],
        ['skills/setEnabled', '200'],
        ['skills/installUpload', '200'],
        ['skills/stats', '200'],
        // library 十八段（端点名 = 协议 ENDPOINTS.library 值）
        ...Object.values(ENDPOINTS.library).map(
          (e) => [e, '200'] as [string, string],
        ),
        ['permission/listRemembered', '200'],
        ['permission/revokeRemembered', '200'],
        ['permission/revokeAllRemembered', '200'],
        ['permission/listFullGrants', '200'],
        ['permission/revokeAllFull', '200'],
      ];
      expect(expected).toHaveLength(71);
      for (const [logical, status] of expected) {
        const op = openapi.paths['/' + logical]?.post;
        expect(op).toBeTruthy();
        const schema = op?.responses?.[status]?.content?.['application/json']
          ?.schema as
          | {
              properties: Record<string, unknown>;
            }
          | undefined;
        expect(schema).toBeTruthy();
        expect(Object.keys(schema!.properties)).toEqual(
          expect.arrayContaining(['code', 'success', 'data', 'message']),
        );
      }
    });

    it('library 批 requiredness：单 id 端点仅 id 必填；createFolder 仅 name 必填（parentId 可空）', () => {
      const idDto = openapi.components.schemas['LibraryIdDto'];
      expect(idDto.required).toEqual(['id']);

      const createDto = openapi.components.schemas['LibraryCreateDto'];
      expect(createDto.required).toEqual(['name']);
      expect(createDto.required).not.toContain('parentId');

      // 上传批：uploadFile 仅 name/base64 必填（parentId 可空）
      const uploadDto = openapi.components.schemas['LibraryUploadFileDto'];
      expect(uploadDto.required).toEqual(['name', 'base64']);
      expect(uploadDto.required).not.toContain('parentId');
    });
  });
});
