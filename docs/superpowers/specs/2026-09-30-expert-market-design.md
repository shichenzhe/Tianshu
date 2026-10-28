# 专家市场、我的专家与对话式创建引导——设计文档

日期：2026-09-30
状态：已与用户确认设计方向

## 背景与目标

参照 WorkBuddy 专家系统 PRD，改造天枢「专家·技能·连接器」页的专家 Tab
（`/module/ai/experts?tab=assistants`）：

- 主页面从「助手预设管理」改为**专家市场**（精选场景横滑 + 多维筛选 + 卡片网格）。
- 新增**我的专家**子视图：非空为管理网格，空状态为创建引导页（PRD 核心场景）。
- 新增**对话式创建引导**：预填模板跳聊天页，AI 生成专家配置草稿。

与技能页（SkillDiscoverView）、连接器页（ConnectorMarketView）形成三 Tab
统一的市场化体验。

**已拍板的决策**：

- **市场数据 = 本地内置目录**（用户确认）：单机应用无远端专家市场，精选场景 /
  分类 / 专家清单 / 徽章 / 热度均为随应用发布的静态运营数据，前端模块承载
  （同连接器市场 `market-connectors.ts` 模式）；未来上远端只需换数据源，页面
  结构不动。
- **创建流 = 复用聊天页预填模式**（用户确认方案 A）：「+ 创建专家」→ 新开会话
  + 预填模板 → 跳转聊天页（与「创建技能」体验完全一致），不建独立 wizard 页。
- **去掉内置助手自动播种**（用户确认）：新用户「我的专家」为空，空状态引导是
  PRD 核心路径；旧用户已播种数据不动，`builtin` 不可删约束保持。

## 1. 信息架构

```
专家页 Tab「专家」（ExpertsView 容器不变；assistants 分支换挂双视图，?view=market|mine）
├── ExpertMarketView（新，默认 ?view=market）
│   ├── 工具栏：搜索框「搜索专家职称或描述」｜「我的专家 [n]」按钮 → ?view=mine
│   ├── 精选场景横滑区（6 张场景卡；聚合态整区收起，顶行换「< 全部专家」返回）
│   ├── 筛选行：专家/专家团 ｜ 综合/最热/最新 ｜ 分类横滚标签（~10 个）
│   ├── 专家卡片网格（grid-cols-1 / md:2 / xl:3 / 2xl:4，ExpertCard）
│   └── ExpertDetailDialog（详情弹窗：完整描述 + systemPrompt 折叠 + 添加动作）
└── MyExpertsView（新，?view=mine）
    ├── 非空：头部「+ 创建专家」按钮 + 网格（迁移 AssistantCard：编辑/删除 + 开对话）
    └── 空：「< 全部专家」返回 + 毕业帽线性插画 + 主/副标题 +「+ 创建专家」+「去市场逛逛」
```

`ExpertsView` 现有 `?view=` 参数已被技能子视图占用（installed/discover），本设计
的 `?view=market|mine` 仅在 `?tab=assistants` 下生效，两者按 tab 分流不冲突。

## 2. 市场首页（ExpertMarketView）

### 数据：`data/marketplace.ts`（纯静态，无 IPC）

```ts
export interface ExpertMarketItem {
  slug: string;        // kebab-case，市场身份 & 「已添加」匹配键
  name: string;        // 专家名称（内容数据，中文原文，不走 i18n）
  subtitle: string;    // 身份标签（卡片名称下方小字）
  description: string; // 2-3 行能力介绍
  icon: string;        // emoji 头像（同 assistant.icon 口径）
  systemPrompt: string;// 添加时写入专家 systemPrompt 的模板
  category: string;    // 分类 key（EXPERT_CATEGORIES 之一）
  tags: string[];      // 技能关键词胶囊
  badge?: string;      // 认证徽章（如「特邀」，静态运营数据）
  type: "expert" | "team"; // 专家 / 专家团
  score: number;       // 综合排序权重（越大越前）
  downloads: number;   // 最热排序
  createdAt: string;   // 最新排序（ISO 日期，静态数据写死）
}
export interface ExpertScenario {
  slug: string;
  title: string;
  icon: string;        // emoji
  gradient: string;    // 卡片背景主题渐变（主题变量组合）
  expertSlugs: string[]; // 推荐专家（卡片展示取前 3，聚合态取全部）
}
```

- **分类常量**（~10 个，PRD 17 个中的产品特化项如「OPC一人公司」「腾讯专家」
  「高校新生攻略」不搬）：`tech`(技术工程)、`product`(产品设计)、`finance`(金融投资)、
  `data`(数据智能)、`content`(内容创作)、`marketing`(营销增长)、`sales`(销售商务)、
  `ops`(运营人力)、`education`(教育学习)、`legal`(法务安全)。
