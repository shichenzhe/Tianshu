# 项目模块一期设计（Project Module Phase 1）

- 日期：2026-09-12
- 状态：设计已评审确认，待实施
- 来源 PRD：项目模块（含项目详情页-计划/任务/资产补充 PRD）
- 整体分期：三期垂直切片交付；本文档为一期设计 + 全模块 roadmap

## 1. 背景与目标

天枢从对话工具演进为 AI 工作台，需要一个聚合资源（文档/数据）、配置能力（专家/技能/连接器）、承载协作的容器——「项目」。

一期目标：交付**能真实使用的"带 AI 的项目"**——项目 CRUD、模版创建、能力挂载、动态流（项目指令生效的 AI 对话）、右侧配置面板。计划/任务/资产 Tab 以占位空状态呈现，二三期填肉。

## 2. 已确认的关键决策

| 决策点 | 结论 |
| --- | --- |
| 多人协同 | **C · 本地模拟**：当前登录用户即唯一成员；数据模型预留 `projectMember`；不做邀请 UI、不放假按钮 |
| 资产存储（二期实施） | **A · 项目专属目录（网盘模式）**：`userData/projects/<id>/assets/`，上传=复制入库，容量为本地软配额 |
| 模块入口 | **侧边栏共用 + 独立模块路由**：AiSidebar 上移 MainLayout 变全局侧边栏，项目为 `/module/project` 独立模块 |
| 交付策略 | **垂直切片 3 期**：一期项目地基+动态流；二期资产+@引用；三期计划+任务 |
| 模版来源 | 内置静态 TS 数据（随版本发布），不入库 |
| 动态流 AI | 复用现有 chat 管道（session 加 projectId 列），项目会话不进 AI 任务树 |
| @ 引用 | 复用现有 `@ 文件`（workspace）机制；二期资产目录以工作空间形态接入，交互不变 |
| 输入框底栏 | 一期保留：工作空间选择 + 默认权限设置，默认上下文「本地任务」；语音输入砍掉（现有 ChatInput 无此能力） |
| 能力挂载映射 | 专家=assistant、技能=skillRecord、连接器=mcpServer，挂已有实体，不新建能力体系 |
| 定时任务 | 复用现有 automation 域，右侧面板仅放入口跳 `/module/ai/automation` |

## 3. 整体架构

### 3.1 路由

| 路由 | 视图 | 说明 |
| --- | --- | --- |
| `/module/project` | ProjectHubView | 项目列表页：头部（标题+新建按钮+插画）、我的项目卡片+搜索、从模版创建区 |
| `/module/project/:projectId` | ProjectWorkspaceView | 详情页：顶栏 Tab（`?tab=activity\|plan\|tasks\|assets`，默认 activity）+ 动态流 + 右侧配置面板（可收起） |

Tab 用 URL query 切换（参照 ExpertsView `?tab=` 惯例），不做嵌套子路由——四 Tab 共享底部 AI 输入框。

### 3.2 侧边栏共用改造（结构性改动，需回归验证 AI 域）

现状 `AiLayout = AiSidebar + Outlet`，侧边栏为 AI 模块私有。改造：

- MainLayout 变为 `TopBar + Sidebar + 内容区`，所有 `/module/*` 共享侧边栏；
- AiSidebar 拆两部分：
  - **共用导航区**：新建任务、**项目**（新增，高亮态）、专家、自动化、资料库；
  - **主体区**（随模块切换）：AI 模块下显示现有「空间分组的任务树」（行为不变）；项目模块下显示「我的项目列表 + 最近访问」；
- AiLayout 的快捷键分发等逻辑随侧边栏迁移，AI 域功能不受影响；
- MainLayout 现有的 `isAiRoute` 顶栏插槽注入逻辑不受影响（project 模块不注入 AI 顶栏组件）。

### 3.3 后端结构（按 docs/guide.md 七步惯例）

```
electron/domains/project/
  project.entity.ts               # 前后端共享类型
  project.repo.ts                 # IPC 自注册仓储
  template/project-templates.ts   # 内置模版静态数据
src-react/domains/project/
  api/project.api.ts              # invoke 封装 + React Query
  views/  components/  store/
```

`Application.registerServices()` 接线；`lib/ipc.ts` 增加通道类型；i18n 新增 `project` namespace。

## 4. 数据模型（script/v2 迁移）

新建 `electron/infrastructure/script/v2/upgrade-table.sql`，`Constants.DATABASE_VERSION` 改 2，`prisma/schema.prisma` 同步并 `npx prisma generate`。二三期表各自期再建 v3/v4，不提前建空表。

### 4.1 新表

