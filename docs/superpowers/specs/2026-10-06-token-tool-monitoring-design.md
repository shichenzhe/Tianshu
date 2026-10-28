# Token 消耗与工具调用监控 · 设计文档

- 日期：2026-10-06
- 状态：已评审通过（方案 A：统一事件表）
- 范围：AI 模块全场景（chat / graph / automation）的 LLM token 用量与工具调用事件采集、聚合与展示

## 1. 背景与现状

### 1.1 数据现状（探索结论）

| 维度 | 现状 | 缺口 |
|---|---|---|
| Token 数据 | chat 每条 assistant 消息 `message.blocks` JSON 内含 `{type:"usage",input,output}`（`runChatStream` 从 `part.totalUsage` 解析）；图执行器 `extractTokenUsage` 已解析 LLM 节点用量进 `graphTrace`；`automationRun` 表有 `promptTokens/completionTokens` 列 | 分散三处，无跨会话/按模型/按时间的聚合视图；聚合需扫 blocks JSON 全表（H7a 已淘汰该查询模式） |
| 工具调用 | chat 的 `tool_call` 块有终态（done/denied/error）但无耗时；图 trace 有 `toolCalls: {name, ok, durationMs}`（适配器近似值） | 无工具级聚合（次数/成功率/平均耗时）；chat 侧缺 duration |
| 链路复用 | 自动化任务底层全部走 `runChatStream`（prompt 类）或 `executeGraphRun`（graph 类） | 埋点只需覆盖 chat / graph 两条链路，automation 场景自动纳入 |

### 1.2 复用先例

- 埋点事件表：`skillStat` / `automationStat`（fire-and-forget、catch + Log.warn 吞错、PrismaLike 结构子集注入可测）
- 聚合：`skill-stats.ts` / `automation-stats.ts`（SQL groupBy 下推 + 纯函数口径计算）
- 建表：`ensureArtifactTable`（`CREATE TABLE IF NOT EXISTS` + 索引幂等补建，不动 v1 快照指纹，避免旧库 drop 重建）；保留期裁剪 `ensureEventStatMaintenance`（90 天）
- 提取登记：H7a `artifact` 表（消息落库时提取产物，替代 blocks LIKE 全表扫）
- IPC：`handleUser("automation:stats", ...)` 模式，userId 从 token 解出，前端不传用户 id
- UI：`AutomationStatsPanel` 卡片风格（总览卡 + 7 天趋势 + 关注清单）

## 2. 方案裁定

- **方案 A（采纳）：统一事件表** —— 新增 `llmCallEvent`、`toolCallEvent`，采集点埋点 + SQL 下推聚合 + 独立监控页 `/module/ai/monitor`
- 方案 B（否决）：零新表扫 blocks/trace JSON 聚合 —— 与 H7a 性能演进方向相悖
- 方案 C（否决）：仅会话内上下文条 —— 已有 context-usage-button，不满足跨场景监测诉求

### 2.1 已裁定的假设

- 不做成本估算（模型无单价字段，不引入价格管理负担）
- 监控页为 AI 模块一级导航入口；入口位于 `GlobalSidebar.tsx` 的 `navEntries` 数组（全局侧边栏，与「自动化」等入口同列）
- `automationRun` 既有 token 列保持不动，事件表为聚合唯一来源
- 历史存量消息不回填事件表（从上线起算）
- 用户中止（abort）不算错误、不计事件，与 chat 流现有口径一致

## 3. 数据模型

### 3.1 schema（prisma/schema.prisma 追加）

```prisma
model llmCallEvent {
  id           Int      @id @default(autoincrement())
  userId       Int? // v12 多用户隔离
  scene        String // chat | graph | automation
  modelId      Int? // chat/automation 有；graph 场景恒 null（trace 无 modelId）
  sessionId    Int? // chat/automation 会话
  graphId      Int? // graph 场景
  inputTokens  Int
  outputTokens Int
  durationMs   Int? // 流式轮次耗时
  createdAt    DateTime @default(now())

  @@index([userId, createdAt]) // 聚合主查询路径
}

model toolCallEvent {
  id         Int      @id @default(autoincrement())
  userId     Int?
  scene      String // chat | graph | automation
  toolName   String
  state      String // done | denied | error
  durationMs Int?
  sessionId  Int?
  createdAt  DateTime @default(now())

  @@index([userId, createdAt])
  @@index([userId, toolName]) // 工具排行分组
}
```

### 3.2 建表与保留期

