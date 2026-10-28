/**
 * 包装响应装饰器（SK-R 批 2026-10-27）：openapi 响应 schema 与
 * ResponseInterceptor 统一包装 `{code:'2000',success:true,data,message:
 * 'success'}` 逐字段同形——@ApiOkResponse({type}) 直标描述的是未包装
 * 体（与实际 wire 不符），本装饰器把 data 段（$ref 响应 class 或 inline
 * schema）包进 wrapper 形。202 受理语义（session/send 等异步受理）用
 * ApiWrappedAccepted。
 *
 * $ref 生效前提：响应 class 须注册进 components.schemas——响应 class
 * 一律加 @ApiExtraModel(XxxDto)（本文件不代劳，类级装饰器无法在方法级
 * 装饰器内施加）。QueryResult<T> 泛型经 queryResultSchema(ItemDto) 展开
 * （records 数组 items $ref）。
 */
import { applyDecorators, Type } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiOkResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import type { ReferenceObject, SchemaObject } from '@nestjs/swagger';

/** data 段输入：响应 class（$ref）或 inline JSON Schema */
export type DataSchemaInput = Type<unknown> | SchemaObject;

/** data 段形态：inline schema 或 $ref 引用（$ref 不在 SchemaObject——
 * OpenAPI 的 $ref 是 ReferenceObject，union 承载） */
type DataSchema = SchemaObject | ReferenceObject;

function dataSchemaOf(input?: DataSchemaInput): DataSchema {
  if (!input) {
    return { nullable: true, description: '无返回体（void）' };
  }
  return typeof input === 'function' ? { $ref: getSchemaPath(input) } : input;
}

function wrapperSchema(data: DataSchema): SchemaObject {
  return {
    type: 'object',
    properties: {
      code: { type: 'string', example: '2000' },
      success: { type: 'boolean', example: true },
      data,
      message: { type: 'string', example: 'success' },
    },
  };
}

/** 200 包装响应（data = $ref 响应 class 或 inline schema；缺省 void） */
export function ApiWrappedOk(data?: DataSchemaInput): MethodDecorator {
  return applyDecorators(
    ApiOkResponse({ schema: wrapperSchema(dataSchemaOf(data)) }),
  );
}

/** 202 受理包装响应（异步受理语义：session/send、graph/run 等） */
export function ApiWrappedAccepted(data?: DataSchemaInput): MethodDecorator {
  return applyDecorators(
    ApiAcceptedResponse({ schema: wrapperSchema(dataSchemaOf(data)) }),
  );
}

/** QueryResult<T> 展开为 inline schema（records.items = $ref ItemDto） */
export function queryResultSchema(item: Type<unknown>): SchemaObject {
  return {
    type: 'object',
    properties: {
      page: { type: 'number' },
      pageSize: { type: 'number' },
      records: {
        type: 'array',
        items: { $ref: getSchemaPath(item) },
      },
      total: { type: 'number' },
    },
  };
}

/** skills/installUpload：installed（含 record）/ conflict（含 name）判别
 * 联合（协议 SkillInstallResultDto 同形——OpenAPI 3.0 以 oneOf 展开；
 * 独立 const + 显式 SchemaObject 标注，防字面量推断并形破坏 satisfies） */
const skillInstallSchema: SchemaObject = {
  oneOf: [
    {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['installed'] },
        record: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            name: { type: 'string' },
            source: { type: 'string' },
            slug: { type: 'string', nullable: true },
            version: { type: 'string', nullable: true },
          },
          required: ['id', 'name', 'source'],
        },
      },
      required: ['status', 'record'],
    },
    {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['conflict'] },
        name: { type: 'string' },
      },
      required: ['status', 'name'],
    },
  ],
};

/** 常用小形状 inline schema（不值得建 class 的固定小返回体） */
export const inlineSchemas = {
  accepted: {
    type: 'object',
    properties: { accepted: { type: 'boolean', example: true } },
    required: ['accepted'],
  },
  aborted: {
    type: 'object',
    properties: { aborted: { type: 'boolean', example: true } },
    required: ['aborted'],
  },
  runId: {
    type: 'object',
    properties: { runId: { type: 'number' } },
    required: ['runId'],
  },
  responded: {
    type: 'object',
    properties: {
      responded: { type: 'boolean', example: true },
      remembered: { type: 'boolean', example: false },
    },
    required: ['responded'],
  },
  accessMode: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['default', 'full'] },
    },
    required: ['mode'],
  },
  polishText: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  providerTest: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      message: { type: 'string' },
    },
    required: ['ok', 'message'],
  },
  sessionUsage: {
    type: 'object',
    nullable: true,
    properties: {
      system: { type: 'number' },
      tools: { type: 'number' },
      messages: { type: 'number' },
      mcp: { type: 'number' },
      skills: { type: 'number' },
      total: { type: 'number' },
      contextWindow: { type: 'number', nullable: true },
    },
  },
  sessionRead: {
    type: 'object',
    properties: {
      sessionId: { type: 'number' },
      lastReadMessageId: { type: 'number' },
      unreadCount: { type: 'number' },
    },
    required: ['sessionId', 'lastReadMessageId', 'unreadCount'],
  },
  providerFetchModels: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      errorCode: { type: 'string' },
      message: { type: 'string' },
      models: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            modelId: { type: 'string' },
            name: { type: 'string' },
          },
          required: ['modelId'],
        },
      },
    },
    required: ['success', 'message', 'models'],
  },
  stringArray: {
    type: 'array',
    items: { type: 'string' },
  },
  // ── SDK 响应面补齐批（2026-10-27 其余天枢域）：assistant/skills/
  //  library/permission 小返回体（协议 ExpertExportResult/ExpertImportResult/
  //  LibraryReadResult/LibraryReadImageResult/PermissionRevokeResult 同形）
  /** assistant/export：导出 JSON 文本 */
  jsonText: {
    type: 'object',
    properties: { json: { type: 'string' } },
    required: ['json'],
  },
  /** assistant/import：新建行 {id, name} */
  idName: {
    type: 'object',
    properties: {
      id: { type: 'number' },
      name: { type: 'string' },
    },
    required: ['id', 'name'],
  },
  /** skills/read：技能正文 */
  contentText: {
    type: 'object',
    properties: { content: { type: 'string' } },
    required: ['content'],
  },
  /** skills/installUpload：installed（含 record）/ conflict（含 name）
   * 判别联合（协议 SkillInstallResultDto 同形——见上方 skillInstallSchema） */
  skillInstall: skillInstallSchema,
  /** library/read：文本内容（kind 恒 'text'——二进制/超限走错误信封） */
  libraryRead: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['text'] },
      content: { type: 'string' },
    },
    required: ['kind', 'content'],
  },
  /** library/readImage：mime 白名单成员 + base64 */
  libraryReadImage: {
    type: 'object',
    properties: {
      mime: { type: 'string' },
      dataBase64: { type: 'string' },
    },
    required: ['mime', 'dataBase64'],
  },
  /** permission revokeAllRemembered/revokeAllFull：实际撤销条数 */
  revokedCount: {
    type: 'object',
    properties: { revoked: { type: 'number' } },
    required: ['revoked'],
  },
} satisfies Record<string, SchemaObject>;
