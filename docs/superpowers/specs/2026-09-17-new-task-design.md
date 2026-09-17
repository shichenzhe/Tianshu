# 新建任务主工作台 — 设计文档

## 1. 背景与范围

"新建任务"是天枢的主工作台入口。现状：GlobalSidebar 按钮/快捷键点击即创建空 session 并跳转 ChatView（`session-actions.ts` 的 `createSessionAndSelect`），没有任务发起落地页，且产生未输入即入树的脏 session。

本子项目按 PRD 实现独立落地页：场景导航、推荐胶囊、核心输入框（附件引用 + 工具栏）、底部配置栏（工作空间/权限），发送后才创建 session 进入对话流。

**不做**（边界，均已与需求方确认）：

- 语音输入（🎤）——直接移除，不做占位
- 数据埋点（PRD 第 5 节）——直接移除，不留事件常量
- `@联系人` / `@历史对话`——`@` 引用仅保留现有文件/技能/待办
- 权限"只读档"——现有体系仅 `default | full` 两档（`permission:set` 主进程内存态），只读档需工具过滤体系支撑，列为后续演进；落地页为标准/高危两档
- 上传拷贝存储——采用路径引用模型（WorkBuddy 同构）：不复制文件，引用原路径按需读取
- 场景影响技能市场数据建模——技能场景标签仅用户手动打标（导入弹窗 + 技能管理列表勾选），不做关键词自动推断

## 2. 关键裁定

| # | 裁定 | 依据 |
|---|---|---|
| 1 | 独立路由 `/module/ai/new`（NewTaskView），点"新建任务"零副作用，**发送时才 create session** | PRD 页面结构一一对应；消除脏 session；ChatView 零改动；用户确认方案 A |
| 2 | 场景完整联动三件套：`session.scenario` 落库 + 后端 system prompt 注入 + 技能按场景过滤进胶囊 | 用户选完整联动（选项③）；与现有 `SessionMode`（agent/ask/plan，执行语义）正交不冲突 |
| 3 | 推荐胶囊 = 预设模板（i18n 常量，按场景分组）+ 该场景已打标已启用技能混排；技能点击插 `⚡技能` token | 模板填输入框（PRD 3.2 原文行为）；技能复用 PendingFile 机制 |
| 4 | `skillRecord.scenarios`（JSON 数组字符串）+ 导入弹窗与技能管理列表手动勾选 | 不依赖技能市场数据改造；打标入口在用户侧 |
| 5 | 附件 = 路径引用不拷贝；`PendingFile` 增 `localFile` kind；新 IPC `workspace:readExternalFile`；选择器/拖拽动作本身即授权 | WorkBuddy 同构（用户确认）；零新增存储、数据不出本地；现有 `workspace-files.ts` 以 workspacePath 为基，任意路径需新通道 |
| 6 | 50MB 上限语义 = 单文件读取注入上限（超限报错不加 pill），非上传大小限制 | 文件不动，"上传限制"不成立；防超大文件全文入 prompt |
| 7 | 敏感词拦截 = 前端本地词表 + 发送前检查 + 命中置灰并提示原因 | 核实安全中心（SP1–SP6）为审批/审计/沙箱，无内容词表引擎可复用；此为最小落地方案 |
| 8 | 魔法棒润色 = 新 IPC `chat:polish` 一次性非流式补全（默认 provider 默认模型，不落库不建 session）；三风格 professional / concise / translate-en | 润色是短文本变换，非对话；失败 toast 且原文不动 |
| 9 | 模式徽标 / ModelPicker / 停止按钮不进落地页；session 以默认 mode(agent) 与全局默认模型创建 | 落地页是发起态；ChatView 内仍可调整 |
| 10 | `ChatInput` 内联 token 解析 + 镜像层 + PendingFile 管理抽为共享模块，ChatView 与落地页共用 | `@文件`/`⚡技能` 引用两处同机制；DRY；ChatInput 行为不变 |
| 11 | 配置栏工作空间为任务级选择（决定 create 的 workspaceId），默认跟随全局当前空间，不改全局 | 语义是"本次任务运行范围"；全局切换仍由 WorkspaceMenu 负责 |
| 12 | 权限高危档复用现有 `FullAccessModal` 二次确认；发送编排中先 `permission:set` 再 `send` | PRD"高危需二次确认"；permission 为进程内存态（chat.api.ts:127 注释） |

## 3. 总体架构与流程

### 3.1 路由与入口

- 新路由 `/module/ai/new` → `NewTaskView`（AiLayout 子路由，认证守卫沿用）
- `GlobalSidebar.tsx:131` 按钮、`use-ai-layout-keybindings.ts:61` 快捷键：由 `handleCreateSession` 改为 `navigate("/module/ai/new")`

### 3.2 发送时序

```
NewTaskView 发送
  1. 前置检查（敏感词 → 无可用模型 → 无工作空间）
  2. SessionApi.create({ workspaceId, scenario })
  3. 若权限=高危：ChatApi.setPermission(sessionId, "full")
  4. ChatApi.send({ sessionId, content })  ← 不传 modelId，后端回退会话/全局默认模型（与现有 ChatView 新会话一致）
  5. navigate(`/module/ai?session=${id}`)
  6. ChatView 现有 chat:status 恢复机制自动接上流式输出
```