- 不走 v1 快照（快照 sha256 指纹变化会触发旧库 drop 重建）：照 `ensureArtifactTable` 先例，`electron/commons/prisma-client.ts` 新增 `ensureMonitorTables()`——两张表 `CREATE TABLE IF NOT EXISTS` + 上述索引幂等补建；`Application.execute` 里 `void ensureMonitorTables().catch(...)` 调用
- `ensureEventStatMaintenance` 扩展：两新表 90 天保留期 DELETE（与埋点表同口径）；**upgrade-table.sql 不做任何修改**——任何改动（含注释）都会翻转 v1 快照 sha256 指纹触发旧库重建，建表去向在 ensureMonitorTables 函数注释说明即可（skillStat/artifact 先例同）
- `npm run generate` 重生成 Prisma Client（`electron/generated/prisma`）

## 4. 采集链路

新模块 `electron/domains/ai/monitor/monitor-events.ts`：

```ts
export interface LlmCallEventInput {
  userId?: number;
  scene: "chat" | "graph" | "automation";
  modelId?: number;
  sessionId?: number;
  graphId?: number;
  inputTokens: number;
  outputTokens: number;
  durationMs?: number;
}
export interface ToolCallEventInput {
  userId?: number;
  scene: "chat" | "graph" | "automation";
  toolName: string;
  state: "done" | "denied" | "error";
  durationMs?: number;
  sessionId?: number;
}
export async function recordLlmCall(
  prisma: LlmCallPrismaLike | undefined,
  event: LlmCallEventInput,
): Promise<void>; // fire-and-forget；catch + Log.warn 吞错；prisma 缺席静默跳过
export async function recordToolCall(
  prisma: ToolCallPrismaLike | undefined,
  event: ToolCallEventInput,
): Promise<void>;
```

### 4.1 埋点位置（4 处）

| # | 位置 | 事件 | 数据来源与口径 |
|---|---|---|---|
| 1 | `ChatService` assistant 消息落库处（chat:send 流收尾） | llmCallEvent(scene="chat") | blocks 内 usage 块（无 usage 块不写：错误轮次/中止不产出 usage，与现状一致）+ modelId/sessionId/userId；durationMs 取消息落库时已计的轮次耗时（message.durationMs 同源）；H7a「落库时提取」同款 |
| 2 | `automation-runner` prompt 任务消息落库处 | llmCallEvent(scene="automation") | 同上，sessionId=ctx.sessionId、modelId=ctx.modelId、userId=task.userId |
| 3 | `runToolCall`（chat.service.ts） | toolCallEvent | running 前后 `Date.now()` 差值 durationMs；state 映射 done/denied/error（denied 含审批拒绝与各安全门强拒；aborted 不写）；scene 由各调用方 `toolStats` 闭包直接携带（chat="chat"、automation="automation"），不经 agent 字段；prisma 经 agent 新增可选字段注入（缺省不写，保持核心函数可测） |
| 4 | `executeGraphRun` 收尾（`sumTokens` 同处） | trace 中每个带 tokens 的节点一行 llmCallEvent(scene="graph") + 每个 toolCalls 项一行 toolCallEvent(scene="graph") | trace 已有 `tokens`/`toolCalls{name,ok,durationMs}`/`durationMs` 全部字段；graphId/userId 从 `GraphRunParams` 取（试运行 userId 取发起人） |

### 4.2 约束

- 全部 fire-and-forget（调用方不 await），catch + Log.warn 吞错，绝不影响主流程
- 埋点写入失败不产生用户可见错误
- 工具 aborted（竞速中止）不写事件；denied 输出文案不进事件（不存 args/output，仅聚合口径字段）

## 5. 聚合与 IPC

### 5.1 查询（monitor.repo.ts）

- 三条 `findMany`（`where: { userId, createdAt >= 7 天前, scene? }`，select 仅聚合所需列）：llmCallEvent、toolCallEvent、涉及 modelId 的 model 联查补名——7 天窗口事件本地单机千级，读回内存纯函数聚合（automation-stats `computeStats` 同构，skill-stats 决策 4 同判词）
- 模型名补位：`model.name ?? model.modelId ?? "#id"`（删除的模型显示 `#id`）
- 场景筛选 chip（全部/chat/graph/automation）作参数透传（`scene` 缺省不过滤）
- SQL 失败向 IPC 抛错（渲染端 error 态兜底）

### 5.2 纯函数（monitor-stats.ts）

输入为 `LlmEventRow[]` / `ToolEventRow[]` / `ModelNameRow[]`（findMany 产出行 + model 联查行），产出 `MonitorStats`：

```ts
interface MonitorStats {
  today: {
    inputTokens: number;
    outputTokens: number;
    llmCalls: number;
    toolCalls: number;
    toolSuccessRate: number; // done/(done+denied+error)，分母 0 记 0
  };
  trend: Array<{ date: string; inputTokens: number; outputTokens: number; llmCalls: number; toolCalls: number }>; // 近 7 天含空日补零
  byModel: Array<{ modelId: number; name: string; calls: number; inputTokens: number; outputTokens: number }>; // 输入 token 降序
  tools: Array<{ toolName: string; total: number; done: number; denied: number; error: number; avgDurationMs: number | null; successRate: number }>; // total 降序
}
```

