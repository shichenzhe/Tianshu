# 被控面 session/query 全表扫描优化批设计 spec

日期：2026-10-26
状态：直接开工（事实面已核实，Explore 盘定）
关联：[[user-rulings-2026-10-26]]；[[tianshu-face-query-db-pagination-deferred]]（用户裁定单独批之兑现）

## 0. 事实基线

- **face 短路**：`handleQuery`（`electron/domains/server-face/routes.ts:194-251`）先调 `listAllSessionsSummarized(userId)` 对全部 U 个会话做末消息+未读批量聚合，再内存过滤（workspaceId/keyword/activityAfter/archived）+ 内存 slice 分页。非 keyword 主路径也全量——移动端每翻一页、桌面远程每拉 500 条页都重复全量聚合。
- **无头端已优**：无 keyword 时条件下推 + DB skip/take + count，仅当前页 enrich（`session.repository.ts:188-204`）；keyword 时下推其他条件取候选集内存精确过滤（`206-215`），仅当前页 enrich。
- **keyword 契约**：大小写敏感 `includes`——SQLite Prisma contains 大小写不敏感，故两端都内存过滤（`session.repository.ts:166-175` 留档）；本批保契约不变。
- **不可破坏的调用语义**：本地 IPC `session:listAll`（`session.repo.ts:150-152`）与桌面 UI `SessionApi.listAll()` 需要全量语义；远程桌面 `remoteListAll` 按 500 条/页拼全量（最多 200 页）。`listAllSessionsSummarized` 全量语义保留。
- **unread/lastMessage 聚合非 N+1**：两条 groupBy + 一次批量 findMany（`session.repo.ts:608-660`），只是 face 的聚合范围是 U 而非 P。
- **索引现状**：session 只有 userId/workspaceId/projectId 单列索引；message 有 sessionId/createdAt。unread 聚合 `role=assistant` 可能受益 `(sessionId,role,id)` 复合索引。

## 1. 本批裁定（方案 A：face 专用分页查询）

1. **repo 新增 `querySessions(params, userId)`**（`session.repo.ts`）：
   - where 下推 `userId + workspaceId? + archivedAt 形状 + activityAfter OR 形状`——照搬无头端 `session.querydecoder.ts:51-66` 语义，保两端同行为（lastMessageAt gte since OR (lastMessageAt null AND updatedAt gte since)）；
   - 排序固定三键（pinnedAt desc/lastMessageAt desc/id desc）与现状一致；
   - **非 keyword**：`findMany(skip/take) + count`，随后仅对当前页 enrich（复用现有批量 enrich 内部步骤 fetchLastMessages+countUnreadBySessions，抽成可传 ids 的私有/公开方法）；
   - **有 keyword**：下推其余条件取候选集（findMany where+orderBy 不带 skip/take），内存 `(title ?? "").includes(keyword)` 精确过滤（大小写敏感保契约），`total=filtered.length`，内存 slice 分页，仅当前页 enrich。
2. **face handleQuery 切换**调 `querySessions`；`listAllSessionsSummarized` 与 `listAllSessions` 不动（本地 IPC 全量语义保留）。
3. **分页协议不变**：`{page,pageSize,records,total}`，pageSize 1~500 上限保持。
4. **索引验证（本批实测裁定）**：对默认列表与 unread 聚合跑 `EXPLAIN QUERY PLAN`——`message(sessionId)` 若已覆盖 MAX(id) 与游标范围则不加索引；若 role 过滤致全扫则加 `message(sessionId,role,id)` 复合索引，走 v15 新升级脚本（不动 v1 快照指纹）+ 无头端 ensureDatabase 幂等 DDL。验证结论写进提交信息。
5. **不做**：cursor/keyset 分页（深页协议扩展另批）；无头端重构（已优，不碰）；keyword 大小写语义变更。

## 2. 测试与验收
- repo：`querySessions` 真库用例——非 keyword 下推断言（where 形状钉测试可经 Prisma 查询检查或行集语义断言）、仅页 enrich（unread/lastMessage 只含当前页）、keyword 大小写敏感、activityAfter 双分支（有 lastMessageAt / null 回退 updatedAt）、分页边界（page 越界空页、total 正确）。
- face routes：query 用例改走新方法的替身断言；既有 220+ 钉测试零红。
- EXPLAIN QUERY PLAN 结果记录。
- 根 typecheck + prettier + 全量测试绿；分提交。

## 3. 风险
- enrich 复用重构若改变 listAllSessionsSummarized 行为会破本地 IPC——重构时保持其调用结果逐字节同形，既有 session-repo 测试钉死。
- activityAfter OR 形状在无头端与 face 两端须同语义——用例对同一数据集跑两端断言一致（或至少 mirror 侧钉死形状）。
