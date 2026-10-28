# 连接器市场与 MCP 服务管理弹窗——设计文档

日期：2026-09-30
状态：已与用户确认设计方向

## 背景与目标

参照 WorkBuddy 连接器页 PRD，改造天枢「专家·技能·连接器」页的连接器 Tab
（`/module/ai/experts?tab=connectors`）：

- 主页面从「MCP 服务器表格」改为**连接器市场**（卡片网格 + 搜索 + 24 个预置连接器）。
- MCP 管理从页面内表格收敛为**弹窗**（列表态/编辑态两态，编辑态为 mcp.json 风格
  JSON 编辑器）。

**已拍板的决策**：

- **存储模式（用户确认方案 A）**：数据库（Prisma `mcpServer` 表）为唯一真相源，
  JSON 编辑器只是视图——进入编辑态时把服务器列表序列化为 mcp.json 形态，保存时
  后端按 name 全量 diff 回写。保留现有全部能力：userId 隔离、连接状态轮询、
  启停/重连生命周期联动（`McpManager`）。
- **与 PRD 的显式偏差**：
  - PRD「路径提示 `/Users/.../mcp.json`」→ 无真实文件，显示假路径误导用户，改为
    编辑器顶部说明文案「JSON 与已安装服务实时同步，保存后生效」。
  - PRD「网络异常时提示无法连接 Hub」→ 外链由系统浏览器打开（`shell.openExternal`），
    应用内不做网络探测（Electron 常规做法）。
  - PRD「配置文件丢失自动重建」「权限申请」→ 不适用（无文件读写）。
- **市场 24 个连接器照 PRD 清单做前端静态数据**（无运营诉求，不入库）；品牌
  Logo 无版权资产，统一用 lucide 图标 + 主题色块。

## 1. 信息架构

```
专家页 Tab「连接器」（ExpertsView 不变，connectors 分支换挂新视图）
└── ConnectorMarketView（新，市场主页面）
    ├── 工具栏：搜索框「搜索连接器」｜「⊕ 自定义连接器」｜「⚙️ 配置 MCP」
    ├── 卡片网格（grid-cols-2 / md:3 / xl:4 响应式）
    └── McpManageDialog（新，弹窗，内部两态）
        ├── 列表态：标题区 + 工具栏（搜索 MCP / MCP Hub 外链）+ 已安装列表
        │   空态：Server 图标插画 + 引导「配置」按钮
        └── 编辑态：JSON 编辑器 + 「← 返回 MCP 列表」「取消」「保存」
            （自定义连接器另走保留的 McpServerDialog 结构化表单）
```

现 `McpSettingsView` 表格的全部能力（状态轮询、启停、重连、编辑、删除）迁入
弹窗列表态，**无功能损失**；`McpSettingsView.tsx` 删除。

## 2. 连接器市场视图（ConnectorMarketView）

### 数据：`lib/market-connectors.ts`

```ts
export interface MarketConnector {
  id: string;          // kebab-case，兼作 i18n key 段
  name: string;        // 品牌名原文（不翻译），同时是「已添加」匹配键
  icon: LucideIcon;    // lucide 图标组件
  template: McpServerTemplate; // JSON 编辑器预填片段
}
```

- 24 项清单照 PRD：通达信、腾讯自选股、QQ邮箱、ima、乐享知识库、腾讯文档、
  腾讯会议、企业微信、飞书、钉钉、腾讯问卷、TAPD、NeoData金融数据库、CNB、
  微云、福帮手、金山文档|WPS云文档、北大法宝·法律智能检索、企查查、天眼查、
  百度网盘、Tushare、邓白氏寰球全球、新华财经资讯MCP。
- 描述文案走 i18n：`ai:mcp.connectors.<id>.description`（zh-CN / en-US 双语），
  2-3 行、`line-clamp-3` 截断。
- **模板为占位骨架**（**假设**：各连接器真实 MCP 配置无公开权威来源，先给
  npx/http 骨架 + 占位 env 如 `"YOUR_API_KEY"`，后续可整体替换数据文件不影响结构）。
  transport 分布按常识：飞书/钉钉/企业微信等 CLI 型走 stdio 骨架，
  企查查/天眼查/Tushare 等数据服务型走 http 骨架。

### 卡片（对齐 SkillHubCard 范式）

| 元素 | 实现 |
| --- | --- |
| 左上图标 | `<MarketConnector.icon>` 于 `h-9 w-9 rounded-lg bg-primary-subtle` 色块 |
| 右上操作 | 三态按钮：`+` 待添加 / `Loader2` 处理中 / `Check` 已添加（禁用） |
| 标题 | name |
| 描述 | i18n 文案，`line-clamp-3 text-sm text-muted-foreground` |

