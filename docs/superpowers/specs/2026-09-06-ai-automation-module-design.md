# AI 自动化与定时任务模块设计

> 上游:PRD《AI 自动化与定时任务模块》+《自动化任务执行频率配置模块》。
> 核心决策:主进程独立 `automation` 子域,结构化 JSON 调度自算(零 cron 依赖),
> 复用 `runChatStream` 纯函数无人值守执行,产物落 session 可回看。

## 0. 已确认的产品决策(澄清结论)

| 问题 | 结论 |
|------|------|
| 任务来源「本地/项目/云端」 | 云端无服务端支撑,v1 仅 UI 预留分类(永远 0);本地/项目由所绑 workspace 是否有 `directoryPath` 派生,无独立 scope 字段 |
| 执行链路 | 在绑定 workspace 下新建 session,agent 模式跑一轮完整对话;产物(消息/工具调用/耗时)落 session/message,运行记录关联 sessionId 可跳回聊天回看 |
| 无人值守审批 | 创建时声明「允许完全访问」,执行时 `fullAccess=true`、`requestApproval=async()=>true` 跳过审批,表单红色警示 |
| 模板来源 | 后端内置 `automation-templates.ts` 6~8 个(先例 `builtin-skills.ts`),不走远端 |
| 调度存储 | 结构化 `scheduleJson`(cron 表达不了双周/间隔模式,自算零新依赖,`cron-parser` 方案作废) |
| 错过触发点 | 任务级 `missedPolicy` 字段:skip(默认,落 skipped 记录)/ catchUpOnce(补跑一次,多次错过只补最近一次) |
| 模型与参数 | 任务显式绑定 `modelId`(默认取 workspace defaultModelId);参数三档预设:精确 0.2 / 均衡 0.7 / 创意 1.0 |

## 1. 架构(方案 A:独立子域)

```
electron/domains/ai/automation/
├── automation.repo.ts        # Prisma 仓储 + ipcMain.handle(CRUD/启停/模板/运行记录/埋点)
├── automation-scheduler.ts   # 30s tick 决策树 + 重试扫描 + 生命周期(start/stop)
├── automation-runner.ts      # 单次执行:校验→建 session→变量替换→runChatStream→落库
├── automation-templates.ts   # 内置模板数据(slug/icon/title/description/prompt/scheduleJson/temperature)
└── automation-stat.ts        # 埋点落库(照 skill-stat 先例)

src-react/domains/ai/automation/
├── api/automation.api.ts     # invoke 封装 + 类型(TaskRecord/RunRecord/TemplateRecord)
├── store/automation.store.ts # zustand:tab/来源筛选/状态筛选/搜索词/多选态
├── lib/schedule-text.ts      # scheduleJson → 自然语言(摘要栏与列表行同一实现)
├── views/AutomationView.tsx  # 壳(重写占位页):Tab + 工具栏 + 视图切换 list|market
├── views/TaskListView.tsx
├── views/RunHistoryView.tsx
├── views/TemplateMarketView.tsx
├── components/CreateTaskDialog.tsx   # 创建/编辑共用 Modal
├── components/SchedulePicker.tsx     # 频率配置(周期/间隔双模式,§4)
├── components/FilterMenu.tsx
└── components/TaskRow.tsx
```

chat 域唯一改动:`ChatStreamResult` 增加可选 `usage: { promptTokens; completionTokens }`
(从 SDK streamText 透出,现有调用方不受影响)。

已否决:执行器并入 `chat.service.ts`(1400+ 行职责混杂);渲染进程调度(窗口关即停)。

## 2. 数据模型(v10)

`prisma/schema.prisma` + `electron/infrastructure/script/v10/upgrade-table.sql` 双轨,
`Constants.ts` `DATABASE_VERSION` 9→10。SQLite 无外键(`relationMode="prisma"`),级联删
由 repo 事务内应用层完成。