**project**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | Int PK autoincrement | 沿用现有 id 惯例（全表均为 Int 自增） |
| name | TEXT NOT NULL | ≤15 字，同一用户下唯一（应用层校验） |
| systemPrompt | TEXT NULL | 项目指令；空白创建时为空 |
| templateKey | TEXT NULL | 来源模版 key |
| ownerId | TEXT | 创建者 → user.id |
| createdAt / updatedAt | 时间戳 | 沿用现有惯例 |

**projectMember**（协同预留）

`id, projectId, userId, role('owner'\|'member'), joinedAt`，唯一约束 (projectId, userId)。一期创建项目时写入创建者为 owner。

**projectBinding**（能力挂载，一张通用表）

`id, projectId, itemType('assistant'\|'skill'\|'mcpServer'), itemId, createdAt`，唯一约束 (projectId, itemType, itemId)。将来新增能力类型不改表。

### 4.2 session 表变更

新增 `projectId TEXT NULL` 列：

- `projectId IS NULL` → 普通会话，出现在 AI 任务树（现有会话列表查询加过滤条件）；
- `projectId = X` → 项目动态流会话，不进 AI 任务树。

### 4.3 级联删除（应用层实现，SQLite 无外键）

删除 project → 连带删 projectMember、projectBinding、该项目 session + message。

### 4.4 内置模版（静态 TS 数据）

```ts
interface ProjectTemplate {
  key: string;
  name: string;
  description: string;
  prompt: string;    // 结构化 Prompt，填充指令文本域
  welcome: string;   // 创建项目时自动插入的欢迎语（按模版侧重变化）
  icon: string;      // lucide 图标名
}
```

一期内置 4 个：产品需求全流程、市场调研、Bug 跟踪、空白项目。`prompt`/`welcome` 为内容数据，不走 i18n。

## 5. 动态流 AI 接入

### 5.1 会话模型

- 项目创建时自动创建 **1 个 session**（projectId 指向该项目，title=项目名），并插入欢迎 message（assistant 角色，内容取模版 `welcome`）——一个项目固定一条动态流；
- 渲染复用 `MessageList` / `MessageItem`，数据源为该 session 的 `message:listBySession`，流式状态走现有 `chat.store` 机制。

### 5.2 项目指令生效机制

前端发送语义不变，后端组装上下文时识别 `session.projectId`：

1. 存在 → `project.systemPrompt` 作为该会话基础 system prompt（可编辑、即时生效）；
2. 已挂载专家（assistant）→ 其 prompt 按现有合并机制追加注入；
3. 已挂载技能/连接器 → 进入可用能力集。

**工具隔离降级条款**：prompt 注入 + PlusMenu 过滤为一期硬性目标；「未挂载 MCP/技能禁止调用」若现有 chat 后端工具选择粒度改造成本过高，一期降级为软约束（prompt 声明可用范围），硬隔离移入二期。实施计划第一步安排 spike 验证。

### 5.3 组件复用策略

项目域跨域直接 `import @/domains/ai/chat/components/ChatInput` 等，**不提升公共层**——AI 域活跃开发中，提升需改全部 import 路径，收益小；等第三个域需要聊天组件时按 rule-of-three 提升。

### 5.4 输入框一期形态

| 能力 | 一期 | 说明 |
| --- | --- | --- |
| 文本输入/发送/停止/模型选择 | ✅ | 复用 ChatInput |
| PlusMenu 专家/技能/连接器 | ✅ | 过滤为「已挂载到本项目的」 |
| `@ 文件` 引用 | ✅ | 走现有 workspace 机制；二期资产目录以工作空间形态接入 |
| 底栏：本地任务（默认）/ 选择工作空间 | ✅ | 保留现有机制 |
| 底栏：默认权限设置 | ✅ | 保留现有机制 |
| `@ 引用资产` 专项文案 | ❌ | 二期；一期 Placeholder 为「今天帮你做些什么？」 |
| 语音输入 | ❌ | 砍掉（现有 ChatInput 无此能力） |

## 6. 界面设计

### 6.1 ProjectHubView

- **头部**：标题「项目」+ 副标题、`+ 新建项目` 主按钮（`bg-primary` 主题变体，不硬编码黑色）、右侧内置 SVG 装饰插画（本地资源）；
- **我的项目**：卡片网格（图标、名称、创建时间、`...` 菜单：重命名/删除，删除二次确认）；右上角搜索框，客户端过滤；空状态引导；
- **从模版创建**：模版卡片横向滚动区（名称+描述），点击打开新建弹窗并预选该模版。

### 6.2 新建项目弹窗

