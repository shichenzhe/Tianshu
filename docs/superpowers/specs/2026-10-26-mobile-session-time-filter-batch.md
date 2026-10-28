# 移动端会话时间筛选批（A11）设计 spec

日期：2026-10-26
状态：调研完成（Explore A8–A11 合并摸底），按最小增量实施
关联：差集 spec `2026-10-25-mobile-desktop-gap.md`（A11 条目，已修正「纯前端」判断：分页语义下客户端过滤不完整，归协议扩展）

## 0. 调研关键发现

- **桌面被控面 `session/query`**：入参仅 `{page,pageSize,keyword,workspaceId,archived}`，先全量取（`listAllSessionsSummarized`）再内存过滤（workspaceId→keyword 大小写敏感 includes→archived）最后分页；排序 `pinnedAt DESC→lastMessageAt DESC→id DESC`。
- **无头端 `session/query`**：DTO `{workspaceId,keyword,archived}`+继承分页；DB 条件仅 workspaceId/archivedAt，keyword 特意内存过滤（有/无 keyword 两条路径）；显式 `sorts` 可覆盖默认序（Swagger 未暴露）。
- **桌面 FilterPopover 时间口径**：选项 all/today/week/month；字段 `lastMessageAt ?? updatedAt`；**滚动窗非自然周月**——today=本机今日 00:00、week=此刻-7 天、month=此刻-30 天，阈值含边界（`session-list.ts:30-49`，回归测试钉死）。
- **移动端两处请求组装**：主列表（sessions.store:254-265）与 workspace 组懒加载（:348-365）各自拼参——**时间参数必须同步覆盖两处**；UI 无 FilterPopover，搜索面板内有「未归档/全部」文本筛选钮（chats-header-actions.tsx）。
- **SDK 契约钉测试**：sdk-contract.spec 两处字段清单钉 `{page,pageSize,workspaceId,keyword,archived}`（:112-118,224-229）——加参数必须同步。
- 时区一致性陷阱：筛选值若在服务端生成，被控端与控制端时区不一致即错位——**必须由客户端算好阈值上送**。

## 1. 本批裁定

### 1.1 协议最小增量（零新端点）
`session/query` 增加可选 **`activityAfter?: string`（ISO 8601，客户端按本机时区计算的滚动窗阈值）**：
- 语义：`会话活动时间 >= activityAfter` 才入选；活动时间 = `lastMessageAt ?? updatedAt`（与桌面侧栏同口径）。
- 客户端口径（与桌面 FilterPopover 完全对齐）：today=本机今日 00:00；week/month=**锚定本机当日 00:00 回溯 7/30 天**（桌面 `filterSessionsByTime` 代码与其回归测试实测口径，非「此刻-7 天」字面——spec 初稿措辞已按代码修正）；all=不传参。阈值含边界（>=）。
- 不改排序、不动 keyword 大小写敏感现状（另批）。

### 1.2 双端实现
- **桌面被控面**（routes.ts handleSessionQuery）：内存过滤链在 archived 前插 activityAfter 过滤（`new Date(lastMessageAt ?? updatedAt) >= new Date(activityAfter)`，畸形时间串按 5000 参数不合法拒）。
- **无头端**：activityAfter 下推到 DB where（含 keyword 内存路径——两条路径都在分页前生效）。Prisma 表达：`OR: [{lastMessageAt: {gte: since}}, {AND: [{lastMessageAt: null}, {updatedAt: {gte: since}}]}]`。DTO 显式校验 ISO 可解析（class-validator `@IsOptional() @IsDateString()`）。
- 两端错误口径一致：activityAfter 存在但不可解析日期 → 4000/5000 参数不合法（跟随各端现有参数错误码惯例）。

### 1.3 移动端
- **store 两处组装点**同参：主列表 + workspace 组懒加载都带 `activityAfter`（选中非全部时）。
- **UI**：搜索面板内「未归档/全部」同排（或紧邻行）加时间筛选钮组：全部/今天/本周/本月（i18n 双语）；选中态主色调高亮；切换重拉首屏并清组缓存（照归档切换先例 index.tsx:375-383）。
- 纯滚动窗计算逻辑收 `src/logic/session-time-filter.ts`（与桌面 session-list.ts 同口径注释声明双份义务）+ 钉测试（today 零点边界/week=7d/month=30d/时区本地性）。

### 1.4 非目标
自然周/自然月口径（桌面也非此口径，不造分歧）；keyword 归一化；无头端 sorts 入 Swagger。

## 2. 测试与验收
- 桌面：routes.test 增 activityAfter 过滤用例（边界含/不含、坏时间串报错、与 keyword/archived 叠加）。
- 无头端：session.spec 增 DB 下推用例（两路径：无 keyword DB 分页路径、有 keyword 内存路径；lastMessageAt null 回退 updatedAt）；sdk-contract 两处字段清单同步；`sdk:generate` 重出。
- 移动端：logic 钉测试 + store 组装断言（两处带参/全部时不带参）；既有 407 例零红。
- 根 typecheck + 双仓全量绿；分提交。

## 3. 风险
- **时区**：客户端算阈值是唯一正确解（被控端时区不可信）；两端比较一律 ISO 解析后 >=。
- **全表扫描未解**：activityAfter 在桌面 face 仍是内存过滤（全量取列表的既有形态，用户已裁定扫描优化另批）；无头端本批顺势下推 DB where，扫描面不劣化。