```prisma
model automationTask {
  id           Int       @id @default(autoincrement())
  name         String
  prompt       String    // 支持 {{date}}/{{weekday}}/{{time}} 运行时替换
  workspaceId  Int       // 必选;本地/项目归属由 workspace.directoryPath 派生
  modelId      Int       // 显式绑定
  temperature  Float?    // 预设映射值
  scheduleJson String    // zod discriminated union,见 §3
  scheduleText String    // "每天 09:00",创建时生成,运行时不反解析
  startAt      DateTime? // 有效期开始;空 = 立即生效(now < startAt 时任务不调度)
  endAt        DateTime? // 有效期结束;空 = 长期有效(单次执行点是 scheduleJson.runAt,与此独立)
  missedPolicy String    @default("skip")  // skip | catchUpOnce
  enabled      Boolean   @default(true)    // 用户开关
  status       String    @default("active") // active | error | expired
  statusNote   String?   // 异常原因(workspace_missing / model_missing / interrupted)
  lastRunAt    DateTime?
  nextRunAt    DateTime? // 调度游标,<= now 即到期
  templateSlug String?   // 来源模板;自定义创建为空
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
}

model automationRun {
  id               Int       @id @default(autoincrement())
  taskId           Int
  sessionId        Int?      // 产出的会话;skipped 时为空
  attempt          Int       @default(1)  // 1~3
  triggerType      String    // schedule | catchUp | retry
  status           String    // running | success | failed | skipped
  durationMs       Int?
  promptTokens     Int?
  completionTokens Int?
  error            String?   // 错误分类码(classifyError)+ 摘要
  startedAt        DateTime  @default(now())
  finishedAt       DateTime?

  @@index([taskId])
  @@index([startedAt])
}

model automationStat {
  id        Int      @id @default(autoincrement())
  event     String   // create
  detail    String   // JSON: { mode, kind, hasEndAt, tabSwitchCount }
  createdAt DateTime @default(now())
}
```

要点:
- **`enabled` 与 `status` 分离**:enabled 是用户开关(「已暂停」),status 是系统状态
  (workspace/模型失效 → error 并自动 enabled=false;到期/单次完成 → expired)。
  PRD「已暂停」即 `enabled=false`,运行中即 `enabled=true && status=active`。
- **重试不靠内存**:tick 时查 DB「最近 run 为 failed 且 attempt<3 且 finishedAt 早于
  now-60s」,重启安全。

## 3. 调度存储:结构化 scheduleJson

zod discriminated union,`scheduleText` 创建时由 `schedule-text.ts` 生成存库:

```ts
// 模式一:周期(Periodic)——PRD《执行频率》§3.1 六粒度
{ mode: "periodic", kind: "once",     runAt: string }                          // 跑完 expired
{ mode: "periodic", kind: "daily",    time: "09:00" }
{ mode: "periodic", kind: "weekly",   weekdays: number[], time: "18:00" }      // 星期多选
{ mode: "periodic", kind: "biweekly", anchorDate: string, weekday: number, time: "10:00" }
{ mode: "periodic", kind: "monthly",  dayOfMonth: number, time: "09:00" }      // 当月无该日跳过
{ mode: "periodic", kind: "yearly",   month: number, day: number, time: "23:59" } // 2/29 非闰年跳过
// 模式二:间隔(Interval)——PRD《执行频率》§3.2
{ mode: "interval", value: number, unit: "minute" | "hour", weekdays?: number[] } // 可选星期筛选,最小 5 分钟
```

`computeNextRun(schedule, from: Date, lastRunAt?: Date): Date | null` 纯函数
(date-fns,不引入 cron-parser):

- once:runAt 本身,已过则 null;
- daily:from 起下一个同刻;
- weekly:星期多选集合中最近的下一个匹配时刻;
- biweekly:anchorDate + 2k 周的下一个未来点(保持相位);
- monthly:下一个含该日的月份(无 31 号则跳过当月);
- yearly:下一年同月日(2/29 非闰年跳过);
- interval:以 lastRunAt(缺省 startAt/创建时刻)为相位基准累加 value 单位直到 > from;
  落在 weekdays 之外的星期 → 顺延至下一个允许星期 00:00(相位基准同步重置)。

## 4. 调度器与执行链路

### automation-scheduler.ts

