# 备份多用户批（邀请码自助申领 + owner 隔离）设计 spec

日期：2026-10-28
状态：设计已确认（双身份鉴权 + 邀请码自助 + admin 全局可见），待写实施计划
关联：桌面端数据备份/下载批（spec 2026-10-27，commit c6b510f7..cfd747cd）；webhook 前缀豁免先例（token.guard.ts）；option 表 app 配置先例（backupMaxKeep/serverConnections）

## 0. 事实基线（现状差距）

- 现备份面仅两个静态 token（全局 `TIANSHU_TOKEN` + 可选 `TIANSHU_BACKUP_TOKEN`），无用户维度；`list()` 全量返回、`download/delete` 无归属校验、`trimOldBackups` 全局裁旧——多客户端共用一个 server 时互相可见/可恢复（**恢复他人档=整库换成对方用户体系**）/互挤保留额。
- `BackupMeta` 无 owner 字段；存量档无迁移锚点。
- server 既有 JWT 多用户体系（admin/user）未接备份面——JWT 会话过期与桌面端无人值守备份语义不搭，本批不接（用户裁定：客户端唯一 id 走 server 预分配 token 路线）。
- 桌面端 `ConnectionConfig`（electron/domains/server/connections.ts）单 `token` 字段——clientToken 需独立字段防「一个 token 双身份冲突」（填 clientToken 后远控面 401）。

## 1. 双身份 BackupGuard（升级 backup.guard.ts）

Bearer token 三级识别，注入请求上下文（`request.backupIdentity`）：
1. **客户端 token**：命中注册表（`backupClients`，sha256 摘 timingSafeEqual 比对——token.guard.ts 同款）→ `{kind: "client", clientId}`
2. **admin token**：`TIANSHU_BACKUP_TOKEN`（若设置，此时 `TIANSHU_TOKEN` 在备份面仍被拒——现状语义不变）或未设时 `TIANSHU_TOKEN` → `{kind: "admin"}`
3. 都不中 → 401「无效的备份 token」

`POST backup/claim` 豁免 BackupGuard（照 token.guard.ts 的 webhook 前缀豁免先例）——其鉴权即「第一层 StaticTokenGuard 大门 token + 邀请码核销」本身。单用户部署零迁移：不登记客户端时 admin 行为=现状；存量无 owner 档读取兜底 `__admin__`（无迁移脚本）。

## 2. 邀请码自助申领（唯一入场；删除 register 旁路，YAGNI）

**两要素**：大门 token（人人有）+ 一次性邀请码（admin 控发）——防伪装与爆破。

**admin 端点**（admin 上下文才放行）：
- `POST /backup/invites/create {count?, note?}` → 批量生成（默认 1）一次性码：`TS-` 前缀 + 防混淆字符集（去 0O1lI）随机 8 位；存 option 表 `app/backupInvites` JSON `[{code, note, createdAt, usedAt?, usedBy?}]`（明文存——admin 需复看未用码；能读库者即 server 主人级威胁）
- `POST /backup/invites/list`（含 used 状态）；`POST /backup/invites/{code}/delete`（撤销未用码）
- 无过期时间（核销即死）

**客户端端点**：
- `POST /backup/claim {inviteCode, deviceName}`：码有效 → **原子核销**（并发同码仅一次成功）→ 生成 clientToken（随机 hex32）→ 注册表落 `[{clientId: deviceName, tokenHash, createdAt, invitedNote}]` → 返回 `{clientId, clientToken}`（token 唯一一次明文回显）
- 设备名已注册 → `BACKUP_CLIENT_NAME_TAKEN`（换名重试）；码无效/已用 → `BACKUP_INVITE_INVALID`

**admin 客户端管理**：`POST /backup/clients/list`（不回显 token）、`POST /backup/clients/{clientId}/delete`（踢除；该 id 后续可重新申领）。

## 3. 隔离语义（六端点行为升级）

| 端点 | 客户端上下文 | admin 上下文 |
|---|---|---|
| create | owner=clientId 注入 meta | owner=`__admin__` |
| list | 仅自己 | 全部（行含 owner） |
| download | 仅自己；他人档 `BACKUP_NOT_FOUND`（**非 403**——防存在性探测） | 任意 |
| delete | 仅自己（同上） | 任意 |
| chunk/commit | 仅自己 uploading 档 | 同现状 |

