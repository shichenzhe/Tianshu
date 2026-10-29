# 枢 · shu-nestjs-starter

> 枢者，门轴也——门之开合，皆系于枢。一切服务端应用，由此开启。

开箱即用的 **NestJS + Fastify + Prisma** 服务端脚手架：登录认证、统一响应、
接口文档、监控指标、操作日志，一个模板全都有。与桌面端模板
[shu-electron-starter](../shu-electron-starter) 同源同规范，组成"枢"双件套。

## 特性

- **登录认证**：JWT 访问/刷新双令牌 + Basic 认证 + 角色守卫（`@Roles`）
- **统一 Web 层**：响应包装、业务异常 + 错误码、请求日志（trace_id 贯穿）、JSON 序列化拦截
- **接口文档**：Swagger UI 开箱即用（`/api-docs`），JWT/Bearer 调试直接可用
- **管理端点**：actuator 风格 `/actuator/health`（磁盘/内存检查）、`/actuator/prometheus`（Prometheus 抓取用，text/plain）与 `/actuator/metrics`（JSON 包裹的指标查看）
- **通用查询**：query-filter 声明式列表过滤（分页/关键字/字段过滤）
- **数据库**：Prisma + SQLite 默认（零依赖启动），附 PostgreSQL 切换支持
- **操作日志**：拦截器框架就绪（用户/IP/耗时/状态），源工程以开关方式禁用，按需开启
- **日志**：Winston 按日轮转，trace_id 关联请求
- **部署**：多阶段 Dockerfile、gzip 压缩

## 技术栈

NestJS 11 · Fastify 5 · TypeScript · Prisma + SQLite/PostgreSQL ·
class-validator · passport-jwt · Swagger · Winston · prom-client · Jest

## 快速开始

```bash
# 1. 用本模板创建仓库（GitHub "Use this template" 或）
npx degit <your-fork>/shu-nestjs-starter my-service
cd my-service

# 2. 安装依赖（package.json name 为占位符时的警告无害）
npm install

# 3. 初始化（应用名 / JWT 密钥 / 作者 / 仓库地址，可重复运行；
#    JWT 密钥自动生成并写入 .env——不入库）
npm run init

# 4. 建库并写入初始 admin 账号（admin / 123456）
npm run prisma:reset

# 5. 启动开发
npm run start:dev
```

启动后：

- Swagger 文档：http://localhost:3000/api-docs
- 健康检查：http://localhost:3000/actuator/health
- Prometheus 抓取端点（text/plain）：http://localhost:3000/actuator/prometheus
- 指标查看（JSON 包裹 prometheus 文本）：http://localhost:3000/actuator/metrics
- 登录：`POST /auth/login`（`{"username":"admin","password":"123456"}`）

**添加你的第一个业务模块** → [docs/guide.md](docs/guide.md)

## 天枢控制端协议与 E2E 冒烟

本仓在天枢桌面端（mirror 仓）之外提供「无头服务端」形态：桌面端控制台
（`/module/ai/server`）经控制协议遥控本服务。速览：

- **鉴权**：`TIANSHU_TOKEN` 环境变量设置时全局校验（`Authorization: Bearer <t>`
  或 SSE 的 `?token=` query）；未设置本地放行（开发态）
- **握手**：启动后 stdout 单行 `TIANSHU_HANDSHAKE {"port":..,"token":..,"instanceId":..}`
  （config.yml `tianshu.handshake` 可关）——桌面端 Supervisor 据此发现连接信息
- **事件流**：`GET /event`（SSE，首帧 `server.connected`；`message.chunk` /
  `session.updated` / `session.error`）。已以 `Cache-Control: no-transform`
  豁免压缩中间件——gzip 会缓冲小帧导致 SSE 首帧永不送达（回归测试
  `test/modules/event-stream.spec.ts`）
- **会话/模型端点**：`POST /session/{create,send,abort,delete,...}`（send 202
  受理，流经事件通道）、`POST /provider/{query,save}`；relay 接入见
  [README-relay.md](README-relay.md)（`TIANSHU_RELAY_URL`/`TIANSHU_RELAY_TOKEN`）