- **「已添加」判定**：市场项 `name` ∈ 已配置服务器 `McpServerApi.list()` 的
  name 集（React Query 复用 `["mcpServers"]` key）。
- **搜索**：本地模糊过滤 name + 当前语言描述（大小写不敏感 includes）。
- **点 `+` 交互**：
  - 未添加 → 打开 `McpManageDialog` 并直入编辑态，把该项 `template` 合入当前
    JSON（已有同 key 则不重复插入）；保存成功后回到弹窗列表态。
  - 已添加 → 按钮为 Check 禁用；进列表态查看由「⚙️ 配置 MCP」承担。

## 3. MCP 服务管理弹窗（McpManageDialog）

内部状态机：`list | edit`（编辑态由 `+` 入口可带初始模板进来）。

### 列表态

- **标题区**：主标题「MCP 服务管理」、副标题「安装 MCP 服务，为 AI 扩展更多
  工具能力」、右上「⚙️ 配置 MCP」主按钮（进编辑态）、Dialog 自带关闭 X。
- **工具栏**：「搜索 MCP」输入框过滤名称；「🔗 MCP Hub」外链按钮
  （`shell.openExternal`，**假设**：目标 URL `https://mcp.so`，可后续替换）。
- **已安装列表**：迁自现 `McpSettingsView` 表格——名称/传输/状态（连接轮询
  `connecting` 3s 收敛）/工具数/启停 Switch/重连/删除（AlertDialog 确认）。
  行内不再有「编辑」按钮（改参数统一走 JSON 编辑器，避免两套编辑入口）。
- **空态**（服务器数为 0）：居中 `Server` 图标（`text-muted-foreground/40` 大号）
  +「暂无 MCP 服务器」+「点击配置按钮添加 MCP 服务器」+ 居中「配置」按钮
  进编辑态。

### 编辑态

- **顶部**：「← 返回 MCP 列表」（回列表态）、「取消」（等同返回）、「保存」。
- **说明文案**（替代 PRD 路径提示）：「JSON 与已安装服务实时同步，保存后生效」。
- **编辑器 `JsonConfigEditor`**：textarea 前景透明 + shiki JSON 高亮叠加层
  （`pointer-events-none`，同 font/line-height/padding 对齐）+ 自绘行号 gutter；
  失焦/输入防抖触发高亮重绘。非法 JSON 时编辑器红边框。
- 进入编辑态时取最新 `mcpServer:list` 序列化为 JSON（`JSON.stringify(..., 2)`）；
  初始无服务器时为 `{ "mcpServers": {} }`。

### 保存流

1. `parseMcpConfig(raw)` 前端校验；失败 → toast「JSON 格式错误，请检查」+
   编辑器红边框，**不调 IPC**。
2. 调新 IPC `mcpServer:sync`（入参为解析后的 mcpServers 对象）。
3. 成功 → toast「保存成功」（带 sync 返回的增/改/删计数汇总）、
   invalidate `["mcpServers"]`/`["mcp-statuses"]`、回列表态（市场卡片「已添加」
   随之刷新）。
4. 失败 → `mapIpcError` toast，停留编辑态。

## 4. JSON ⇄ 记录同步协议（核心）

### 纯函数模块：`src-react/domains/ai/mcp/lib/mcp-json.ts`

```ts
/** mcp.json 单服务器条目（stdio 与 http 二选一，字段均可选宽松解析） */
export interface McpServerJsonEntry {
  command?: string;
  args?: string[] | string;   // 原生数组或 JSON 字符串
  env?: Record<string, string> | string;
  url?: string;
  headers?: Record<string, string> | string;
}
export interface McpConfigJson { mcpServers: Record<string, McpServerJsonEntry>; }

/** 记录集 → JSON 文本（编辑器初始内容） */
export function recordsToJsonText(records: McpServerRecord[]): string;

/** JSON 文本 → 校验后的配置对象；错误抛带行号信息的 Error */
export function parseMcpConfig(raw: string): McpConfigJson;
```

- **transport 推断**：有 `command` → stdio，有 `url` → http，都有/都没有 →
  校验错误（条目粒度提示 `<name>：需提供 command（stdio）或 url（http）之一`）。
- **enabled 不进 JSON**：启停语义留给列表态开关。sync 时新增默认 `enabled: true`，
  既有同名记录保持原 enabled。
