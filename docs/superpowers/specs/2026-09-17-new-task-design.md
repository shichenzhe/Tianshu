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
| 5 | 附件 = 路径引用不拷贝；`PendingFile` 增 `localFile` kind；新 IPC `file:readExternalFile`；选择器/拖拽动作本身即授权 | WorkBuddy 同构（用户确认）；零新增存储、数据不出本地；现有 `workspace-files.ts` 以 workspacePath 为基，任意路径需新通道 |
| 6 | 单文件读取注入上限复用现有 `READ_LIMIT = 512KB`（`workspace-files.ts:24`，与 `@文件` 同口径），超限报错不加 pill | 文件不动，"上传限制"不成立；50MB 文本远超模型上下文，512KB 才是"读内容注入 prompt"链路的真实约束，两处口径一致 |
| 7 | 敏感词拦截 = 前端本地词表 + 发送前检查 + 命中置灰并提示原因 | 核实安全中心（SP1–SP6）为审批/审计/沙箱，无内容词表引擎可复用；此为最小落地方案 |
| 8 | 魔法棒润色 = 新 IPC `chat:polish` 一次性非流式补全（默认 provider 默认模型，不落库不建 session）；三风格 professional / concise / translate-en | 润色是短文本变换，非对话；失败 toast 且原文不动 |
| 9 | 模式徽标 / ModelPicker / 停止按钮不进落地页；session 以默认 mode(agent) 与全局默认模型创建 | 落地页是发起态；ChatView 内仍可调整 |
| 10 | 落地页输入卡**独立精简实现**（textarea + 引用 pill + 简化 `@` 文件联想面板，PRD 3.3.2 的胶囊范式）；仅纯函数 `detectMention` 从 `ChatInput.tsx:126-149` 迁入 `inline-tokens.ts` 共用，ChatInput 其余零改动 | 联想面板/镜像层与 session 强耦合（PlusMenu/PermissionCapsule/ModelPicker 均需 sessionId），大抽取=ChatView 回归风险；PRD 引用范式本就是"胶囊标签展示"非行内 token |
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
  4. ChatApi.send({ sessionId, content })  ← 发起即继续、不 await——chat:send
     IPC 契约是整个流式生成完成才 resolve（后端 send 内部 await streamAndPersist），
     等它会把跳转阻塞整个生成期；早期失败（无模型等）catch 后 toast，
     流内错误由 ChatView 错误块展示。不传 modelId，后端回退会话/全局默认模型
  5. navigate(`/module/ai?session=${id}`)
  6. ChatView 现有 chat:status 恢复机制自动接上流式输出
```

create/读引用失败：toast 错误、停留落地页、文本与配置全保留（PRD 4.1）；send 例外——session 已建立、用户消息已落库，早期失败仅 toast 仍导航。

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
| `file:readExternalFile` | `absolutePath` | `{ content, size, binary }` | 读取用户主动添加的本地文件（`file:` 前缀与现有 `file:readWorkspaceFile` 同族，注册于 chat.service）；超 512KB 注入上限返回错误码；二进制返回标记按现有注入规则处理 |
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
│   ├── AttachMenu.tsx         # + 菜单（PlusMenu 对齐）：添加文件/工作空间文件 + 模式/专家/技能 + 连接器
│   ├── polish-button.tsx      # AI 润色：单按钮通用润色（professional），转圈禁点
│   ├── QuickMenu.tsx          # ⚡快速：预设快捷指令 + 已启用技能
│   └── ContextBar.tsx         # 工作空间选择器 + 权限选择器
├── lib/
│   ├── scenario.ts            # 场景/胶囊模板常量 + 按场景过滤技能
│   ├── sensitive-check.ts     # 敏感词预检
│   └── dispatch.ts            # 发送编排（§3.2 时序），失败保状态
└── store/new-task-store.ts    # Zustand：文本/场景/空间/权限/pendingFiles；场景+权限+最近工作空间持久化 localStorage（下次进入恢复）
```

共享（裁定 10 修订）：仅纯函数 `detectMention` 从 ChatInput 迁入 `chat/lib/inline-tokens.ts` 共用；落地页输入卡为独立精简实现（textarea 自适应 + 引用 pill 列表 + 简化 `@` 文件联想面板，选中转 pill），不搬 ChatInput 的镜像层与联想系统。

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
| 文件超 512KB 注入上限 | toast"文件大小超出限制"，不加 pill |
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

## 9. Deviations（执行记录）

实现与 spec 的偏差补记（来源：SDD ledger 各任务执行记录；行为均以 spec 目标为准，以下为达成路径的偏差）：

