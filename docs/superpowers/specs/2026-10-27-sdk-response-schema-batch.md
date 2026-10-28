# SDK 响应面补齐批（openapi 响应 schema 注入管线）设计 spec

日期：2026-10-27
状态：直接开工（用户「继续推进」滚动授权；SK 终审 F2「响应面待渐进补齐」之兑现）
关联：SDK 批（2026-10-18 sdk-design）；WH/EB 批（webhook 管理/事件总线，本日）

## 0. 事实基线

- **缺口**：86 个 POST 端点 0 处 `@ApiOkResponse`——openapi.json 响应无 content schema，openapi-typescript 生成 `paths` 侧响应 unknown；外部 SDK 消费者（README SDK 段三行接入）只拿到请求面类型。限界清单（SK 终审 F2 入册，README:137-139）挂账。
- **响应包装**：`ResponseInterceptor` 统一 `{code:'2000', success:true, data, message:'success'}`（excludePaths 豁免的 actuator/webhook 触发面不走包装——webhook/:token 直发不在本批范围）。
- **协议类型覆盖不均**：graph-contract 已有 `GraphRecord`/`TaskRecord`；session/provider/workspace 响应类型**不在协议包**（server 侧 SessionRecord 为 prisma 生成类型，协议包不能依赖 prisma——须按 wire 口径手写上提，Date→ISO string 是协议包既定纪律）。
- **管线现状**：`sdk:generate` = `sdk:export`（build→dist 离线导出 openapi.json）→ `openapi-typescript` 生成 `sdk/api-types.d.ts`；pretest mtime 门禁防陈旧产物。
- **既有断言面**：`sdk-contract.spec.ts` `headlessEndpointExpectations` 已全量登记无头端端点表（86 段）——响应面断言可搭此表防漏（表内端点无响应 schema 即红）。
- **手写 DTO class 路线否决理由**：86 class 与 service 返回类型间无编译期绑定（假契约必漂），witness 绑定维护成本 > 生成路线。

## 1. 本批裁定（方案：装饰器直标 + wrapper 装饰器；生成器注入路线否决）

> 方案修正记录：spec 初稿为「协议类型上提 + ts-json-schema-generator 生成注入」，盘实后发现 session 域已有带 `@ApiProperty` 的响应 class（SessionDetailDto/MessageBriefDto）、provider 域 ProviderBundleDto 齐——直标路线边际成本大降且避免「协议包新类型 ↔ server 已有 DTO class」双源；生成器路线否决（额外 devDep + 生成边角风险 + session 域重复建源）。

1. **wrapper 装饰器**：`src/commons/swagger/` 增 `@ApiWrappedOk(dataType)`（applyDecorators 封装 @ApiOkResponse——schema 为 `{code:'2000',success:true,data:{$ref},message:'success'}`，与 ResponseInterceptor 包装逐字段同形）与 `@ApiWrappedAccepted(dataType)`（202 语义：session/send、automation/runNow、session/compact 回 `{accepted:true}` 或小形状）；`QueryResult<T>` 泛型经 `apiQueryResultOf(ItemDto)` helper（ApiExtraModel + getSchemaPath 官方泛型模式）产 schema。
2. **响应 class 补齐**（缺的域新建，@ApiProperty 全标，形状以 service 返回 interface 逐字段核准）：`GraphRecordDto`/`TaskRecordDto`（GraphRecord/TaskRecord interface 对齐）、`SessionWireDto`（prisma SessionRecord 的 wire 形状，Date→ISO string——session-detail 引的 prisma 类型在 openapi 退化，须显式 class）、`WorkspaceDto`（WorkspaceBrief）、`FileEntryDto`/`FileContentDto`、`WebhookManageDto`（WebhookManageResult）；{runId}/{aborted}/{accepted} 小形状 inline schema 不建 class。
3. **controller 标注 40 段**：session 15 / provider 5 / graph 5 / automation 4 / webhook 3 / workspace 4 / files 3 / tool 1（webhook/:token 触发面 @Res 直发不包装不标）。其余 46 段（assistant/skills/skillhub/mcp/library/monitor/permission/project/user/auth/operationlog）留档渐进——机制成立后补标零成本。
4. **witness 绑定**：`test/sdk-response-witness.ts`——响应 class ↔ service/repository 实际返回类型双向可赋值性断言（编译期，ts-jest 全量类型检查生效；先例：protocol-package 老路径 witness）。
5. **sdk-contract 断言扩展**：headlessEndpointExpectations 表内核心 40 段断言 openapi paths 对应 status 有 content schema 且 data 为 $ref/inline 形（未登记域无 schema 不报错——渐进面）。
6. **产物与文档**：sdk:generate 重生；README 限界清单更新（响应面覆盖核心编排域 40 段 + 渐进计划）。

## 2. 测试与验收

- sdk-contract：响应面断言 40 段全绿；既有 96 用例零红。
- witness 编译期绑定进 jest（ts-jest 全量类型检查自然生效）+ 根 typecheck。
- 手动冒烟：sdk:generate 后 openapi.json 抽查 session/query 响应 schema 形状（Swagger UI /api-docs 可见响应模型）。
- pretest 新鲜度门禁不回归（标注变化经 build 反映进 dist，export 重导）。

## 3. 非目标（留档）

- 其余 46 段响应标注（后续批按域补）。
- webhook/:token 外部触发面（@Res 直发非包装，模型语义本就非 SDK 面）。
- GET /event SSE 流式响应 schema（流式非 openapi 面）。
- mirror face / mobile 的响应类型消费（各自响应形状独立，不在本批接线）。

## 4. 风险

- SessionRecord prisma 类型含 null 宇宙（Date|null 等）——SessionWireDto 核准时逐字段对齐实际序列化输出（E2E 断言已有响应体用例可对照）。
- QueryResult 泛型在 openapi-typescript 生成端的展开形态（$ref 数组）需抽查。
- 漏标防漏：核心域 40 段人工对照 ENDPOINTS 分组清点；后续域补标时同批清点。
