# 自动化任务编辑/详情模块设计

> 上游 PRD:自动化任务编辑/详情模块(2026-09-07,用户提供)。
> 澄清结论:编辑弹窗由详情页**完全替代**;权限复用会话 AccessMode 语义;
> 语气/风格下拉**本期不做**;播放 = 先自动保存再触发执行;表单逻辑抽
> `useTaskForm` 共享。

## 1. 背景与目标

现状:任务列表行点击打开 `CreateTaskDialog` 弹窗编辑;运行记录为全局 Tab
(`RunHistoryView`),无按任务视角;无手动触发执行能力。

本模块新增**任务详情/编辑页**(左右分栏),承载深度配置与运行监控:

- 精细化配置:名称/提示词(引用/技能/变量/模型)/工作空间/权限/频率
- 实时监控:该任务的运行历史,状态筛选,失败可看报错
- 操作安全:测试运行/删除/取消(脏确认)/保存

## 2. 数据层与执行链

### 2.1 Schema(未发布,直接改 v1 全量脚本 + prisma/schema.prisma)

```sql
automationTask 加列: accessMode TEXT NOT NULL DEFAULT 'default'  -- default | full
```

### 2.2 IPC 变更

| 接口 | 变更 |
|------|------|
| `automation:create` / `update` | 参数与落库带 `accessMode` |
| `automation:runNow`(**新增**) | 校验任务存在 → `executeTask(task, {triggerType:"manual", attempt:1, abort})` 返回 runId;完成后走既有 `automation:tasks-changed` 事件推送 |
| `automation:runs:page` | 加可选 `status` 参数(repo 查询过滤),筛选走 IPC 避免前端过滤的分页错乱 |
| 任务详情读取 | **不加新 IPC**,复用 `automation:list` 前端 `find(id)`(任务量小) |

### 2.3 执行链权限接线

- `TriggerType` 联合类型加 `"manual"`
- runner `streamAndRecord` 将 `task.accessMode` 作为执行参数传入 chat 执行链
  的权限消费点(与 PermissionCapsule 开启 full 后的会话同一门槛);
  **不依赖** chat.service 的内存 permissions Map(自动化每次执行新建 session)

## 3. 详情页 UI

### 3.1 路由

`/module/ai/automation/task/:id`(Hash 子路由,lazy import `TaskDetailView`);
`TaskRow` onClick 改为 navigate。

### 3.2 布局

```
┌─ 顶栏 ─────────────────────────────────────────────┐
│ < 返回   任务名称标题        ▶播放  🗑删除  取消  保存 │
├──────────────────────────┬─────────────────────────┤
│ 左侧配置区 (~60%)          │ 右侧运行历史 (~40%)       │
│ · 名称 Input              │ 运行历史 (N)   [筛选漏斗▾] │
│ · 提示词 TaskPromptInput   │ 状态图标+文字 · 时间 · 耗时│
│   (+菜单/引用/模型 pill)    │ 失败行可展开 error        │
│ · 工作空间 Select          │ 20/页 翻页               │
│ · 权限 PermissionCapsule   │ 行点击跳会话 ?session=    │
│   (复用,full 走确认弹窗)    │ (runs:page(taskId,status))│
│ · 频率:只读 scheduleText   │                         │
│   + 点击弹 SchedulePicker  │                         │
└──────────────────────────┴─────────────────────────┘
```

- **播放**:脏则先自动保存 → `runNow`;触发中按钮 loading;右侧靠
  `tasks-changed` 事件 + React Query 失效即时出现"运行中"记录
- **删除**:AlertDialog 二次确认,删除后回列表
- **保存**:主按钮(default 变体),无脏改动禁用
- **取消**:脏改动先 AlertDialog 确认丢弃,回列表
- 模型选择不单独放(`TaskPromptInput` 已含模型 pill)
- 运行历史筛选:全部/成功/失败/运行中;status 变化重置 page=1

### 3.3 状态样式(与 PRD 对齐)

- 运行中:灰字 + Spinner;成功:绿字 + Check;失败:红字 + 感叹号,可展开
  error(`localizeRunError` 本地化,复用 RunHistoryView 逻辑)

## 4. useTaskForm 抽取与 CreateTaskDialog 改造

- `useTaskForm`(**新**,`src-react/domains/ai/automation/lib/use-task-form.ts`):
  状态(name/prompt/modelId/temperature/workspaceId/missedPolicy/schedule/
  validity/accessMode)+ 回填(editTask→初值,含日期本地化回填)+
  脏检测(初始快照 diff)+ 校验(必填项)+ payload 组装(TaskCreateParams)
- `CreateTaskDialog`:删除 `editTask` 分支与 TaskListView 的 `setEditing`,
  表单换 `useTaskForm`;保留新建/模板创建两入口
- 样式遵循主题规范(主题变量、`border-border/50`、`rounded-lg`、`shadow-lg`)

## 5. 错误处理

| 场景 | 处理 |
|------|------|
| 任务不存在(id 无效/已删) | toast + 自动返回列表 |
| 保存失败 | toast(mapIpcError),留在页面 |
| 执行失败(空间/模型缺失) | runner 既有 failRun 落库 → 右侧显示失败记录与 error |
| 脏状态离开 | 返回/取消按钮拦截 AlertDialog;直接改 hash 不拦 |
| 空态 | History 图标 + 空文案 |

## 6. 测试与验收

单测(vitest,内存 SQLite,参照 automation-repo.test.ts 模式):

- `useTaskForm` 纯逻辑:回填/脏检测/payload(含 accessMode)/校验分支
- repo:create/update 落 accessMode;runNow 产生 manual 触发的 run 记录;
  runs:page 按 status 过滤

手动验收清单:

1. 列表点任务 → 详情页,配置回填正确
2. 改名称/提示词/空间/权限/频率 → 保存 → 重进,值保持
3. 播放 → 自动保存 → 运行历史出现 运行中→成功/失败;失败可看 error
4. 筛选漏斗 + 翻页正常
5. 取消(脏)→ 确认丢弃 → 回列表未变
6. 删除 → 确认 → 回列表,任务消失
7. accessMode=default 的任务执行时写类工具被权限门槛拦截(与 chat 一致)

## 7. 明确不做

- 语气/风格下拉(本期砍,后补容易)
- 编辑弹窗保留编辑模式(编辑统一走详情页)
- 任务详情读取新 IPC(复用 list)
- 直接改 hash 的离开拦截