1. **润色模型选择（chat:polish）**：计划参考实现拟复用 `titleModelText` / `getFirstUsableModel`，代码事实为前者硬编码标题 system prompt + `maxOutputTokens:30`（直接复用会截断润色输出）、后者不存在。实际实现为 `generateText` + `createLanguageModel` 模式复刻，配 prisma 两步查询回退（provider→model）。行为与 §4.3 一致（默认 provider 默认模型）。
2. **文件选择通道补建**：计划遗漏系统文件选择器通道，执行中补建 `file:pickLocalFiles`（IPCChannel 联合类型登记，与既有通道同模式）。另：计划中测试 mock 与实现要求自相矛盾（整模块 mock `@tanstack/react-query` vs 实现走 useQuery），实际以自建 `hooks/use-workspace-files.ts` 直连 invoke 解决（调用形态对齐 ChatInput，带取消标志无竞态）。
3. **i18n 结构演进**：`newTask:quick.*` 词条从标量扩为 `{label, prompt}` 对象结构（Controller Ruling 4；zh/en 双语同步；测试断言 key 以组件实际渲染为准）。
4. **置灰矩阵补模型条件**：§6 本有"无可用模型→发送置灰"要求，计划 T14 的 disabled 矩阵遗漏该条件，执行中补上——判定复刻 ModelPicker 口径（共享 queryKey `["models"]`/`["providers"]`、存在启用 provider 的启用模型），加载窗口保守置灰，提示 `t("newTask:modelRequired")`。
5. **持久化恢复接线**：store 的 `hydratePersistedDraft()` 落地后一度未接线，T14 接入 NewTaskView——采用 useState lazy initializer 而非 effect（子组件 ContextBar 的 null 兜底 effect 先于父 effect 执行，会覆盖持久化快照；lazy initializer 在首次渲染前恢复，时序正确）。
6. **测试环境适配**（观察记录，非行为偏差）：FullAccessModal 确认按钮在 mock i18n 环境下渲染为 key 文本 `chat:permission.confirmFullAccess`，测试正则 `/确认|confirm/i` 经 "confirm" 子串命中；真实中文文案为"允许完全访问"。测试已注释说明。
7. **技能安装/更新接口不透传 scenarios**（执行裁定）：spec §4.1 的'技能安装/更新接口透传 scenarios'未实现——场景打标仅有技能管理列表勾选入口（skill:setScenarios）。数据安全已验证：安装器 upsert 只写 slug/version/source/dir/description，list() 对账只写 dir/description，用户打标在重装/扫描下不丢失。导入弹窗打标列为后续演进。
8. **+ 菜单完整对齐 PlusMenu**（用户裁定，修订裁定 9 的模式部分）：落地页 AttachMenu 由文件三项扩为与会话 PlusMenu 六项对齐——文件两项（添加文件/工作空间文件）+ 模式/专家/技能 + 连接器（PRD 的"引用历史对话"占位项经用户后续裁定移除，连带删除 newTask:attach.historyChat/developing 词条）。模式/专家在无 session 语境下改为"草稿态"：store 增 mode（默认 agent）/assistantId（默认 null）两任务级草稿字段（不持久化、resetDraft 清），dispatch 在 create 后按需 setAssistant/setMode 落库（默认值跳过省 IPC，时序 create→setAssistant→setMode→setPermission→send）；选中反馈在输入卡工具栏以徽章呈现（专家名可 X 清除、非 agent 模式标签，ChatInput 底行同形态）。实现依赖：PlusMenu 导出 MODES 供复用；ExpertSubMenu 增可选 onPick 草稿分支（sessionId 改可选，ChatInput 调用零改动）；SkillSubMenu 无 session 依赖原样复用；文案复用 chat:plus.* 词条。裁定 9"模式不进落地页"就此废止（模式可在发起前选定）；ModelPicker/停止按钮仍不进落地页。
9. **润色交互简化为通用单按钮**（用户裁定，修订裁定 8 的三风格部分）：弃下拉三风格，PolishButton 点击即对全文润色，style 固定 `professional`（通用档），润色中触发钮 Loader2 转圈且禁点（不锁 textarea），完成/失败恢复。后端 `chat:polish` 契约不变（仍收三风格 style，前端固定传 professional，三 prompt 模板保留向后兼容）；失败 toast 原文不动、空文本静默、未绑空间 toast 等行为与原 PolishMenu 一致。连带删除 newTask:polish.professional/concise/translate-en 三词条（无引用）。
