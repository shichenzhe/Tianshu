# 天枢服务端二期：打包内嵌分发设计

- 日期：2026-10-18
- 状态：已实测（PK-T3 mac 实测通过；PK-T3 修复轮修订——standalone/ 独立产物目录、extraResources 拆条、打包态 DB 落点外移，修订处标注）
- 前置：一期 Supervisor（spawn+握手）；RC 共享 core（file: symlink 消费形态——打包需实体化）

## 1. 背景与目标

本地无头端 spawn 目前 dev 指向兄弟仓 `../tianshu-server/dist`——生产安装包用户无该仓。本设计把 server 自包含产物打进桌面端安装包（extraResources），Supervisor 双态解析，用户零 Node 环境可用。

**目标**：standalone 产物管线 + 安装包内嵌 + 打包态 spawn（ELECTRON_RUN_AS_NODE）+ 实测闭环。
**非目标**：server 独立分发（npm/Docker 已有路径）；自动更新联动（内嵌 server 随桌面端版本整体更新）；Windows/Linux 实测（mac 打通后按平台补——跨平台差异标注）。

## 2. 方案

### 2.1 server standalone 产物（server 仓）

`npm run dist:standalone`（scripts/standalone.mjs）：
1. `npm run build`（dist/src 全量）
2. 干净 prod 依赖：`npm ci --omit=dev`（在临时目录安装后拷贝 node_modules，或 `npm prune --omit=dev` 就地——选**就地 prune**（构建机专用，简单；报告记录取舍））
3. 实体化双包：file: symlink → 实体拷贝（`node -e` 复制 packages/*/dist+package.json 到 node_modules/@tianshu/*——或 `npm i --install-links` 重装，选直接拷贝法：确定性强不依赖 npm 版本行为）
4. `prisma generate`（确保 client 就绪）
5. **组装 `standalone/` 独立产物目录**（PK-T3 修复修订）：dist + node_modules（prune 态 prod-only + 双包实体，symlink 保留）+ prisma（排除 `local.db*`）+ package.json 拷贝入 `standalone/`——原仓随后恢复 devDeps 照常开发，产物独立不受影响（解「恢复 devDeps 与产物 prod-only 互锁」）
6. 产物清单校验（指向 standalone/：双入口 dist、双包实体性、prisma client、**@nestjs/core 实拷证据**）+ DB 纯净度校验（standalone/ 全树无 `*.db`）+ 冒烟（standalone/ 自包含起 + `TIANSHU_DB_URL` 临时库——首启建库路径一并冒烟）

### 2.2 mirror 构建链

- `electron-builder.json5`：extraResources **拆四条 from 直指 `../tianshu-server/standalone/<sub>`**（dist/node_modules/prisma/package.json → `tianshu-server/<sub>`；PK-T3 修复修订——electron-builder createFilter 对 from 根下直接子级 `node_modules` 无条件排斥（曾致 dmg 零拷 node_modules 残缺），from 直指子目录即绕开；无 filter 时 builder 自动补 `**/*`（dot:true），`.prisma` engine 随入；prisma 条目排除 `local.db*` 涉密兜底）
- mirror scripts：`build:server`（= `npm --prefix ../tianshu-server run dist:standalone`）；README/CLAUDE.md 打包节说明「打安装包前先 build:server」
- 缺席保护：extraResources from 不存在时 electron-builder 报错即 fail-fast（可接受——提示清晰）

### 2.3 Supervisor 双态解析（mirror `connections.ts` 命令注入处）

- dev 态（`!app.isPackaged` 且兄弟仓存在）：现状 `node ../tianshu-server/dist/src/main.js`
- 打包态：`process.execPath` + args `[resourcesPath/tianshu-server/dist/src/main.js]` + env `ELECTRON_RUN_AS_NODE: "1"` + **`TIANSHU_DB_URL: "file:<homedir>/.tianshu-server/database/local.db"`**（PK-T3 修复修订——SQLite 落点外移出 .app 包体；server 侧 PrismaClient `datasources` 运行时覆盖 + 首启缺库自动 `prisma db push` 建表；dev 态不注入，仓内 prisma/local.db 零改动）（继承既有 env 注入：TIANSHU_TOKEN 等）
- relay 形态（`dist/src/relay/relay-main.js`）：随 `dist/**` 附带且可用（冒烟过 `/health`）——公网部署仍走 Docker/VPS，桌面端不提供 relay 启动入口（README-relay 定位不变）

### 2.4 实测（mac）

`build:server` → `npm run build`（dmg）→ 运行 release 产物（未安装直接 open 应用）→ 控制台页本地无头端 start → health/握手/一次会话往返 + E2E 冒烟（复用 e2e 手法指向打包产物）。Prisma 在 ELECTRON_RUN_AS_NODE 兼容性为**首要验证点**（不兼容则 fallback：extraResources 附带 node 二进制——工程量升，届时上报裁定）。

## 3. 假设与偏离

1. server 版本与桌面端绑定整体分发（不独立升级）
2. relay 形态随 `dist/**` 附带且可用（PK-T3 实测修订——原表述「不内嵌」与事实不符；公网部署仍走 Docker，本机 relay 调试 dev 用兄弟仓）
3. prod prune 就地（构建机专用）；Windows/Linux 按平台补实测
4. 数据根打包态仍 `~/.tianshu-server`（PK-T3 修复修订：SQLite 落点 `~/.tianshu-server/database/local.db`，经 `TIANSHU_DB_URL` env 注入——dev 态库在仓内 `prisma/local.db`，两态分库、首启新建无迁移；workspace 等文件数据与 dev 同根沿用）
