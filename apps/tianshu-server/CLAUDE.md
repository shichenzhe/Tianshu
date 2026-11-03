# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

shu-nestjs-starter——NestJS + Fastify + Prisma + TypeScript 服务端脚手架模板（从生产业务项目抽取）。

## 开发命令

```bash
# 开发调试（watch 模式）
npm run start:dev

# 构建
npm run build

# 单元测试（Jest，rootDir=test）
npm run test

# Lint
npm run lint

# Prisma
npm run prisma:generate   # 生成客户端
npm run prisma:reset      # 重建 SQLite + seed 初始 admin
npm run prisma:migrate    # 迁移（开发）
npm run prisma:migrate:pg # 迁移（开发，PG 变体 --schema prisma/pg/schema.prisma）
npm run prisma:deploy     # 迁移（生产）
npm run prisma:studio     # 数据库 GUI

# relay / relay-admin（多租户中继，见下「relay 与 relay-admin」节）
npm run start:relay       # relay 本体独立进程（dist/src/relay/relay-main.js，需先 build）
npm run start:relay-admin # relay-admin 控制平面独立入口（dist/src/relay-admin/main.js）
npm run prisma:generate:ra # relay-admin 独立库 client 生成（--schema prisma/relay-admin/schema.prisma）
```

启动地址：http://localhost:3000，Swagger：/api-docs，管理端点：/actuator/health、/actuator/metrics（JSON 包裹）、/actuator/prometheus（Prometheus 抓取用）

## 代码架构

### 分层