- **备份六端点**（桌面端全量备份，spec 2026-10-27）：`POST /backup/create`
  （登记建档，服务端生成 uuid 恒新档）/ `backup/{id}/chunk`（≤4MB 分块连续
  seq 追加，收块即验分块 sha256）/ `backup/{id}/commit`（整包 size+sha256
  双终验定稿 + 保留策略裁最旧——缺省留 10 档，option 表 `app/backupMaxKeep`
  可调）/ `backup/list` / `backup/{id}/download`（分块下载）/ `backup/{id}/delete`；
  整包上限 2GB，产物落备份根 `<id>/`（meta.json + data.tar.gz）。备份根经
  `TIANSHU_BACKUP_DIR` 外移（缺省 `<server 数据根>/backups`，容器卷映射示例：
  `-e TIANSHU_BACKUP_DIR=/data/backups -v /host/backups:/data/backups`）；
  二层鉴权 `TIANSHU_BACKUP_TOKEN` 最小权限——设置时备份端点只认它（日常
  远控 `TIANSHU_TOKEN` 泄漏不暴露整机备份面），未设回落仅全局 `TIANSHU_TOKEN`
- **备份多用户**（spec 2026-10-28）：备份面鉴权自成体系——第一层
  `StaticTokenGuard` 对 `${contextPath}/backup/` 前缀豁免，由 `BackupGuard`
  双身份自治（客户端注册表 clientToken 命中=client；`TIANSHU_BACKUP_TOKEN
  ?? TIANSHU_TOKEN` 持有者=admin）。客户端接入流程：admin 生成一次性邀请码
  （`POST /backup/invites/create`，或桌面端设置面板「数据备份」管理区）→
  新设备在桌面端「应用设置 → 数据备份 → 邀请码申领」填码申领
  （`POST /backup/claim`——单要素一次性邀请码自鉴权，`TS-` 前缀 8 位，
  核销即死；返回的 clientToken 仅此一次回显，成功后自动写入连接
  「备份专用 token」字段，零手填）。隔离语义：client 仅见/操作名下档，
  非己档一律 `BACKUP_NOT_FOUND`（防存在性探测），admin 全量可见；保留
  策略按 owner 分组独立裁（各设备各留 `app/backupMaxKeep` 档缺省 10，
  互不挤占）；存量无 owner 旧档读取期兜底归 admin。管理端点
  `backup/invites/*`（生成/列表/撤销）与 `backup/clients/*`（列表/踢除，
  踢除后该设备 token 即失效、设备名可重新申领）admin 专用（非 admin
  `BACKUP_ADMIN_ONLY`）。二层部署注意：设置了 `TIANSHU_BACKUP_TOKEN` 时
  备份端点只认它——admin 的桌面端连接须手动把该值填入「备份专用 token」
  （backupToken）字段，数据面与管理面同链取该字段（远控 token 在备份面
  401，且会出现「面板可见但管理调用被拒」的不一致态即由此而来）

**双链路 E2E 冒烟**（直连 + 中继，真实模型调用）在 mirror 仓维护：

```bash
cd <mirror 仓>
npm run test:e2e:server            # 自动 build 本仓 → 起两条链路各走一轮冒烟
TIANSHU_E2E_SKIP_BUILD=1 npm run test:e2e:server   # 跳过 build（产物已新）
```

- 模型来源：`E2E_MODEL_BASE_URL` / `E2E_MODEL_API_KEY` / `E2E_MODEL_MODEL` env
  全配优先；否则回退读 mirror dev 库（`~/.tianshu/dev/database/local.db`，只读）
  第一个启用 provider + 启用 llm 模型；两者皆无 → SKIP 打印退出 0（不阻塞 CI）
- `TIANSHU_SERVER_DIR` 可覆盖本仓路径（缺省 mirror 同级 `../tianshu-server`）
- 随机端口：脚本写 `dist/config/config.e2e.yml`（`app.port`）+ `NODE_ENV=e2e`
  合并加载，运行完删除；chat 数据经 `TIANSHU_DATA_ROOT` 临时目录隔离（完事删除）