- **场景 6 个**（PRD 原场景，文案本地化）：开学季、内容创作、投资分析、法律咨询、
  小微企业、电商运营。
- **专家 ~20 个 + 专家团 2-3 个**，覆盖全部分类；现有 3 个内置助手（通用助手 /
  翻译助手 / 代码审查，含原 systemPrompt）收录进目录，保证旧用户「已添加」体感连续。
- 名称/描述/标签为内容数据直接中文（同 `BUILTIN_ASSISTANTS`、连接器名原文现状）；
  **假设**：第一版不做双语内容，后续需要时扩 `_en` 字段。

### 过滤/排序：`lib/market-filter.ts`（纯函数，可单测）

```ts
export function filterExperts(
  items: ExpertMarketItem[],
  filter: {
    keyword?: string;      // 名称/身份标签/描述/tags 大小写不敏感 includes
    type?: "expert" | "team";
    category?: string;     // undefined = 全部
    scenarioSlugs?: Set<string>; // 场景聚合态：slug 集合过滤
  },
): ExpertMarketItem[];
export function sortExperts(
  items: ExpertMarketItem[],
  sortBy: "comprehensive" | "hot" | "newest",
): ExpertMarketItem[]; // score 降序 / downloads 降序 / createdAt 降序
```

搜索防抖 300ms（同 SkillDiscoverView）。

### 场景卡片（ScenarioCard，PRD 5.1 跳转逻辑）

- 卡片结构：渐变背景（主题变量组合）+ 场景标题 + 推荐专家列表（头像 + 名称，取前 3）。
- **点卡片背景空白处** → 进入场景聚合态：场景横滑区收起，顶行换「< 全部专家」
  返回按钮 + 场景标题，列表过滤为该场景全部专家（`scenarioSlugs`），搜索/排序
  仍可用。
- **点场景内专家（头像/名称）** → 打开该专家的 `ExpertDetailDialog`。

### 市场卡片（ExpertCard，对齐 SkillHubCard 范式）

| 元素 | 实现 |
| --- | --- |
| 头部 | emoji 头像（`h-10 w-10 rounded-lg bg-primary-subtle`）+ 名称 + 徽章 Badge（badge 可空，空不渲染） |
| 身份标签 | subtitle，`text-xs text-muted-foreground` |
| 描述 | `line-clamp-2 text-sm text-muted-foreground` |
| 底部 | tags 胶囊（最多 3 个 + 溢出省略）+ 三态按钮：`+` 待添加 / `Loader2` 处理中 / `Check` 已添加（禁用） |

点击卡片主体（非按钮区）→ `ExpertDetailDialog`。

### 专家详情弹窗（ExpertDetailDialog）

- 头像 + 名称 + 徽章 + 身份标签 + 分类/类型元信息。
- 完整描述（不截断）+ systemPrompt 折叠预览（`<details>` 或展开态切换，默认收起）。
- 动作：「添加到我的专家」（默认）、「添加并对话」（添加成功后新会话绑定专家并跳转）。
- 已添加时两动作收敛为「已添加」禁用态 + 「去对话」次按钮（跳转现有会话流）。

### 添加流

```ts
// 已添加判定：React Query 复用 ["assistants"] key
const added = myAssistants.some((a) => a.sourceSlug === item.slug);
// 添加 = 以市场专家为模板建一条自己的专家
AssistantApi.create({
  name, icon, systemPrompt,
  description, tags, sourceSlug: item.slug,
});
// → invalidate ["assistants"] → toast「已添加到我的专家」（卡片/弹窗按钮随刷新变 Check）
```

- 「添加并对话」：添加成功后复用 `expert-sub-menu` 的「绑定专家开对话」路径
  （新会话 + 绑定 assistantId + 跳 `/module/ai?session=x`）。
- 用户删除后再添加：`sourceSlug` 重新写入，无唯一约束（同 slug 多行仅在删除后
  重建时出现，可接受）。

## 3. 我的专家（MyExpertsView）

- **非空态**：头部「+ 创建专家」按钮（进对话式创建流）+ 网格。卡片迁移自
  `AssistantCard`：编辑（AssistantDialog）/ 删除（AlertDialog 确认，builtin 隐藏
  删除，删除失败 `ASSISTANT_BUILTIN` 由 mapIpcError 兜底）+ 新增「开对话」快捷
  （同绑定专家开对话路径）。卡片描述优先 `description`，为空回退 systemPrompt
  截断（兼容旧数据与 builtin 行）。
