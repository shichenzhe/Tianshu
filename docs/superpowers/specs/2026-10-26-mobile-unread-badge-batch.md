# 移动端未读角标批（P1）设计 spec

日期：2026-10-26
状态：调研完成（Explore 七项落地事实清单），按最小增量方案实施
关联：差集 spec `2026-10-25-mobile-desktop-gap.md`（P1 条目）；A1 provider/save 掩码范式、A5/A7 三段式先例；HD 批单 UI 多主机遥控通道

## 0. 调研关键发现（裁定依据）

- **session 表无 lastReadMessageId**，message 消息体列是 `blocks`（JSON 数组文本）不是 `content`；桌面 DB v1 未发布可直接改快照，但 **v1 hash 变化会触发 snapshot-guard 重置开发库**（drop 全部业务表重建）——「存量回基线 SQL」只对保留库有意义，桌面开发库实际走重置。
- **无头端已有非空 SQLite 不会自动 `prisma db push`**（仅缺库/0 字节时建库）——schema 加列对已有库不生效，须单列升级路径。
- **桌面/无头 session.updated 各有三条生产链**（send/regenerate/editAndResend 完成钩子），ChatService 本身不发布 session.updated；发送类事件必须在最终 assistant 消息落库后计算动态字段。
- `@tianshu/core` 已有 `parseBlocks/serializeBlocks` 纯函数，**但没有末条摘要规则**——混合块 kind 优先级/摘要文案无先例可抄，本 spec §1.3 裁定。
- **session/query 无独立 serializer**：桌面 `listAllSessions` 直接返回 Prisma 行；无头端 query 直接返回 repository 结果。动态字段（unreadCount/lastMessage）必须显式 enrich，不能冒充 row 字段。
- 桌面**会话列表当前无最后消息预览**；移动端 SessionRow.summary 传的是 workspace 组名不是消息摘要——lastMessage 摘要是新能力。
- **ENDPOINTS.session 进共享表即触发无头端 SDK 契约测试**（sdk-contract.spec 遍历 session 组要求 POST 实现）——controller/OpenAPI/sdk:generate 必须同批。
- `session/read` 无路由冲突；`server-face.test.ts:409-453` 对 session.updated payload **精确相等断言**，扩 payload 必须同步 fixture；无头端 session-send.spec 有 SSE 精确帧断言同理。
- 移动端 `toBrief` 是显式裁剪（新字段会被静默丢弃）；**成功 `loadHistory` 是 read 上报最佳位置**（拿到真实 message id，覆盖初次打开/finish 后重拉/重连重拉）；桌面 RemoteSessionEvent/remote-session.ts 显式投影须同步透传防类型漂移。

## 1. 本批裁定

### 1.1 数据模型：单游标 + 查询期动态计算

- **session.lastReadMessageId Int?** 单游标（双端 schema 同改；桌面 v1 快照同步；无头端 standalone schema 由构建链重新生成，不当手工事实源）。
- **不冗余计数列**：unreadCount 查询期动态算；不持久化 lastMessage 摘要。
- **未读口径**：`count(message) where sessionId=? and role="assistant" and (lastReadMessageId is null or id > lastReadMessageId)`。游标取全角色 max(message.id)，只有未读计数过滤 assistant——「末条消息」与「未读过滤」是两套条件，禁止混用。
- **实例级共享已读**：被控端单用户语义，不加设备/连接维度字段（多设备已读同步非目标）。
- **存量回基线**：`lastReadMessageId = 该会话 max(message.id)`，空会话保持 NULL。桌面开发库实际走 snapshot-guard 重置（v1 未发布，接受）；无头端已有 dev 库人工删库重建（伴生数据可弃）；spec 记录基线 SQL 作为保留库升级口径。**本批不写 vN migrate 脚本**（v1 未发布，加列直接并入快照；发布后 schema 变更才走 vN 流程）。

### 1.2 协议最小增量（@tianshu/protocol）