- SQLite 库址在 `prisma/schema.prisma` 写死（`prisma/local.db`，env 不可重定向）：
  E2E 以「会话删除 + provider 按名 upsert（`e2e-smoke`）」收敛，重复运行不留增量行

## SDK（OpenAPI 导出与类型生成）

机器可消费的对外 SDK 面：OpenAPI JSON 导出 + `openapi-typescript` 类型
生成管线——外部调用方无需手写接口类型。内部仍以 `@tianshu/protocol`
手写契约为单源（生成类型只服务外部消费与漂移检测）。

- **调试**：Swagger UI（`/api-docs`）——Authorize 填 `Bearer <TIANSHU_TOKEN>`
  （未设 token 的开发态留空即可）直接调试全部端点
- **导出**：`npm run sdk:export`——加载编译产物（`dist/`）离线导出
  `openapi.json`（不监听端口、不触数据库生命周期钩子；gitignore 按需重生）
- **生成**：`npm run sdk:generate`——导出后再经 `openapi-typescript` 生成
  `sdk/api-types.d.ts`（gitignore；fresh clone 后先跑此命令）

**外部消费**：向部署方索取 `openapi.json`（或本仓自行导出），三行接入——

```bash
npx openapi-typescript ./openapi.json -o api.d.ts
```

```ts
import createClient from 'openapi-fetch';
import type { paths } from './api';

const client = createClient<paths>({ baseUrl: 'http://localhost:3000' });
const { data } = await client.POST('/session/send', {
  headers: { Authorization: `Bearer ${token}` },
  body: { sessionId: 1, content: '你好' },
});
```

**契约测试**：`test/sdk-contract.spec.ts` 锚定生成契约与 `@tianshu/protocol`
手写契约不漂移（协议 `ENDPOINTS` 无头端面全量入册 + 核心端点请求字段 +
类型层可赋值性 witness；响应面 71 段 wrapper schema 断言——SK-R 批
`@ApiWrappedOk/Accepted` 落地）。依赖上述产物：缺失时 SKIP 并打印提示，先
`npm run sdk:generate` 再 `npm test` 即实际运行。

**产物新鲜度**：`pretest` 钩子（`scripts/check-openapi-fresh.mjs`）比对
`openapi.json` 与 `dist/src/**/*.js` 的 mtime——重建过 dist 但未重跑
`sdk:generate` 时 fail-fast（防陈旧产物静默绿）；不自动重生（test 不隐式
触发 build），`openapi.json` 不存在时跳过（同 SKIP 语义）。

**限界清单（外部消费者注意，SK 终审 F2 入册）**：

- starter 继承的 User* DTO（`UserCreateDto`/`UserUpdateDto`/`UserActiveDto`
  等）在 `openapi.json` 为退化形（空 `properties`）——字段无 `@ApiProperty`
  元数据；外部调用 user 管理端点时以 starter 源码/实际响应为准
- 响应面（SK-R 批 2026-10-27 + 同日补齐批）：71 段已标响应 schema
  （`@ApiWrappedOk/Accepted` 装饰器产 wrapper 形 `{code,success,data,
message}`，data 指向 wire 响应 DTO）——核心编排域 40（session/provider/
  graph/automation/webhook 管理面/workspace/files/tool）+ assistant/skills/
  library/permission 31（assistant 仅 query/export/import、skills 仅
  query/read/setEnabled/installUpload/stats——协议 ENDPOINTS 中其余段为
  桌面被控面专属，本仓不实现）；starter 面（auth/user/operationlog）与
  skillhub/mcp/monitor/project 渐进补标（以实际响应为准留档）；webhook/
  :token 外部触发面（@Res 直发非包装）与 SSE 流式面不在 openapi 模型内

## 编排能力（capability graph）