- **空态**（`assistant:list` 为空）：居中引导区——「< 全部专家」返回（回
  `?view=market`）+ `GraduationCap` 线性图标（`text-muted-foreground/40` 大号）
  + 主标题「还没有创建任何专家」+ 副标题「创建属于你的专家，分享专业知识」
  + 居中「+ 创建专家」描边按钮 + 次入口「去市场逛逛」（`?view=market`）。

## 4. 对话式创建（复用创建技能模式）

```
「+ 创建专家」（空态 / 我的专家头部）
→ 取第一个工作空间 → SessionApi.create（同 SkillDiscoverView.handleCreateSkillFlow）
→ setPendingPrompt(t("chat:experts.createPrompt"))
→ navigate("/module/ai?session=x")
→ ChatInput 挂载消费预填（useCreateSkillPromptStore 读后即清，不带 skillRefs）
→ 用户改 [占位符] 发送 → AI 输出专家配置草稿（名称/提示词/标签建议）
→ 用户回「我的专家」→「+ 创建专家」表单落库（第一版人工闭环）
```

- 模板文案（i18n key `chat:experts.createPrompt`，带占位符引导填空）：
  `帮我创建一个专家，擅长 [专家方向]。我的经验是：[请补充你的行业背景、相关经验]`
- 复用 `useCreateSkillPromptStore`（本质是通用 pendingPrompt 桥），不新建 store。
- **AI 草稿自动落库（agent 工具调用）留作后续迭代**，本版不实现；PRD「草稿确认」
  以 AI 文本输出 + 人工表单创建替代。

## 5. 数据库与后端改动

### `assistant` 表 +3 列（发布前直接改 v1 快照，DATABASE_VERSION 不动）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `description` | TEXT NULL | 专家描述（市场添加带入 / 用户填写） |
| `tags` | TEXT NULL | 技能关键词，JSON 数组字符串（`["a","b"]`） |
| `sourceSlug` | TEXT NULL | 市场来源 slug，「已添加」判定键；仅 create 写入，update 不暴露 |

- `prisma/schema.prisma` 模型 + `electron/infrastructure/script/v1/upgrade-table.sql`
  建表语句同步；`prisma generate` 再生 `electron/generated/prisma`。
- 快照指纹守卫自动识别「同版本但快照已变」→ drop 业务表重放 v1 重建（开发期
  数据可弃，现有机制，无需新代码）。

### `assistant.repo.ts`

- `toRecord`：解析 `tags` JSON 字符串 → `string[]`（坏 JSON 回退 `[]`，不抛错）；
  `description`/`sourceSlug` 透传。
- `create`：入参 + `description`/`tags`（repo 侧序列化为 JSON 字符串）/`sourceSlug`。
- `update`：`description`/`tags` 支持 `undefined` 不改 / `null` 清空（同 icon 语义）。
- **删除 `seedIfEmptyFor` 与 `BUILTIN_ASSISTANTS`**（能力由市场目录承接）；
  `list` 对空用户返回空数组。

### `assistant.api.ts`（前端类型）

- `AssistantRecord` + `description?: string`、`tags?: string[]`、`sourceSlug?: string`。
- `AssistantCreateParams` + 同名字段（tags 为 `string[]`，repo 负责序列化）。

### `expert-sub-menu.tsx`（聊天 ＋菜单专家浮层）

- 空列表时显示「去市场召唤专家」引导项（跳 `?tab=assistants`），替代空白列表。

## 6. AssistantDialog 表单

- 新增「描述」可选多行（textarea，2-3 行高度）、「标签」单行输入（逗号分隔，
  提交时 trim + 去空；空输入 = 清空）。
- 既有名称/图标/提示词/参数字段不动；市场添加的专家可编辑全部字段。

## 7. 国际化与样式

- 新文案全部走 `chat` namespace 的 `experts` 节（zh-CN / en-US 同步新增）：
  - `experts.market.*`：搜索占位、我的专家（含 `{count}`）、场景区标题、全部专家、
    专家/专家团、综合/最热/最新、全部分类、添加/已添加/添加中/已添加到我的专家、
    添加并对话、去对话、提示词预览标题等。
  - `experts.myExperts.*`：空态主/副标题、创建专家、去市场逛逛、返回全部专家、
    开对话。
  - `experts.createPrompt`：创建模板文案。
  - `experts.scenarios.<slug>` / `experts.categories.<key>`：场景标题与分类名双语
    （场景/分类是 UI 结构性文案，走 i18n；专家条目内容数据不走）。
- 遵循项目主题变量（`bg-primary-subtle`/`text-primary` 等，禁硬编码色）、弹窗
  `border-border/50 rounded-lg shadow-lg`、触发按钮 hover 三件套。