- **类型归一**：`args`/`env`/`headers` 原生对象/数组序列化为 JSON 字符串列
  （与 DB 存储口径一致）；`args` 必须是数组（元素字符串）、`env`/`headers`
  必须是对象（值为字符串），否则条目粒度校验错误。
- **名称校验**：key 含 `__` → 错误（沿用现有 `mcp__<server>__<tool>` 前缀约束）。
- 序列化排序：按 name 字典序稳定输出（避免 diff 噪声）。

### 后端：`mcp.repo.ts` 新增 `mcpServer:sync`

```
入参：{ mcpServers: Record<string, 序列化后的 create 参数> }（前端已归一）
行为：与该 userId 现有行按 name 全量 diff——
  JSON 有 / 库无  → create（enabled: true，联动 connect）
  JSON 无 / 库有  → delete（联动断开注销）
  同名            → 参数有变 → update（不自动重连，语义同现有 update；
                    enabled 保留库值）
  同名参数未变    → 跳过
白名单：electron/commons/ipc-channels.ts 增加 "mcpServer:sync"
```

**复用现有内部路径**：diff 循环体内直接调 `this.create/this.update/this.delete`
（它们已含 assertOwned（userId）、McpManager 联动），不另写联动逻辑；事务包裹
（`prismaClient.$transaction` 不覆盖 fire-and-forget 的 connect，仅覆盖行写）。
返回值：`{ created: number; updated: number; deleted: number }`（toast 汇总用）。

## 5. 国际化与样式

- 新文案全部走 `ai` namespace 的 `mcp` 节（zh-CN / en-US 同步新增）：
  市场节 `market.*`（搜索占位/自定义连接器/配置 MCP/已添加等）、弹窗节
  `manage.*`（标题/副标题/空态/返回/保存/说明文案）、`connectors.<id>.description`
  × 24、`syncSaved`/`jsonError`/`entryInvalid` 等校验文案。
- 遵循项目主题变量（`bg-primary-subtle`/`text-primary` 等，禁硬编码色）、
  弹窗 `border-border/50 rounded-lg shadow-lg`、触钮 hover 三件套。

## 6. 文件清单

| 动作 | 文件 |
| --- | --- |
| 新建 | `src-react/domains/ai/mcp/views/ConnectorMarketView.tsx`（市场主页） |
| 新建 | `src-react/domains/ai/mcp/components/McpManageDialog.tsx`（管理弹窗） |
| 新建 | `src-react/domains/ai/mcp/components/JsonConfigEditor.tsx`（JSON 编辑器） |
| 新建 | `src-react/domains/ai/mcp/components/ConnectorCard.tsx`(卡片，若市场视图超 20 行则拆出) |
| 新建 | `src-react/domains/ai/mcp/lib/market-connectors.ts`（24 项静态数据 + 模板） |
| 新建 | `src-react/domains/ai/mcp/lib/mcp-json.ts`(序列化/解析纯函数) |
| 修改 | `src-react/domains/ai/api/mcp.api.ts`（+`sync`、`McpServerSyncParams`） |
| 修改 | `electron/domains/ai/mcp/mcp.repo.ts`（+`sync` diff） |
| 修改 | `electron/commons/ipc-channels.ts`（白名单 +1） |
| 修改 | `src-react/domains/ai/experts/views/ExpertsView.tsx`（connectors 挂市场视图） |
| 修改 | `src-react/i18n/locales/{zh-CN,en-US}/ai.json`（mcp 节扩展） |
| 删除 | `src-react/domains/ai/mcp/views/McpSettingsView.tsx`（能力已迁入弹窗） |
| 保留 | `src-react/domains/ai/mcp/components/McpServerDialog.tsx`（自定义连接器表单入口） |

「⊕ 自定义连接器」按钮 → 打开保留的 `McpServerDialog`（结构化表单，新建模式）。

## 7. 测试策略

- `tests/ai/mcp-json.test.ts`：序列化（排序/transport 双形态/enabled 不出现）、
  解析（原生对象与 JSON 字符串双口径归一、transport 推断错误、args/env 类型
  错误、`__` 名称、顶层结构错误、非法 JSON 行号提示）。
- `tests/ai/mcp-sync.test.ts`：mock prisma + manager——三分支 diff（增/删/改）、
  同名参数未变跳过、enabled 保留库值、userId 隔离（只 diff 本人行）、返回计数。
- 既有 `mcp-manager.test.ts` / `mcp-integration.test.ts` 回归不动。
- 完成口径：`npm run test` + `npm run typecheck` + `npm run lint` 全绿。