无头端在 `chat`/`provider` 之外广告 `graph` 能力（`GET /info` 的
`capabilities` 含 `graph`，协议包 `CAPABILITIES` 单一事实源）——桌面端控制台
据此外显「编排」遥控区（不广告则整区不渲染）。能力面：

- **图五端点**：`POST /graph/query`（分页+keyword）/ `graph/save`（全量
  upsert，version 乐观锁）/ `graph/delete`（引用拦+run 级联+webhook 注销
  钩子）/ `graph/run`（202 受理返 `{runId}`，状态经事件流）/ `graph/runAbort`
  （`{runId}` 中止，USER_CANCELLED → aborted 投影）
- **任务四端点**：`POST /automation/query` / `automation/save`（全量 upsert，
  可选 `enabled` 字段显式启停——无 toggle 端点）/ `automation/delete`（批量
  +run 级联）/ `automation/runNow`（202 手动触发）
- **事件**：`graph.run.updated`（run 全生命周期：running → 节点 progress →
  succeeded/failed/aborted，成功带 `output`）；`automation.changed`（任务级
  刷新信号——消费端以重拉列表为准）
- **入站 webhook**：`POST /webhook/:token`（token 注册于 option 表
  `type=webhook name=graph:<id>`；同步模式挂起至完成按模板/默认体返回，
  异步模式 202 + `GET /webhook/:token/jobs/:id` 轮询）。注册管理面
  （WH 批 2026-10-27）：`POST /graph/webhook/{enable,disable,status}`——
  开启（重开换 token 旧 token 立即失效，URL 回相对路径由控制端拼）、
  关闭（幂等+在途运行中止）、回显（enabled+url+四配置）；路径带
  `graph/` 前缀是安全裁定——静态 token 守卫豁免 `/webhook/` 触发前缀，
  管理面含 `fullAccess` 全权开关不可匿名可达。外部系统仅凭每图 token 即可调用——静态 token 守卫豁免
  `${contextPath}/webhook/` 前缀（TIANSHU_TOKEN 部署下无需 Bearer，
  每图 token 自鉴权：未知 token 404；其余端点仍受守卫）
- **调度 tick**：config.yml `tianshu.automation.tickMs`（缺省 30000，
  E2E/测试可缩短快进）；应用生命周期自动启停
- **链式推进（事件总线副本，EB 批 2026-10-27）**：`eventJson`
  （`event`/`appStarted` 触发）任务支持链式推进——调度/手动/webhook 触发
  的 run 收官自动发布 `taskFinished` 事件，匹配的下游任务拉起（链深上限
  5 落 `skipped(chain_depth_exceeded)`；在途互斥落
  `event_skipped_running`；`appStarted` 在调度器启动即发布）。安全口径：
  事件触发的执行与手动触发同源 `safety`（config `tianshu.chat` 段）
- **可选节点依赖**：email 节点的 `nodemailer` 与 db/excel/pdf 族驱动未随
  安装——懒加载 + ambient 声明保编译，未装时对应节点报可读失败、不阻模块
  加载与其余节点；启用只需 `npm i <驱动>` 删声明，零源码改动

**编排 E2E 冒烟**（graph 全链 + once 任务调度触发 + webhook 同步模板往返，
真实模型）同在 mirror 仓维护：

```bash
cd <mirror 仓>
npm run test:e2e:graph
```

## 桌面工具桥（browser 四件）

chat 会话中模型调用 browser 四工具（`browser_snapshot` / `browser_navigate`
/ `browser_click` / `browser_type`）时无头端不本地执行——广播 `tool.request`
事件给全部活跃控制端连接（requestId 一次性，多端并发首个
`POST /tool/respond` 生效），挂起至 respond / 超时 / 接收者消失三路收敛；
`BridgeToolResult` 契约单份在 `@tianshu/protocol`。超时 config.yml
`tianshu.bridge.timeoutMs`（缺省 30000，控制端审批等待计入）；审批语义：
read/navigate 控制端直执（SSRF/协议校验在工具内），click/type 为 write
——无头端豁免本机 write 门禁，审批转控制端桌面审批卡（拒绝/超时以
`ok:false` 回喂模型）。**桥 E2E 冒烟**（fake model 本地假端点，无真模型
依赖）同在 mirror 仓维护：`npm run test:e2e:bridge`。

