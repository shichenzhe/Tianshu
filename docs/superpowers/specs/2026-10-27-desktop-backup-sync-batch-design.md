# 桌面端数据备份/下载（双向同步）批设计 spec

日期：2026-10-27
状态：设计已确认（方案 A 快照整包 + 分块传输），待写实施计划
关联：单 UI 多主机架构（spec 2026-10-19）；server 摘表互通预埋（apps/tianshu-server/prisma/schema.prisma 头注释「便于数据互通」）；webhook admin / server-event-bus 批（token 守卫与协议包契约先例）

## 0. 事实基线

- **需求语义**（用户裁定）：同步场景=**桌面端全量数据的备份和下载**——上传=桌面全量数据上行存档到服务端，下载=从服务端拉回恢复到桌面端。方向上的双向，非并发实体合并；冲突策略「桌面端优先」在快照模型下天然成立（上传新档替旧档占保留位、下载由用户主动发起且恢复前有保护副本）；手动触发。
- **两端库同构但无同步锚点**：server 15 张摘表逐字段复制自 mirror、`@@map` 同表名，但两端主键均为独立 Int 自增——本批走整库快照，不做实体级映射（逐表同步留后续批）。
- **数据根结构**（`electron/commons/paths.ts`）：`app|dev/` 分组下 `database/ skills/ library/ logs/ attachments/ workflow-assets/ projects/ file-history/ .jwt-secret`。
- **鉴权栈**：server 全局 `StaticTokenGuard`（`commons/auth/guard/token.guard.ts`）——`TIANSHU_TOKEN` 设置时对全部路由（含 @Public，webhook 前缀除外）校验 Bearer header / `?token=` query，timingSafeEqual 定长摘要比对。
- **传输面**：Direct Transport 为 fetch+JSON、15s 超时窗；server Fastify `bodyLimit: 16MB`（main.ts:38）；既有大文件端点先例 `files/uploadImage`（≤3MB base64 in JSON）。
- **桌面端恢复兼容性天然复用**：恢复旧版本库文件后，桌面端既有 db_version + snapshot-guard 迁移机制自动接管 schema 升级，本批零新增迁移代码。
- **server 数据根**：`~/.tianshu-server/`（SQLite 经 `TIANSHU_DB_URL` 外移 `database/local.db`）。env 覆盖先例：`TIANSHU_DB_URL`（db-url.ts）——注意其头注释记录的坑：`configuration.ts` 顶层会用 config.yml 无条件覆写 `process.env.DATABASE_URL`，故 env 覆盖一律走 `TIANSHU_*` 独立命名同族，不走 config.yml 覆写链。

## 1. 总体形态

- **备份单元**：桌面端 `app|dev/` 分组的数据库在线快照 + 资产目录，打成单文件 `data.tar.gz`，整体上传；恢复整体下载解包替换。
- **备份内容**：`database/local.db`（快照）+ `skills/ library/ attachments/ workflow-assets/ projects/` + `.jwt-secret`；**排除** `logs/ file-history/`（可重建/无备份价值）。
- **通道**：仅 Direct 直连连接可用（relay E2E 中转帧传大包效率过低，后续批另议）。
- **打包器**：手写 ustar tar（prefix 字段，路径上限 255）+ Node `zlib` gzip——零新依赖（依赖白名单铁律不动）；超 255 路径**报错中止**，不静默跳过（备份不静默丢数据）。
- **schema 变更**：无。server 端备份元数据用文件（meta.json），不入 prisma 库——备份系统不依赖被备份的库。

## 2. server 端设计（新 `modules/backup/`）

**端点**（全 POST 风格，JSON+base64 载荷，统一 ResponseInterceptor 包装）：

| 端点 | 入参 | 出参 | 语义 |
|---|---|---|---|
| `POST /backup/create` | appVersion, schemaVersion, fileSize, sha256, chunkCount, note?, deviceName? | `{id}` | 登记备份元数据（id=服务端 uuid），data.tar.gz 占位 |
| `POST /backup/{id}/chunk` | seq, data(base64≤4MB 原始字节), chunkSha256 | `{received: seq}` | 收块即验 hash（错则拒收，客户端重传本块）→ 追加写临时 `.part` 文件 |
| `POST /backup/{id}/commit` | — | `{fileSize, sha256}` | 终验：块数连续（收块时已逐块验 hash）+ 整包 sha256 → rename `.part`→`data.tar.gz` + meta.json 定稿 + 保留策略裁剪 |
| `POST /backup/list` | — | `BackupMeta[]` | 按 createdAt 倒序 |
| `POST /backup/{id}/download` | seq | `{data(base64), totalChunks}` | 分块下行（块大小对齐上行 4MB） |
| `POST /backup/{id}/delete` | — | `{deleted: true}` | 删除档 |

**存储**（备份根目录单一解析出口，防调用方散拼字符串——mirror paths.ts 同法）：
- 优先级 `TIANSHU_BACKUP_DIR` 环境变量（`TIANSHU_DB_URL`/`TIANSHU_TOKEN` 同族命名；**容器部署经 `-e`/compose 映射宿主机卷**，防容器重建丢档）> 默认 `<server 数据根>/backups/`；
- 路径 `path.resolve` 归一，启动时 `mkdirSync recursive` 兜底（ensureDatabase 惯例）；不走 config.yml（覆写链坑见 §0，容器场景 env 直击痛点）。
- 档内布局：`<备份根>/<id>/{meta.json, data.tar.gz}`；`.part` 中间态可被 create 幂等重建（同 id 重复 create 清空重传）。