- **src/commons/** - 通用层（与业务无关，新项目直接复用）
  - `auth/` - JWT+Basic 双认证：strategy / guard / decorator（`@Public` `@JwtAuth` `@Roles` `@AccessContext`）/ JwtAuthService
  - `codec/` - JSON 序列化编解码（JsonDateTime 装饰器等）
  - `config/` - config.yml 加载（configuration.ts）与各段配置实体
  - `database/` - PrismaModule/PrismaService
  - `log/` - Winston 按日轮转日志工厂
  - `web/` - ResponseInterceptor（统一包装）、HttpExceptionFilter、请求日志/JSON 序列化拦截器、management/（health + metrics）
  - `query/` - QueryFilter/QueryResult 通用列表查询
  - `entity/` - StandardEntity（审计字段）、OperateContext/Operator
  - `exception/` - BusinessException + ErrorCode 枚举与工厂
  - `util/` - 通用工具（date.util、password-encrypt）
- **src/modules/** - 业务模块（参考 user 模块结构）：
  `xxx.controller.ts` + `xxx.service.ts` + `xxx.repository.ts` + `entity/`（库表实体 + querydecoder + queryfilter）+ `dto/`
- **src/config/config.yml** - 全部运行配置

### 请求流

Fastify → JwtAuthGuard/RolesGuard → 拦截器前置（RequestLogger 等）→ ValidationPipe → Controller → Service（抛 BusinessException）→ 拦截器后置（ResponseInterceptor 包装 `{code, message, data}`）→ HttpExceptionFilter 兜底

（即 Nest 实际执行序：middleware → guards → interceptors(前) → pipes → controller → interceptors(后) → filters）

### 路由约定

- 全部 POST 风格业务接口（create/query/getById/update/delete）
- 需登录：`@UseGuards(JwtAuthGuard)`；限角色：`@Roles(UserType.admin)` + RolesGuard
- 免登录接口：`@Public()`
- 获取当前操作者：`@AccessContext() operateContext: OperateContext`

### 数据库

- Prisma ORM，默认 SQLite（`prisma/local.db`），PostgreSQL 变体 `prisma/pg/schema.prisma`（派生脚本 `prisma/derive-pg.mjs` 产物）
- 不使用外键（`relationMode = "prisma"`），关联在 service 层维护
- 主要表：`user`、`operation_log`、`option`
- 枚举 `UserType`：`admin` / `user`

## relay 与 relay-admin（多租户中继）

完整部署与协议文档见 `README-relay.md`（单租户 static token / 多租户 jwt 双场景，spec 2026-11-03）。

- **relay 本体** `src/relay/`：纯 `node:http` + `ws` 转发面，不依赖 Nest——`npm run start:relay`（跑 dist，需先 build）。双鉴权模式互斥：`--token`（static 单租户，现状）/ `--auth-pubkey`（jwt 多租户，Ed25519 验签 + 三租户闸门 4005/4006/4007 + CRL 拉取）；`relay-client.ts` 是被控端接入件（AK 三要素 env `TIANSHU_RELAY_ADMIN_URL/AK_ID/AK_SECRET`，续期单源 `@tianshu/core` relay-credential）
- **relay-admin 控制平面** `src/relay-admin/`：运营方服务（公共中继 SaaS），Nest 独立入口 `dist/src/relay-admin/main.js`（`npm run start:relay-admin`，缺省端口 8412/`RA_PORT`）——租户用户/AK 管理（明文仅一次、库内 sha256）、access JWT 签发（Ed25519）、吊销 CRL 名单 + kick 即时联动、在线视图；复用脚手架 commons（全局 JWT 守卫/统一包装/异常过滤；token/revocations 两协议端点走路由级 RelayProtocolFilter 直出真状态码）
- **独立库**：`prisma/relay-admin/schema.prisma`（ra_user/ra_access_key/ra_audit_log/ra_admin_user），与业务库物理隔离。env `RA_DATABASE_URL`（**生产必须绝对路径**——相对缺省锚 schema 目录，dist 运行会漂移）；dev 首建 `prisma:generate:ra` → `RA_DATABASE_URL=file:./data/relay-admin.db npm run prisma:push:ra`（**push 无 env 直接报错**，prisma CLI 不读 service 层缺省）→ 同 env `prisma:seed:ra`（单管理员 admin，一次性口令打控制台）
- **密钥/联动 env**：`RA_INTERNAL_SECRET`（与 relay `--internal-secret` 同一秘密——kick/stats/CRL 控制信道；与 Ed25519 密钥分域）、`RA_RELAY_BASE_URL`（kick/stats 联动目标；缺失/不可达 **warn-degrade**——禁用照常、CRL 不受影响）、`RA_DATA_DIR`（Ed25519 私钥落点 `<dir>/keys/relay-access.pem` 0600；公钥自私钥派生，**勿读伴随落盘公钥文件**——换私钥后陈旧陷阱）、`JWT_SECRET`（管理员登录，脚手架 .env 同款）
- **RA 路由不入主 OpenAPI**（独立入口）：改 relay-admin 控制器不会触发 `check-openapi-fresh` 门禁——守护靠 `test/relay-admin/` jest 套件；relay 独立镜像 `Dockerfile.relay`（零业务代码，最终层仅 5 个 relay js + ws + 协议常量包）

## 开发规范

- 文件名 `kebab-case`；变量/函数 camelCase；类 PascalCase
- Prettier：单引号、tabWidth=2、printWidth=80、分号、trailingComma=all
- 业务错误一律抛 `BusinessException` + `ErrorCode`（见 commons/exception），不要裸抛 HttpException
- 列表查询继承 QueryFilter，配 querydecoder 转换为 Prisma where
- 新表实体继承 StandardEntity（含审计字段 creator/updator/时间戳）

## 脚手架专有

本仓库是脚手架模板，源码中内置 3 个占位符，由 `npm run init` 交互式替换（幂等，可重复运行，记录写入 `shu-init.json`，已 gitignore）：

- `tianshu-server` - 应用名（package.json `name`、config.yml `app.name`、Swagger 标题、prometheus tag）
- `shichenzhe` - 作者（package.json、LICENSE）
- `` - 仓库地址（留空则移除 repository 字段）

JWT 签名密钥不入库（spec §13 项 6）：`npm run init` 生成随机值写入 `.env`
（`JWT_SECRET=...`，已 gitignore）；手工方式 `openssl rand -hex 32`。未配置时
启动打安全告警并以进程级随机秘密垫底（JWT 登录跨重启不可用；天枢远控面走
`TIANSHU_TOKEN` 不受影响）。