任一步失败：toast 错误、停留落地页、文本与配置全保留（PRD 4.1）。

## 4. 数据模型与后端变更

### 4.1 Prisma schema（`electron/infrastructure/script/v10`）

```prisma
model session {
  scenario String?   // daily | coding | design；null = 旧会话/未指定
}
model skillRecord {
  scenarios String?  // JSON 数组字符串，如 ["daily","coding"]；null/[] = 未打标
}
```

配套：`session:create` 参数扩展 `scenario?: string`；`session.repo` 落库；技能安装/更新接口透传 `scenarios`。

### 4.2 场景 prompt 注入

`chat.service.ts` 组装 system prompt 时，`session.scenario` 非空则追加场景提示段（后端常量三段，实现时起草；与前端 i18n 分开维护——prompt 是给模型的，不进 i18n）。

### 4.3 新增 IPC（2 个）

| Channel | 入参 | 出参 | 说明 |
|---|---|---|---|
| `workspace:readExternalFile` | `absolutePath` | `{ content, size, binary }` | 读取用户主动添加的本地文件；>50MB 返回错误码；二进制返回标记按现有注入规则处理 |
| `chat:polish` | `{ text, style }`，style = `professional \| concise \| translate-en` | `{ text }` | 一次性补全，默认 provider 默认模型，不落库不建 session |

现有 `@文件`/`⚡技能`/`#待办` 引用机制、`readWorkspaceFile` 全部复用不动。

## 5. 前端视图与组件

```
src-react/domains/ai/new-task/
├── views/NewTaskView.tsx      # 标题 + 场景Tab + 胶囊栏 + 输入卡 + 配置栏
├── components/
│   ├── ScenarioTabs.tsx       # 日常办公(默认) / 代码开发 / 设计创意
│   ├── PromptChips.tsx        # 横向滚动胶囊栏；模板胶囊 + 技能胶囊混排
│   ├── NewTaskInputCard.tsx   # textarea(自适应, max-h 50vh) + 附件 pill 列表 + 工具栏
│   ├── AttachMenu.tsx         # + 菜单：添加本地文件 / 引用工作空间文件 / 引用历史对话(占位)
│   ├── PolishMenu.tsx         # 更专业 / 更简洁 / 翻译成英文
│   ├── QuickMenu.tsx          # ⚡快速：预设快捷指令 + 已启用技能
│   └── ContextBar.tsx         # 工作空间选择器 + 权限选择器
├── lib/
│   ├── scenario.ts            # 场景/胶囊模板常量 + 按场景过滤技能
│   ├── sensitive-check.ts     # 敏感词预检
│   └── dispatch.ts            # 发送编排（§3.2 时序），失败保状态
└── store/new-task-store.ts    # Zustand：文本/场景/空间/权限/pendingFiles；场景+权限+最近工作空间持久化 localStorage（下次进入恢复）
```

共享抽取（裁定 10）：`ChatInput` 的内联 token 解析、镜像层同步、PendingFile 管理抽为 `chat/lib/` 共享模块，两处共用；具体抽取清单在实现计划逐文件定。

### 胶囊数据流

```
ScenarioTabs(当前场景) ─┬─> scenario.ts 预设模板胶囊（i18n 文案）
                       └─> React Query skill:list → filter(场景匹配 && enabled) → 技能胶囊
点击模板胶囊 → 模板填入输入框（光标落 [主题] 占位处）
点击技能胶囊 → 插入 ⚡技能 token
```

### 配置栏语义

- 工作空间选择器：任务级（create 的 workspaceId），默认跟随全局当前空间，不影响全局
- 权限选择器：标准 / 高危（高危弹 FullAccessModal）

## 6. 异常处理

| 场景 | 行为 |
|---|---|
| create/send 失败 | toast（复用现有错误文案体系），停留落地页，状态全保留 |
| 文件 >50MB | toast"文件大小超出限制"，不加 pill |
| 敏感词命中 | 发送置灰 + 提示命中原因 |
| 长文本 | 右下角 `n/2000` 计数 + 截断风险提示（仅提示） |
| 无可用模型 | 发送置灰，复用 `chat:input.modelRequired` |
| 无工作空间 | 发送置灰，提示先创建 |
| 润色失败 | toast，原文不动（润色中按钮 loading，不锁输入） |

## 7. i18n

新建 `newTask` 命名空间（zh-CN/en-US 同步注册于 `src-react/i18n/index.ts`）：标题插值 zh `"{{app}}，我帮你"` / en `"{{app}}, how can I help"`（app 取 `common:appName`）；场景、胶囊模板、菜单、错误全部走 `t()`。样式遵守主题变量规范（禁硬编码色）。

## 8. 测试

- **Vitest 单测**：`scenario.ts`（场景→胶囊映射、技能过滤）、`sensitive-check.ts`、`dispatch.ts`（mock IPC：编排顺序、各步失败、高危分支）、字数计数
- **组件测试**：Tab 切换联动胶囊、点击胶囊填模板、发送置灰条件矩阵（空文本/敏感词/无模型/无空间）
- **手工验收清单**：`docs/superpowers/acceptance/2026-09-17-new-task.md`，沿用 sp 系列模式