- **生命周期**:`Application` DB 就绪后 `start()`(记录 `processStartTime`,并把遗留
  `running` 的 run 全部置 failed(`interrupted`)——防崩溃后运行记录永久悬挂);
  app 退出前 `stop()`(abort 全部在途执行)。
- **tick(30s)决策树**(对每个 `enabled=true, status=active` 任务):

```
0. now < startAt(未生效)        → 跳过本 tick
1. endAt < now                    → status=expired,结束
2. kind=once                      → runAt<=now 且从未跑过 → 执行(schedule);跑过 → expired
3. 循环任务 nextRunAt<=now:
   a. lastRunAt >= nextRunAt          → 该触发点已执行,仅推进 nextRunAt
   b. nextRunAt >= processStartTime   → 正常触发(延迟≤30s)→ 执行(schedule)
   c. nextRunAt <  processStartTime   → 应用未开期间错过:
        missedPolicy=catchUpOnce → 执行(catchUp)
        missedPolicy=skip        → 落 run(status=skipped),推进 nextRunAt
4. 重试扫描:最近 run failed 且 attempt<3 且 finishedAt < now-60s
   → 执行(retry, attempt+1);attempt=3 仍失败则终止
```

- 3c 判据「nextRunAt 早于 processStartTime」确保进程内 30s 延迟不被误判为错过;
  catchUpOnce 只执行一次即推进 nextRunAt,天然满足「多次错过只补最近一次」。
- **互斥**:内存 `Map<taskId, AbortController>` 防同任务并发;不同任务并发执行
  (纯网络 IO)。
- 执行/过期/异常后 `webContents.send("automation:tasks-changed")` 通知渲染层。

### automation-runner.ts 单次执行

1. 落 run(`status=running`, triggerType, attempt);
2. 校验 workspace / model 仍存在 → 失效:task `status=error, enabled=false`,
   run 落 failed(`workspace_missing` / `model_missing`);
3. 创建 session(workspaceId, `title=任务名`, `mode="agent"`);
4. 变量替换:`{{date}}`→当天日期、`{{weekday}}`→星期、`{{time}}`→当前时间;
5. 组装 `ChatStreamOptions` 调 `runChatStream`:`history=[user 消息]`,
   `agent: { sessionId, workspacePath, fullAccess: () => true,
   isToolAllowed, requestApproval: async () => true }`,`onChunk` 不传(静默,
   不经渲染层);
6. 产物落 assistant message(blocks 含工具调用与耗时,durationMs);
7. 更新 run(success|failed + durationMs + usage tokens + sessionId + finishedAt)、
   task.lastRunAt / nextRunAt(computeNextRun 推进)。

「云端在线检测」对应:应用没开 = 错过策略(§4 3c);开着但断网 = AI 调用失败走重试。
不做额外心跳。

## 5. 前端视图与交互

**数据流**:React Query 全量拉任务(`["automation","tasks"]`),来源/状态/搜索全部前端
store 过滤(SQLite 数据量小),分类计数由过滤结果派生;运行记录
`["automation","runs", page]` 分页(20/页)。收到 `automation:tasks-changed` 即
invalidate。

**AutomationView 工具栏**:Tab「定时任务(默认)/运行记录」| 右侧:漏斗筛选
(DropdownMenu:全部/本地/项目/云端,选中项绿色对勾 + 分类计数)、搜索框(防抖
300ms 按名称)、刷新、批量管理(仅任务 Tab)、「添加自动化」主按钮(DropdownMenu:
自定义创建 / 从模版添加 → market 视图)。

**TaskListView**:
- 顶部状态过滤 pill(全部/运行中/已暂停/异常/已过期,对应 PRD「状态标签」);
- 行:名称加粗 | 归属灰字(`项目 · {workspace名}` / `本地`)| scheduleText |
  右侧 Switch 启停 + 状态 Badge(异常/已过期警示色);
- 行主体点击 → `CreateTaskDialog` 编辑模式;
- 批量管理:行前 checkbox,工具栏变体(全选 + 红色删除 + 已选 N 项 + 退出管理),
  删除走 AlertDialog 二次确认,后端事务连带删 run;
- 空状态:缺省图 + 「暂无定时任务」+「去创建」。