## 8. 文件清单

| 动作 | 文件 |
| --- | --- |
| 新建 | `src-react/domains/ai/experts/views/ExpertMarketView.tsx`（市场主页） |
| 新建 | `src-react/domains/ai/experts/views/MyExpertsView.tsx`（我的专家双态） |
| 新建 | `src-react/domains/ai/experts/components/ExpertCard.tsx`（市场卡片） |
| 新建 | `src-react/domains/ai/experts/components/ExpertDetailDialog.tsx`（详情弹窗） |
| 新建 | `src-react/domains/ai/experts/components/ScenarioCard.tsx`（场景卡片） |
| 新建 | `src-react/domains/ai/experts/data/marketplace.ts`（静态目录 + 类型 + 分类/场景常量） |
| 新建 | `src-react/domains/ai/experts/lib/market-filter.ts`（过滤/排序纯函数） |
| 修改 | `src-react/domains/ai/experts/views/ExpertsView.tsx`（assistants 分支挂双视图 + `?view=market\|mine`） |
| 修改 | `src-react/domains/ai/api/assistant.api.ts`（类型扩展） |
| 修改 | `src-react/domains/ai/assistant/components/AssistantDialog.tsx`（+描述/标签字段） |
| 修改 | `src-react/domains/ai/chat/components/expert-sub-menu.tsx`（空列表引导） |
| 修改 | `src-react/i18n/locales/{zh-CN,en-US}/chat.json`（experts 节扩展） |
| 修改 | `prisma/schema.prisma`（assistant 模型 +3 字段） |
| 修改 | `electron/infrastructure/script/v1/upgrade-table.sql`（+3 列） |
| 修改 | `electron/domains/ai/chat/assistant.repo.ts`（透传 + 去播种 + tags 序列化） |
| 再生 | `electron/generated/prisma/*`（`prisma generate`） |
| 删除 | `src-react/domains/ai/assistant/views/AssistantSettingsView.tsx`（能力迁入 MyExpertsView，仅 ExpertsView 引用，无其他引用方） |

## 9. 测试策略

- `tests/ai/market-filter.test.ts`：关键词过滤（名称/身份标签/描述/tags 命中、
  大小写不敏感、空关键词全量）、type 筛选、分类过滤、场景 slug 集合过滤、三种
  排序稳定性与顺序、组合条件叠加。
- `tests/ai/assistant-repo.test.ts`（mock prisma，参照 automation-repo 模式）：
  create 透传新字段 + tags 序列化为 JSON 字符串、update `null` 清空 /
  `undefined` 不改、`sourceSlug` 不在 update 白名单、toRecord tags 坏 JSON 回退
  空数组、list 空用户不再播种（回归：直接返回空数组）、delete builtin 拒绝
  （既有行为回归）。
- 完成口径：`npm run test` + `npm run typecheck` + `npm run lint` 全绿。

## 10. 与 PRD 的显式偏差

| PRD | 本设计 | 原因 |
| --- | --- | --- |
| 远端专家市场（精选场景/热度/认证为运营数据） | 本地内置静态目录 | 单机应用无服务端；结构照市场范式抽象，未来可切远端 |
| 独立创建引导对话页（欢迎语/场景胶囊/专属输入框/全局设置栏） | 复用聊天页 + 预填模板 | 与「创建技能」模式一致，避免复制一套 ChatInput |
| `@expert-manager` 指令 + AI 草稿确认落库 | 纯文本模板；AI 文本草稿 + 人工表单落库 | 无插件概念；自动落库需 agent 工具，列后续迭代 |
| 网络加载失败重试占位 | 不落地 | 本地数据无网络请求 |
| 敏感词过滤 / 模板失效提示 | 不落地 | 无远端审核与插件依赖 |
| 活动通知气泡 / 右下角客服悬浮球 | 不落地 | 参考产品的运营壳，本应用无对应机制 |
| 17 个分类（含 OPC一人公司/腾讯专家等） | 10 个通用分类 | 产品特化分类不适用本应用 |
| PRD 6 个场景清单 | 保留 6 场景框架，文案本地化 | 同上 |
| 新用户自动播种 3 内置助手 | 去播种，空状态引导 | 空状态引导是 PRD 核心路径（4.2）；3 助手收录市场目录 |

## 11. 后续迭代方向（本版不做）

- agent 工具「创建专家」：AI 草稿 → 用户确认 → 自动落库的完整闭环。
- 远端专家市场（结构已预留：数据模块换源即可）。
- 专家团聚合详情（多专家编排对话，当前仅数据标记 + 筛选）。