**保留策略**：`trimOldBackups` 按 owner 分组各自裁旧（每 owner 10 档，全局 `backupMaxKeep` 共值；per-owner 配额留后续）。

**协议契约**（packages/tianshu-protocol backup-contract）：`BackupMeta` 加 `owner: string`（必填）；`BackupCreateRequest` **不加** owner（服务端鉴权注入，客户端自报字段一律忽略）；新增 claim/invites/clients 三组 DTO。

## 4. 桌面端改动（最小面）

- `ConnectionConfig` 加可选 `backupToken?`：主机页连接编辑表单加「备份专用 token（可选）」输入；`BackupClient` 构造优先 `backupToken ?? token`（解决双身份冲突）
- **申领入口**：主机页连接编辑处「申领备份身份」——输入邀请码+设备名 → IPC `backup:claim`（handler 以连接 baseUrl+token 调 claim 端点）→ 成功后 clientToken **自动写入该连接 backupToken 字段**（零手填）
- BackupGroup：列表行 owner 徽标（admin 视角区分各档归属）；admin 上下文显示「邀请码管理」小节（生成/复制/撤销/状态列表）与「客户端管理」（list/踢除）
- i18n zh-CN/en-US 同步

## 5. 测试与执行方式

- **server**（jest）：guard 三态识别（client 命中/admin 两源/401/claim 豁免）；claim 原子核销（并发同码一次成功）+ NAME_TAKEN + INVALID；service 按 owner 过滤全套（list/download/delete 他人档 NOT_FOUND/trim 分组裁旧/create 注入+自报忽略）；旧档 `__admin__` 兜底；邀请码 CRUD；注册表 sha256 存验（明文不落库）
- **桌面**（vitest）：BackupClient backupToken 优先级；ipc claim 通道（成功写回连接/失败透错）；契约 owner 字段编译期断言
- **执行方式**：spec/plan 文档提交 main；**代码批走 git worktree 隔离分支实施**（用户 2026-10-28 裁定：默认 worktree，仅明示才走 main），完成后按流程合回
- 真机验收：邀请码申领全流程（admin 生成 → 客户端申领自动填 token → 备份互不可见 → 保留额互挤验证 → admin 全局视图）

## 6. 非目标（留档）

- 复用 server JWT 用户体系（会话语义不搭，用户裁定 token 路线）
- per-client 保留配额（全局共值够用）、邀请码有效期、备份内容加密
- 恢复他人档的内容级防护（NOT_FOUND 隔离已挡；admin 恢复任意档属运维预期）
- 移动端

## 7. 风险

- claim 原子核销并发窗口——注册表 option 表读改写需互斥（单进程内存锁即可，server 单进程先例 backup.service cursor Map）
- 桌面端申领自动写回连接配置——连接保存通道复用 server 域既有 save（option 表持久化），注意备份域不越过 server 域直接写（经注入回调）
- 旧档 `__admin__` 兜底为读取期判定（不回写盘）——list 每次现算，量级 <10 档无性能顾虑
- admin 上下文 token 双源（BACKUP_TOKEN 或 TIANSHU_TOKEN）判定顺序：BACKUP_TOKEN 设置时优先且 TIANSHU_TOKEN 拒（现状不变）；两源同时命中不可能（值不同则 BACKUP_TOKEN 胜，同值无语义差）

## 8. 实施偏差留档（终审补记 2026-10-28）

- **claim 实为单要素一次性邀请码**（§2 原文「两要素」=大门 token + 邀请码）：实施落定为单要素——claim 端点对大门 token 两层均豁免（StaticTokenGuard `backup/` 前缀豁免 + BackupGuard claim 路径豁免），仅凭邀请码自鉴权。安全性依据：生成字符集 31 字符 ×8 位≈8.5e11 组合空间、核销即死，网络爆破不可行；大门 token 豁免为有意放宽（未设 TIANSHU_TOKEN 的部署也能申领），终审复核维持该裁定。
- **申领入口落设置面板「数据备份」小节**（§4 原文「主机页连接编辑处」）：功能等价——同一 IPC `backup:claim`、成功后 clientToken 同样自动写回连接 `backupToken`，仅 UI 挂点不同。设置面板已持连接下拉与备份列表上下文，申领后视图（申领小节隐藏、列表 viewer 刷新）即时收敛，免主机页连接表单改造。