```ts
/** 会话末条消息摘要（wire 契约——kind 映射展示文案在消费端本地化，
 *  text 只承载语言中立内容） */
interface SessionLastMessage {
  id: number;
  role: string;
  kind: "text" | "image" | "tool" | "empty";
  /** text=文本块拼接截断；tool=首个 tool_call 的 toolName；image/empty="" */
  text: string;
  createdAt: string; // ISO
}
```

- `ENDPOINTS.session.read: "session/read"`（session 组第 13 段）。
- `session.updated.payload` 扩展：`unreadCount: number`、`lastMessage: SessionLastMessage | null`（保留现有 id/title/updatedAt；**read 提交后复用本事件清角标，不新增事件类型、不伪造 updatedAt 上浮**）。
- `session/query.records[]` 扩 `unreadCount` + `lastMessage`（断线期间事件丢失的兜底靠 server.connected 全量重拉——所以查询面必须带同口径动态字段）。
- 列表响应**不暴露 lastReadMessageId**（角标只需 unreadCount/lastMessage；read 响应回游标即可）。

### 1.3 摘要纯函数（@tianshu/core 新增，无 I/O）

`summarizeLastMessage(input: { id; role; blocks; createdAt }): SessionLastMessage`，基于既有 `parseBlocks`：

- **kind 优先级**：text > image > tool > empty（text 信息量最大优先；不是块顺序优先）。
  - text：全部 text 块文本 `\n` 拼接，截断 80 字符加省略号（`SUMMARY_TEXT_LIMIT`）；无 text 块落到下一级。
  - image：kind=image，text=""（消费端本地化「[图片]」）。
  - tool：kind=tool，text=首个 tool_call 块的 toolName。
  - empty：有消息但无可摘要块（如仅 thinking/usage）→ kind=empty，text=""。
- thinking/usage 块不参与摘要。
- 坏 JSON/非数组/全畸形块 → parseBlocks 已回 [] → empty。
- 纯函数测试覆盖全部边界（空/坏 JSON/text/image/tool/混合优先级/thinking-only/截断）。
- 桌面 Prisma 行 → 摘要的 enrich 在 repository 层做（需读末条 message 行）；**渲染端 blocks 双份不动**（摘要在 core 单份，双份 blocks 段零改动，drift 不增）。

### 1.4 session/read 端点（双端同批）

- 请求 `{sessionId, messageId}`；响应 `{sessionId, lastReadMessageId, unreadCount}`。
- 语义：归属校验（session 属当前实例用户；message 存在且 sessionId 匹配）；**单调推进**——更大 id 写入，更小/相等幂等成功不回退；并发安全（不能「读旧值后无条件写回」，用 `updateMany where id/messageId > 当前游标` 或等价条件写）；成功后按新游标算 unreadCount 并 **publish session.updated（enriched 口径，updatedAt 保持库值）**。
- 输入校验：显式整数校验（无头端全局 ValidationPipe 未开 whitelist，DTO 须自带 @IsInt 等）。

### 1.5 双端查询面 enrich

- 新返回类型（不冒充 Prisma row）：如 `SessionSummaryRecord = SessionRecord & { unreadCount; lastMessage }`。
- 实现：列表分页取出 session ids 后两条聚合查询——①`groupBy(sessionId) _max(id) where id in (ids)` 取每会话末条 message 行（再批量 fetch 行 + 逐条 summarizeLastMessage）；②`groupBy(sessionId) _count where role=assistant and id>cursor and id in (ids)`。一次列表两条聚合，禁 N+1。
- 桌面：`listAllSessions` 保持原样（本地 IPC 面不动），新增 `listAllSessionsSummarized(userId)` 供被控面 session/query 使用；`session.updated` 三条生产链（send/regenerate/editAndResend）改发 enriched payload（复用同一 enrich 函数）。
- 无头端：session.service query 切 enriched 返回类型；dispatchRound/editAndResend/regenerate 三条完成链同理。
- **桌面遥控通道**：`src-react/domains/ai/server/api/server.api.ts` 的 RemoteSessionRow/RemoteSessionDetail + `data-source/remote-session.ts` 投影同步透传新字段（不加桌面 UI 角标，防 wire 类型漂移）。