**表单**：项目名称（必填 ≤15 字）→ 指令配置（模版下拉 + 长文本域）→ 三个能力挂载区 → 取消/确定。

**模版覆盖确认（PRD 4.1）**：维护 `当前生效模版 key` + `用户已编辑` 标记；文本域有内容时切换模版 → AlertDialog「切换模版将覆盖当前已编辑的指令内容，是否继续？」；确认→填充新模版，取消→下拉回弹原选择。

**通用 PickerDialog 组件**：三个能力选择器结构高度相似，抽一个组件三种配置（数据源 `mcpServer:list` / `assistant:list` / `skill:list`），支持搜索/分类浏览、多选，确认后以 Tag 展示、可逐个移除。

**提交链路**：确定 → 前端校验非空 → IPC `project:create`（后端重名校验，错误码 `PROJECT_NAME_EXISTS`）→ 创建 project + owner member + session + 欢迎消息 → 跳转 `/module/project/:id`。IPC 失败：toast 报错、弹窗不关闭内容保留。

### 6.3 项目详情页 + 右侧配置面板（可收起）

| 区块 | 一期形态 |
| --- | --- |
| 顶栏 | Tab：动态（默认）/ 计划 / 任务 / 资产（后三者为占位空状态）；筛选器（与我相关/成员动态）——本地单成员下两者结果一致（C 方案·均只筛自己），UI 保留为多成员预留；展开/收起配置面板按钮 |
| 动态流 | 欢迎消息 + 消息流 + 底部 AI 输入框（见 §5.4） |
| 指令 | systemPrompt 摘要（markdown 只读渲染）+ `+` 编辑（弹窗编辑，保存即时生效） |
| 连接器/专家/技能 | 已挂载数量 + 图标/头像组，点击唤起 PickerDialog 增删 |
| 定时任务 | 入口跳 `/module/ai/automation` |
| 成员 | 显示创建者（我，owner）——预留区，无邀请按钮 |

## 7. 错误处理

| 场景 | 处理 |
| --- | --- |
| 创建重名 | 错误码 `PROJECT_NAME_EXISTS` → 表单内联提示「该项目名称已存在，请修改」 |
| 创建 IPC 失败 | toast 报错 + 弹窗不关闭、内容保留 |
| 删除项目 | AlertDialog 二次确认 → 级联删除（§4.3） |
| 挂载项失效（如专家在 AI 模块被删） | 配置面板读取时 join 过滤 + 「已失效」标记，可手动移除，不阻塞使用 |
| 进入不存在的项目 | 详情页 404 检测 → 重定向回 Hub + toast |
| 未配置 AI 模型 | 动态流显示引导（复用 SetupGuide 形态，跳转 providers） |
| IPC 通用异常 | 全部 catch，给出有用提示（CLAUDE.md 要求） |

## 8. i18n

新增 `project` namespace，`zh-CN` / `en-US` 同步；所有 UI 文案走 `t()`；模版 `prompt`/`welcome` 为内容数据，随模版自带语言。

## 9. 测试策略（Vitest，参照现有 tests/ 结构）

- **后端 repo 单测**：create 重名校验、delete 级联删除、session 隔离（项目会话不出现在 AI 会话列表查询）；
- **前端单测**：模版覆盖确认状态机（dirty 标记/取消回弹）、PickerDialog 多选与 Tag 移除、项目卡片列表过滤；
- 手动验收清单随实施计划产出。

## 10. 二三期 Roadmap（各自独立 spec → plan）

**二期 · 资产**

- `projectAsset` 文件树表 + 真实目录 `userData/projects/<id>/assets/`；
- 上传（拖拽/选择）、多级文件夹、列表（名称/类型/更新人/更新时间/大小）、排序筛选、容量统计（本地软配额）；
- `@` 引用接入项目资产（工作空间形态）；删项目连带删文件；
- 一期未完成的工具硬隔离在此期补齐。

**三期 · 计划 + 任务**

- `planItem` 表（自定义字段 JSON 列承载）；
- 计划：表格视图（+ 快速新增行、自定义字段）、看板视图（四状态泳道、拖拽流转、列计数）、筛选搜索；
- 任务：个人视角清单（来源标识「本地/项目」、私密性提示、按指派/创建筛选、搜索）；拖拽库选型（dnd-kit 等）三期定。

## 11. 风险

1. **AiSidebar 上移 MainLayout** 为 AI 域结构性改动，需回归验证任务树/快捷键/批量管理不受影响；
2. **chat 后端 prompt 组装**改造前需先读懂现有实现（实施计划第一步 spike 验证，产出硬隔离 vs 软约束结论）。