**RunHistoryView**:列 = 触发时间、任务名、触发方式(定时/补执行/重试)、耗时、
状态(成功/失败/跳过)、Token 消耗(输入+输出);行点击且 sessionId 有值 → 跳转
聊天并选中会话(复用现有会话选中机制);空状态「暂无运行记录」。

**TemplateMarketView**:AutomationView 第二视图态(带返回箭头),双列卡片
(图标/标题/描述);点击 → `CreateTaskDialog` 预填模板 prompt/scheduleJson/temperature
(模型默认取所选 workspace 的 defaultModelId),补齐工作空间后提交。

**CreateTaskDialog**(创建/编辑共用):名称 | Prompt 多行框(左下 `+` 弹菜单插入
`{{date}}/{{weekday}}/{{time}}`) | 模型选择器 + 参数三档预设 | 工作空间下拉(必选) |
红色警示「⚠ 允许完全访问:该任务将跳过工具审批自动执行」 | SchedulePicker |
取消/确定(校验不过置灰)。

**SchedulePicker**(PRD《执行频率》§2.1 三层级):

```
┌ [周期] [间隔]  ← Tab(切换次数计入埋点 tabSwitchCount)
│  周期: 粒度下拉(单次/每天/每周/双周/每月/每年)
│       → 联动:单次=日期+时间 / 每天=时间 / 每周=星期多选+时间
│         / 双周=起始日期+星期+时间 / 每月=几号+时间 / 每年=月日+时间
│  间隔: 星期多选标签组(可选) + 数字输入 + 单位下拉(分钟/小时)
├ 有效期: 长期有效 | 自定义时间段(开始/结束日期)
└ 摘要栏: 实时自然语言("每周一、五 18:00 · 长期有效")或「请完善时间配置」
```

校验(阻断确定):单次 runAt / 自定义 startAt 必须 > 当前时间;间隔 ≥ 5 分钟;
联动控件必填完整。日期控件用现有 shadcn/ui(Popover + Calendar + 时间输入),
缺则补最小实现。

**i18n**:文案走 `chat` namespace 新增 `automation.*` 段,zh-CN/en-US 同步。
**埋点**:提交成功时上报 create 事件 `{ mode, kind, hasEndAt, tabSwitchCount }`
(一条覆盖 PRD 三项统计:频率分布/模式切换率/有效期设置率)。

## 6. IPC 契约(automation.repo.ts 注册)

```
automation:list          → TaskRecord[](含派生 source: local|project)
automation:create / update / delete(batch) / toggle(id, enabled)
automation:templates     → TemplateRecord[]
automation:runs:page     → { total, items: RunRecord[] }
automation:stat          → 埋点上报
automation:tasks-changed → 主进程 → 渲染层事件
```

## 7. 异常处理汇总

| 场景 | 处理 |
|------|------|
| workspace 被删 | 执行前校验 → task error + enabled=false,run failed(workspace_missing),列表标「异常」 |
| 绑定模型被删 | 同上,run failed(model_missing) |
| AI 调用失败/断网 | 60s 后重试最多 3 次,每次各落一条 run(attempt 1~3),classifyError 分类 |
| 应用未开错过触发点 | missedPolicy:skip 落 skipped / catchUpOnce 补跑最近一次 |
| 有效期到 / 单次跑完 | status=expired,调度跳过 |
| 应用崩溃 run 卡 running | scheduler.start() 时全部置 failed(interrupted) |
| 表单防呆 | 时间倒流校验 / 间隔 ≥5 分钟 / 必填完整,确定置灰 |

## 8. 测试策略(Vitest,聚焦纯函数)

- **computeNextRun(最重点)**:各 kind 常规推进 + 跨日/跨周多选集合/biweekly 相位/
  月末无 31 号跳过/2-29 非闰年/interval 相位保持与星期顺延/once 到期判定;
- **错过判定**:nextRunAt 与 processStartTime 三分支 × 两种 missedPolicy;
- **schedule-text**:结构 → 自然语言快照;
- **store 过滤**:来源/状态/搜索组合;
- 运行 `npm run test`,沿用现有测试基建。