## 部署注意（@tianshu/* 共享包）

`@tianshu/core` / `@tianshu/protocol` 以 npm `file:` 方式安装，开发态
node_modules 里是 **symlink 直指 mirror 仓**（`../mirror/packages/*`）：

- **与 mirror 同机（dev 形态）**：symlink 直读 mirror `dist` 产物——mirror 侧
  重建包 dist 后重启本服务即生效，无需重装
- **独立部署机**：构建前二选一，把 `file:` 依赖实体化、脱离 mirror 仓——
  - `npm install --install-links`（npm ≥ 9，`file:` 依赖拷贝进 node_modules）
  - 或 mirror 侧 `npm pack` 出 tgz 随包分发，部署机离线 `npm i <tgz>`
- **双 `@langchain` 副本现象**：`@tianshu/core` 运行时经 realpath 解析依赖，
  其 `@langchain/*` 命中 mirror 仓 node_modules（`@langchain/core` 1.2.17），
  与本仓自装（1.2.18）并存同进程——现无跨副本 `instanceof` 判定（chunk/事件
  均为结构化类型），风险可忽略；对策：两仓 `@langchain/*` 保持同大版本，
  未来若引入 `instanceof` 语义须先对齐版本

**DB 落点覆盖**：env `TIANSHU_DB_URL`（`file:` 绝对路径）可覆盖默认
`prisma/local.db`——server 经 PrismaClient `datasources` 运行时消费
（`src/commons/database/db-url.ts`），首启缺库自动 `prisma db push` 建表
（schema 单一事实源）。

## 目录结构

```
├── Dockerfile         # 多阶段构建
├── docs/              # 开发文档（guide.md 业务模块开发指南）
├── prisma/            # schema（sqlite 默认 + postgresql 变体）与 seed
├── scripts/init.mjs   # 交互式初始化（占位符替换）
├── src/
│   ├── commons/       # 通用层：auth / codec / config / database / entity / exception / log / query / util / web
│   ├── config/        # config.yml 应用配置（端口/数据库/日志/监控/认证）
│   └── modules/       # 业务模块：controller + service + repository + entity + dto
└── test/              # Jest 单测
```

## 切换 PostgreSQL

1. `cp prisma/schema.prisma.postgresql prisma/schema.prisma`
2. 修改 `src/config/config.yml` 的 `database.url` 为 postgres 连接串
   （如 `postgresql://user:pass@host:5432/db`）。运行时以 config.yml 为准，
   仅设置 `DATABASE_URL` 环境变量会被它覆盖而不生效
3. Prisma CLI（migrate/deploy）另需 `DATABASE_URL` 环境变量：
   `export DATABASE_URL="postgresql://user:pass@host:5432/db"`，或写入 `.env` 文件
4. `npx prisma generate && npm run prisma:deploy`

## 配置

全部配置集中在 `src/config/config.yml`：端口、contextPath、压缩、数据库、
监控（health/metrics）、Swagger、日志、认证（JWT/Basic）。改动后重启生效。
JWT 签名密钥除外——已外移 `.env` 的 `JWT_SECRET`（spec §13 项 6，不入库）。

## 安全说明（Security Notes）

- **JWT 密钥存放于 `.env`（gitignored，不入库）**：`npm run init` 自动生成
  随机值写入 `.env`（`JWT_SECRET=...`）；手工生成：`openssl rand -hex 32`。
  未配置时启动打 `[安全告警]` 并以进程级随机秘密垫底（JWT 登录跨重启不可用，
  不可伪造；天枢远控面走 `TIANSHU_TOKEN` 不受影响）。执行 `npm run init`
  仍是生产部署的硬性前置。