**保留策略**：commit 定稿时按 createdAt 超上限删最旧（默认 10 份；`option` 表可配 `backup.maxKeep`）。

**防线**：单备份大小上限（默认 2GB 可配）；分块 seq 连续性校验；同 id 并发互斥（inflight Set）；backup id 服务端生成、客户端仅回传引用（永不拼路径）；文件名恒定不取用户输入。

## 3. 鉴权与安全

1. **第一层（自动继承）**：全局 StaticTokenGuard——backup 端点注册即要求 `TIANSHU_TOKEN`，零代码。
2. **第二层（可选专用 token）**：新环境变量 `TIANSHU_BACKUP_TOKEN` + BackupGuard 挂 backup controller——**设置时备份端点只认它**（日常远控 token 泄漏不暴露整机备份面，最小权限）；未设置回落仅 TIANSHU_TOKEN。比对沿 token.guard.ts 同款 timingSafeEqual 定长摘要。
3. **完整性**：每块 sha256（上传声明+落盘校验）+ 整包 sha256（commit 终验、下载端复核）；下载后桌面端再全量校验。
4. **传输形态**：分块统一 JSON+base64（4MB→5.3MB < 16MB bodyLimit）——完全贴合现有 guard/interceptor/全 POST 约定，零 octet-stream 特例；代价 +33% 传输量，接受。
5. **明文风险留档**：Direct 无 TLS 时 apiKey/密码 hash 明文过线（与现有 chat 流量同风险等级）——端到端加密备份留后续批，本批不做。

## 4. 桌面端设计（新独立域 `electron/domains/backup/`——单一职责：快照/打包/传输/恢复；连接信息从 server 域连接注册表取，不掺连接管理）

**备份流程**：
1. better-sqlite3 单开连接对 `local.db` 调 `.backup()` 在线快照到临时文件（WAL 安全、单时间点一致，不打扰运行中连接）；
2. tar.gz 打包（快照+资产目录，相对路径收录）到临时目录 → 全量 sha256；
3. `create` → 逐块 `chunk`（base64，独立 fetch 超时参数，不走 transport 15s 窗）→ `commit`；
4. IPC 事件 `backup:progress` 上报进度（前端进度条）；完成清理临时文件。

**恢复流程**：
1. `list` 选档 → 逐块 `download` 到临时文件 → 全量 sha256 校验；
2. **保护副本**：自动把当前数据打一份本地保护包存 `backups-local/`（不走网络，仅本地留存，命名含时间戳）；
3. 解包到 **staging 目录** → 全部就绪后三步 rename 原子切换（旧→old、staging→new、删 old）→ 任一步失败自动回滚；
4. 二次确认对话框（明示「将自动保留当前数据保护副本」+「应用将重启」）→ 完成后 `app.relaunch()`。

**UI**：设置面板新增「备份与恢复」页——目标主机下拉（仅 Direct 已连接）、「立即备份」+进度条+结果、远端备份列表（时间/版本/大小/备注）行操作=恢复/删除、恢复二次确认。文本走 i18n（zh-CN/en-US 双语，禁硬编码）。

## 5. 协议包契约（`packages/tianshu-protocol`）

新 `backup-contract.ts`：BackupMeta / BackupCreateRequest / BackupChunkRequest 等端点 DTO + 常量（`BACKUP_CHUNK_BYTES=4MB`、上限默认值）。server DTO 定义与桌面端请求体均自协议包引用，防双端漂移（webhook/server-event 契约同位先例）。改协议包后 server 侧 `npm run sync:core` 重建 dist。

## 6. 测试策略

- **打包器单测**（mirror vitest）：ustar 头/prefix 长名（100~255）/空文件/大文件/GNU tar `-tzf` 互验与解包对拍/超 255 报错中止。
- **server e2e**（jest）：create→chunks→commit→list→download sha256 对拍全链路；块 hash 错误/seq 跳号拒绝；401（无 token）；BACKUP_TOKEN 设置时 TIANSHU_TOKEN 被拒；保留策略裁剪；delete 后 list 不见；`TIANSHU_BACKUP_DIR` 覆盖默认目录（临时目录注入对拍落点）。
- **桌面端单测**（vitest，替身法沿用保留策略批先例）：恢复 staging 原子切换中途失败回滚；保护副本生成；进度事件序列。
- **契约测试**：`tests/ai/server/protocol-package.test.ts` 同位补 backup 契约断言。

## 7. 非目标（留档）

- 实体级双向同步（uuid 锚点/冲突合并）——后续批；
- relay 链路备份传输；端到端加密备份包；
- 移动端备份入口（移动端范围裁定 2026-10-27 惯例：桌面能力面收口）；
- 备份计划任务/定时自动备份；
- server 端备份的跨设备去重/增量。

## 8. 风险

- better-sqlite3 `.backup()` 对 WAL 运行库的并发写窗口——快照点一致性由 SQLite backup API 保证（页级拷贝），验收用例含「备份期间持续写入」；
- 大库分块耗时：进度上报 + 块级重试（幂等：失败块重传）；15s 窗绕行需独立 fetch（连接复用 baseUrl+token）；
- 恢复替换 `app/` 时 Prisma/日志等持有句柄的消费者——rename 目录级切换不逐文件覆盖，句柄失效由 relaunch 收口；
- `.jwt-secret` 随包同步到 server：备份面已受二层 token 保护，属预期行为（整机迁移语义）。