### 1.6 移动端

- `SessionBrief`/`toBrief` 扩 `unreadCount`/`lastMessage`（一处投影覆盖首页/续页/workspace 组懒加载三来源）。
- `SessionRow` 角标：`unreadCount > 0` 时标题行右侧红点小计数（≥100 显示 "99+"）；有 lastMessage 时第二行展示摘要（kind 映射本地化前缀：图片/工具/空），替代现有相对时间或并列（按空间取舍，截断一行）。
- **read 上报**：成功 `loadHistory` 后取返回消息 max(id)，非空则 `session/read`；失败不改本地已读；read 响应/session.updated 同步主列表+workspace 组缓存。**不在路由跳转/mount 盲报**（空历史无真实 id、请求可能失败、停留期间 finish 重拉才覆盖新消息）；**服务端单调兜底迟到旧响应**。
- `session.updated` 消费投影扩 unreadCount/lastMessage（保留现有重排+未知 id 无副作用语义）。

### 1.7 非目标

桌面 UI 角标/预览（仅遥控通道透传）；app 图标通知角标（推送批另立）；多设备已读同步；按 workspace 聚合未读；已读回执进消息流。

## 2. 分层要点

- **协议包**：SessionLastMessage + ENDPOINTS.session.read + session.updated payload 扩展（server-event.ts）；钉测试同步；重建 dist。
- **core**：summarizeLastMessage 纯函数 + 测试；重建 dist（sync:core）。
- **桌面**：prisma schema + v1 快照 + Prisma 7 client 重新生成；session.repo enrich 方法 + 三条事件链改发 enriched；routes.ts session/read 路由 + FaceSessionError 码（SESSION_NOT_FOUND 复用既有码表）；server-face 测试 fake 与精确断言 fixture 同步；RemoteSessionEvent/remote-session.ts 透传。
- **无头端**：prisma schema（源码树）+ Prisma 6 client 重新 generate；session module read controller/service/repository + query enrich + 三条事件链；OpenAPI/SDK 生成物同批（sdk:generate）；升级路径文档（已有 dev 库删库重建）。
- **移动端**：SessionBrief/toBrief/SessionRow/sessions.store 事件投影 + stream.store loadHistory 成功后 read 上报 + i18n 新 key 双语。

## 3. 测试与验收

- 桌面：v1-fullschema 新列+幂等；blocks 摘要纯函数全边界；server-face routes（query enriched 形状/read 单调/归属/幂等/事件 payload）；server-face.test.ts 精确断言 fixture 同步。
- 无头端：session.spec（动态未读/末条摘要/read 单调/归属/幂等/并发不回退）；session-send.spec（send/regenerate/editAndResend 完成事件 + SSE 精确帧同步）；sdk-export/sdk-contract（session/read 进表即要求 POST 实现）；`npm run test -w apps/tianshu-server` 全绿 + OpenAPI 新鲜度。
- 移动端：sessions.store.test 扩 unread/lastMessage fixture + read 后清角标 + 组缓存同步 + 迟到旧响应不回退；SessionRow 角标渲染用例；既有 355+ 例零红。
- 根 typecheck + 双仓全量测试绿后分阶段提交。

## 4. 风险

- **v1 快照重置**：桌面开发库数据被 drop 重建（v1 未发布接受）；用户自定义数据根同样被重置——发布前清理预期内，spec 记录。
- **payload 扩展的精确断言面**：双端 SSE/事件 fixture 多处精确相等断言，漏改即红——测试清单 §3 已列全。
- **enrich 成本**：列表两条 groupBy 聚合，pageSize 上限 500 下可控；禁止 N+1 逐会话查。
- **read 竞态**：迟到旧响应经服务端单调推进兜底，客户端不依赖请求顺序。
- **SDK 契约**：ENDPOINTS.session.read 进共享表后无头端不实现即红——同批实现。