- **生产/内网部署必须设置 `TIANSHU_TOKEN`**：未设置时天枢控制面
  （`/session/*`、`/provider/*`、`/event` 等）全部放行；服务默认绑定
  `0.0.0.0`（所有网卡），绑定非 loopback 且无 token 时启动会打
  `[安全告警]` 日志。绑定地址可经 config.yml `app.hostname` 收窄。
- **seed 初始账号 admin/123456 仅用于开发**，上线前必须修改。
- 生产环境建议在 config.yml 关闭 Swagger（`swagger.enabled: false`）。

## License

[MIT](LICENSE)

## 移植来源（mirror）

本仓库为天枢桌面端（mirror 仓）的服务端化重建，自 mirror 摘取的内容按下表登记，便于回溯对齐。RC 重构（2026-10-17）后，已收编进共享包的行标注「已收敛 `@tianshu/*`」——本仓副本删除、改经 npm `file:` 引包；其余仍双份的文件大多登记于 mirror drift 巡检 manifest（`packages/tianshu-core/scripts/drift-manifest.json`）。

| 本仓内容                                                                                                                                                                                                                     | mirror 来源                                                                                                                                                                                                                                                                                  | 摘取说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prisma/schema.prisma` 业务表 Provider/Model/Assistant/Workspace/SessionRecord/MessageRecord                                                                                                                                 | `c9ffe91` 的 `prisma/schema.prisma`                                                                                                                                                                                                                                                          | 逐字段复制自 mirror 同名 model（`session`/`message` 改名 `SessionRecord`/`MessageRecord` 避开语义混淆，`@@map` 保留原表名）；引用本仓暂无表的列（`projectId`/`planItemId`）按无外键约定保留为普通列                                                                                                                                                                                                                                                                                                                                                    |
| **已收敛 `@tianshu/core`**（RC 重构 2026-10-17）                                                                                                                                                                             | mirror `packages/tianshu-core`（原 `electron/domains/ai/chat/` 9 件：blocks 550d323 / history-truncate 3671a59 / tool-output-trim 9e46f83 / param-merge c047250 / error-classify a39cd41 / time-context 9e70b67 / scenario-prompt db29f7c / agent-chunk-emitter 与 run-chat-stream 120586f） | 本仓 `src/core/chat/` 等价副本已删（29e8036），改经 npm `file:` symlink 直引 mirror dist；`test/core/*.spec.ts` 同步改 import 包直测                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/core/context-usage.ts`                                                                                                                                                                                                  | `b36b1bb` 的 `electron/domains/ai/chat/context-usage.ts`                                                                                                                                                                                                                                     | 复制 + 类型收敛：`SkillInfo`→`SkillSummary`、`ToolDefinition`→本文件 `ToolDefinitionLike`（最小结构，完整定义可直传、JSON 序列化计量口径不变）、`buildSystemPrompt` 改引本仓 `./skill-prompt`；RC 起移出 `chat/` 直挂 `src/core/`，仍双份入 drift 巡检                                                                                                                                                                                                                                                                                                 |
| `src/core/expert-catalog.ts`                                                                                                                                                                                                 | `2084a7e` 的 `electron/domains/ai/chat/expert-catalog.ts`                                                                                                                                                                                                                                    | 复制 + 三处收敛（文件头注释详述）：`SkillInfo`→`SkillSummary`；`RECOMMEND_TOOL_NAME` 由工具层常量内联（本仓该常量唯一来源）；前端 `ExpertMarketItem`→本文件 `ExpertCatalogItem`（目录段仅消费 slug/name/subtitle/description 四字段，结构兼容）；RC 起移出 `chat/`，仍双份入 drift 巡检                                                                                                                                                                                                                                                                |
| `src/core/skill-prompt.ts`                                                                                                                                                                                                   | `5526304` 的 `electron/domains/ai/agent/skill-prompt.ts`                                                                                                                                                                                                                                     | 移植伴生纯函数（context-usage 的技能段 token 估算须与实际 system 组装同口径共用同一 buildSystemPrompt）：`SkillInfo`→`SkillSummary` 最小结构，逻辑逐字；RC 起移出 `chat/`，仍双份入 drift 巡检                                                                                                                                                                                                                                                                                                                                                         |
| `test/core/*.spec.ts`（9 件）                                                                                                                                                                                                | mirror `tests/ai/`、`tests/ai/chat/` 对应同名 `.test.ts`                                                                                                                                                                                                                                     | vitest→jest 适配：去 `describe.each` 渲染端孪生实现（本仓无渲染层）、夹具补类型标注（ts-jest 全量类型检查，esbuild 不查）、loader 夹具改 `Promise.resolve` 形态（repo eslint require-await）；各文件头注释登记来源 hash；RC 重构后其中收编件直测 `@tianshu/core`（import 包，非本地副本）                                                                                                                                                                                                                                                              |
| **已收敛 `@tianshu/protocol`**（RC 重构 2026-10-17）                                                                                                                                                                         | mirror `packages/tianshu-protocol`（chat-contract / relay-frames / server-event 三模块；ChatStreamChunk 段源自 mirror `src-react/domains/ai/api/chat.api.ts`）                                                                                                                               | 本仓 `src/core/chat/chat-stream-chunk.ts`（chunk 协议类型）与 `src/protocol/server-event.ts` 本地副本已删（f9b0f2a），协议类型唯一事实源在包，npm `file:` 消费；`message.chunk` 载荷、`ServerEvent`/`CAPABILITIES` 等随之引包                                                                                                                                                                                                                                                                                                                          |
| `src/core/tools/*`（tool-definition/file-tools/command-tool/web-tools/plan-tools/skill-loader/read-skill/create-skill/skill-archive/approval/permission-mode/workspace-path/tool-registry/tool-gate/langchain-tool-adapter） | `120586f` 的 `electron/domains/ai/agent/` 同名文件                                                                                                                                                                                                                                           | 无头工具集移植：file 五件 + bash + fetch + plan 五件 + read_skill/create_skill。裁剪：browse（面板联动）、browser/mcp/dispatch/widget/专家三件不注册；child-monitor/network-gate（electron 依赖）不入 bash；rm 回收站由 electron shell.trashItem 改数据根 trash/ 目录 rename（EXDEV 回退 copy+rm）；create_skill 去 skillStat 埋点；tool-gate 增 allowDangerousTools 门（config.yml `tianshu.chat.allowDangerousTools`，缺省 false：bash 与批量删除直接拒绝，spec §12 偏离 2），mirror unattended 分支语义并入 |
| `src/core/security/*`（command-policy/command-gate/file-policy/file-gate/file-blocklist/file-history-estimate）                                                                                                              | `120586f` 的 `electron/domains/security/` 同名/同段文件                                                                                                                                                                                                                                      | 命令门/文件门判定纯函数与模块单例逐字移植（fail-open default，未安装即回审批链）；`file-blocklist` 摘 defaults.ts 内置敏感路径清单；`file-history-estimate` 仅取 countFilesForEstimate（FileHistoryService 快照/配额备份服务未移植，onBackupFile 契约保留）                                                                                                                                                                                                                                                                                            |
| `src/core/provider/model-factory.ts`                                                                                                                                                                                         | `120586f` 的 `electron/domains/ai/orchestration/langchain-model-factory.ts` + `provider/provider-runtime.ts`                                                                                                                                                                                 | LangChain 四家工厂逐字移植（extraHeaders 保留、采样/限额按各家构造字段名分派）；ProviderRuntimeInfo/parseExtraHeaders 并入同文件                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `src/core/chat-runner.service.ts` + `chat-core.module.ts`（RC 起移出 `chat/` 直挂 `src/core/`）                                                                                                                              | `120586f` 的 `chat.service.ts` send/sendRound/streamAndPersist/assembleContext/resolveAgentOptions/collectToolDefinitions/collectSkills 链路                                                                                                                                                 | 无头编排移植：DB 走本仓 SessionRecord/MessageRecord；run({sessionId,content,assistantId?,userId,onChunk}) 供 T7 send 端点调用，stop/approve/setAccessMode 暴露中止与审批决议面。裁剪：T32 自动压缩不移植（truncateHistory 硬截兜底；压缩态读取保留）、标题生成/图片附件回喂/专家目录与专家团/项目 prompt 装配/监控埋点/toolPermission 记忆表不移植；审批经 ApprovalCoordinator 由 relay 注入；runChatStream 等纯函数已改自 `@tianshu/core` 引入；PL-1 起 system 组装接个性化注入（见下行）                                                             |
| `src/core/personalization.ts`                                                                                                                                                                                                | mirror `personalization.repo.ts`（读段）+ `personalization.config.ts` 的 `fromAppOptions`（解析段）；`buildPersonalizedSystem`/纯常量段已收敛 `@tianshu/core`（PL-1，mirror 原位 re-export）                                                                                                 | 个性化读链移植（PL-1）：option 表 type="app" 现查不缓存、异常回退全默认不断对话（语义逐字）；chat-runner system 组装经 `buildPersonalizedSystem` 包裹 modeSystem（persona 前置+行为段后置，mirror chat.service 同构）；memory Profile 即 option 行 `personalization.memoryProfile`（编译产物），无头端初始为空 = mirror 未配置时行为一致；读段双份入 drift 巡检                                                                                                                                                                                        |
| `src/core/library/`（library.repository.ts + library-tools.ts）                                                                                                                                                              | mirror `electron/domains/ai/library/library.repo.ts`（检索段）；`library_search` 工具 mirror **无对应**（agent 工具清单查证无资料库项——2026-10-18，mirror 检索面为 graph librarySearch/vectorSearch 节点 + LibraryRepository.search IPC）                                                    | PL-2 检索链：libraryItem 表逐字段摘取（@@map 保留原表名）；repository 摘 search/getById（写面零摘——library 写侧属后续「library 同步/上传」批）+ findFilesByNames（工具命中回联配套）；library_search 为 server 新建 read 工具——执行体接 graph vector-store 余弦检索（embedding 无独立配置面：query 经资料库块现有模型 embedTexts 向量化、同模型过滤；空库如实空结果不炸不伪造），注册 chat collectToolDefinitions 常驻 + tool-registry（graph LLM 节点 tools:true 自动获得）；双份面待 PL-T3 入 drift 巡检                                             |
| `prisma/schema.prisma` Project/PlanItem/SkillRecord                                                                                                                                                                          | `120586f` 的 `prisma/schema.prisma` project/planItem/skillRecord                                                                                                                                                                                                                             | 逐字段摘表（plan_* 工具属地落库与 create_skill 入表所需；@@map 保留原表名）                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `test/helpers/scripted-chat-model.ts`、`test/core/run-chat-stream.spec.ts`、`test/core/chat-runner.spec.ts`、`test/core/skill-prompt.spec.ts`                                                                                | mirror `tests/ai/helpers/scripted-chat-model.ts`、`tests/ai/agent-loop.test.ts`、`tests/ai/skill-prompt.test.ts`                                                                                                                                                                             | vitest→jest 适配（FakeStreamingChatModel 手法 + agent loop 4 用例 + 本仓新增 bash 门控/文本增量序两用例；chat-runner 为本仓新写：临时库 e2e 验证落库/chunk 序/审批/并发守卫）；skill-prompt 5 用例为 T5 遗留补齐                                                                                                                                                                                                                                                                                                                                |

## 开发流（@tianshu/* 共享包与双份文件）

- 改 mirror `packages/tianshu-protocol` / `packages/tianshu-core` 源码后：本仓
  `npm run sync:core` 一条命令即可——前置双包 rebuild（协议包+core）再重装
  `file:` 依赖，防 symlink 形态下静默消费旧 dist；重启本服务即生效
- 改上表仍双份的文件后：mirror 侧跑 `npm run check:drift` 巡检两仓漂移
  （归一化差异行数增长超容差 exit 1，减少仅 WARN 提示收编机会；有意变更
  用 `npm run check:drift -- --rebase` 重置基线并人工复核）
