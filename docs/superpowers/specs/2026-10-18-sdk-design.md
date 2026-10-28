# 天枢服务端二期：Swagger→SDK 设计

- 日期：2026-10-18
- 状态：待用户确认（小项，精简流程）
- 前置：starter Swagger（/api-docs）；`@tianshu/protocol` 手写契约为内部 source of truth

## 1. 目标与非目标

**目标**：tianshu-server 对外提供机器可消费的 SDK 面——OpenAPI JSON 导出 + `openapi-typescript` 类型生成管线 + 生成类型与手写契约的**兼容性契约测试**（防两端漂移）+ 外部消费文档。

**非目标**：mirror 内部改用生成类型（手写 `@tianshu/protocol` 仍是内部单份源——生成类型只服务外部消费与漂移检测）；全代码 SDK（openapi-generator 服务端/客户端代码生成——过度）；发布 npm 包（file:消费已覆盖）。

## 2. 方案

### 2.1 导出管线（server）

- `scripts/export-openapi.mjs`：加载编译后的 AppModule（`dist/src/app.module.js`），NestFactory 创建不监听端口的 app，复用 main.ts 的 DocumentBuilder 配置（抽公共函数 `buildOpenApiDocument(app)` 供 main.ts 与脚本共用——避免双写），写 `openapi.json`（gitignore，产物按需生成）
- npm scripts：`sdk:export`（build+export）、`sdk:generate`（export+openapi-typescript 生成 `sdk/api-types.d.ts`，工具链 devDep `openapi-typescript`）

### 2.2 契约测试（server）

`test/sdk-contract.spec.ts`：对生成的 openapi.json（或生成类型）与 `@tianshu/protocol` 手写契约做形状兼容断言——抽核心端点（session/query、session/send、graph/run、tool/respond）的请求/响应 schema 与手写类型的编译期可赋值性（类型层 witness）+ JSON 层关键字段存在性。openapi.json 缺失时 SKIP（本地生成后跑）。

### 2.3 文档

server README「SDK」节：Swagger UI 调试（Bearer）+ 外部三行消费示例（`npx openapi-typescript ./openapi.json -o api.d.ts` + openapi-fetch/Bearer）+ `sdk:export/generate` 说明。

## 3. 假设

1. openapi.json 不入库（gitignore——随版本可重生；导出确定性由代码保证）
2. DTO 装饰器完备性决定 schema 质量——不完备处在契约测试暴露后逐个补 `@ApiProperty`（渐进，不一次全量）