### 5.3 IPC

- `ipc-channels.ts` 注册 `monitor:stats`；`handleUser("monitor:stats", (_, userId, scene?) => repo.getStats(userId, scene))`
- 渲染端 `src-react/domains/ai/monitor/api/monitor.api.ts` `invoke("monitor:stats", scene)`

## 6. UI（/module/ai/monitor）

- 路由：`routes/index.tsx` AI children 追加 `monitor`（懒加载 `MonitorView`，LazyWrapper 同款）
- 导航：`GlobalSidebar.tsx` `navEntries` 新增入口（与「自动化」等同列；图标 `Activity`）
- 目录 `src-react/domains/ai/monitor/`（views/components/api/store 齐套，Zustand 存场景筛选，React Query 拉数据）
- 布局（AutomationStatsPanel 卡片风格）：
  - 总览卡 ×4：今日输入 token / 输出 token / LLM 轮次 / 工具调用数+成功率
  - 7 天趋势：双序列（token 总量、LLM+工具调用次数）CSS 条形图，无图表库依赖
  - 按模型分布表：模型名、轮次、输入/输出 token、占比条
  - 工具排行榜：工具名、次数、成功率、平均耗时；denied/error 计数着色（warning/destructive 语义色）
  - 顶部场景筛选 chip：全部 / chat / graph / automation
- 数字格式化：千分位 + k/w 缩写（本地化）
- 颜色全走主题 CSS 变量（禁 bg-blue-* 等硬编码）；弹层边框 `border-border/50 rounded-lg shadow-lg`；悬停 `hover:bg-primary-subtle hover:text-primary`
- i18n：`chat` namespace 新增 `sidebar.monitor` 与 `monitor.*` key（现有惯例：AI 模块侧边栏与自动化统计文案均在 chat namespace，如 `chat:sidebar.automation`、`chat:automation.statsPanel.*`；camelCase 分层），zh-CN / en-US 同步；禁止硬编码文案

## 7. 错误处理

| 场景 | 处理 |
|---|---|
| 埋点写库失败 | catch + Log.warn，不影响主流程 |
| 聚合查询失败 | IPC 抛错 → React Query error 态 + toast（sonner） |
| usage 缺失（错误轮次/中止） | 不写 llmCallEvent |
| 工具 aborted | 不写 toolCallEvent |
| PrismaLike 缺席（单测） | 静默跳过 |

## 8. 测试计划

- `monitor-stats.test.ts`：趋势空日补零、今日口径、成功率分母 0、排序、场景过滤透传（纯函数，automation-stats 同风格）
- `monitor-events.test.ts`：PrismaLike stub 断言写入载荷、吞错、缺席跳过
- `runToolCall` 埋点：state 映射（done/denied/error/aborted 不写）、durationMs 计时、scene 传递
- graph 收尾埋点：注入 stub 断言「带 tokens 节点 → llmCallEvent、toolCalls → toolCallEvent」
- `npm run test` 全绿 + `npm run typecheck`；UI 手动验收走 `npm run dev`

## 9. 涉及文件清单

| 层 | 文件 | 变更 |
|---|---|---|
| schema | `prisma/schema.prisma` | 追加两 model |
| schema | `electron/infrastructure/script/v1/upgrade-table.sql` | 无改动（改动会翻转快照指纹，见 §3.2） |
| 主进程 | `electron/commons/prisma-client.ts` | `ensureMonitorTables` + 保留期扩展 |
| 主进程 | `electron/Application.ts` | 调用 ensureMonitorTables |
| 主进程 | `electron/domains/ai/monitor/monitor-events.ts` | 新建 |
| 主进程 | `electron/domains/ai/monitor/monitor-stats.ts` | 新建（纯函数） |
| 主进程 | `electron/domains/ai/monitor/monitor.repo.ts` | 新建（查询 + IPC） |
| 主进程 | `electron/commons/ipc-channels.ts` | 注册 monitor:stats |
| 主进程 | `electron/domains/ai/chat/chat.service.ts` | 埋点 #1/#3 + AgentStreamOptions.scene/stats |
| 主进程 | `electron/domains/ai/automation/automation-runner.ts` | 埋点 #2 + agent.scene |
| 主进程 | `electron/domains/ai/orchestration/graph-executor.ts` | 埋点 #4 |
| 渲染端 | `src-react/routes/index.tsx` | monitor 路由 |
| 渲染端 | `src-react/domains/ai/monitor/`（api/store/views/components） | 新建 |
| 渲染端 | `src-react/components/layout/GlobalSidebar.tsx` | navEntries 导航入口 |
| 渲染端 | `src-react/i18n/locales/{zh-CN,en-US}/ai.json` | monitor.* key |
| 测试 | `tests/**`（monitor 相关） | 新建单测 |
