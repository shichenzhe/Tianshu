# 技能与工具/MCP 系统技术方案

> 调研基线：main 995bf652（2026-11-05）。路径基准：桌面端路径相对 `apps/tianshu-desktop/`，server 端相对 `apps/tianshu-server/`，共享包相对 `packages/`。本文所有路径/函数名/字段名均来自当前代码实测，未实现项如实标注。

## 1. 总览

天枢的「能力供给」由三层叠加构成，全部汇入同一个 LangChain 工具循环（`packages/tianshu-core/src/run-chat-stream.ts` 的 `createReactAgent + streamEvents(v2)` 多步循环，`recursionLimit` 保险丝，tool-result 自动回喂下一步）：

1. **技能层（skill）**：磁盘上的 `SKILL.md` 目录（Claude Code 同源格式子集），每 send 重扫、system prompt 清单注入 + `read_skill` 渐进披露，不直接进工具面（除挂载 `read_skill`/`create_skill` 两件）；
2. **内建工具层**：`electron/domains/ai/agent/` 下约 30 件静态注册工具（文件五件、bash、web 双件、browser 四件、todo 双件、工作流四件、专家/技能/调度/检索/展示组），经 `tool-groups.ts` 场景门控 + `filterDisabledTools` 用户禁用两层注入层过滤；
3. **MCP 连接器层**：`mcpServer` 表配置的外部 MCP server，`mcp-manager.ts` 连接 → `listTools` → 以 `mcp__<server>__<tool>` 前缀动态注册进同一注册表，超预算折叠为 `list_tools/call_tool` 两跳聚合。

三层共用**一套执行侧门禁**：`agent/tool-gate.ts` 的 `runToolCall` 包装每个工具的 `execute`——命令危险分级、文件门、批量删除预估门、审批挂起、`toolPermission` 记忆直执行。注入层过滤（禁用=对模型不存在）与执行侧门禁（block/ask/allow）是**两层独立机制**：业界所谓「执行侧 block 而非仅 prompt 注入过滤」，在天枢的对应实现即 `runToolCall`——权限语义不依赖模型「看不见」工具，模型发出的任何 tool_call（含 MCP、含老名别名归一后）都会经过执行侧硬门。反过来说，注入层过滤不是安全边界而是 token 经济学与产品语义（`tool-groups.ts` 头注释明示「场景门控是产品/token 语义而非安全语义」）。

无头端（`apps/tianshu-server`）经 `src/core/tools/` 移植桌面 golden 实现（逐字移植 + deps 注入面 + 单源别名层），`modules/tool` 另持有控制端桥回传端点；桌面被控面（`electron/domains/server-face/mcp-tap.ts`）把 MCP 管理面透出给远程控制端（capability `mcp`）。

```
模型 ←工具 schema 绑定面← AliasToolNode(新名集，46 工具双列不可见)
  │ 模型发 tool_call（可能是老名——模仿历史 blocks）
  ▼
canonicalToolName 归一（@tianshu/core tool-alias，三端单源）
  ▼
runToolCall 执行侧门禁（agent/tool-gate.ts）
  ├─ 命令门：resolveCommandGate 三档（block=程序黑名单 / ask=审批 / allow）
  ├─ 危险分级线：assessCommandRisk → HIGH/CRITICAL 强制审批
  ├─ 文件门 / 批量删除预估门（rm 目录 ≥50 条）
  ├─ 网络域免审面（fetch/browse/browser 四件/mcp__*）
  ├─ toolPermission 记忆（工作空间级）→ 直执行
  └─ 审批挂起 awaiting-approval → 渲染层决议卡 → 回喂文案继续循环
  ▼
工具 execute（内建实现 / MCP client.callTool）
  ▼
recordToolCall 埋点（toolCallEvent 表，state: done|denied|error）
```

**关键模块速览**：

| 模块 | 路径（`apps/tianshu-desktop/` 下） | 一句话职责 |
|---|---|---|
| 技能加载器 | `electron/domains/ai/agent/skill-loader.ts` | SKILL.md frontmatter 解析 + 目录扫描（每 send 重扫的底层） |
| 技能仓储 | `electron/domains/ai/skill/skill.repo.ts` | skillRecord 对账/启停/场景/统计/卸载 + IPC 注册 |
| 技能安装器 | `electron/domains/ai/skill/skill-installer.ts` / `skill-archive.ts` | zip 校验/暂存落盘/市场安装 |
| 技能注入 | `electron/domains/ai/agent/skill-prompt.ts` / `read-skill.ts` / `create-skill.ts` | system 清单注入 + 渐进披露读取 + 对话式创建 |
| 工具注册表 | `electron/domains/ai/agent/tool-registry.ts` | 静态初始集 + MCP 动态注册 + 禁用过滤 |
| 工具分组 | `electron/domains/ai/agent/tool-groups.ts` | 场景门控（核心/工作流/专家/展示组） |
| 执行门禁 | `electron/domains/ai/agent/tool-gate.ts` | runToolCall 全流程（命令/文件/审批/记忆） |
| 命令危险分级 | `electron/domains/security/command-risk.ts` | assessCommandRisk HIGH/CRITICAL 危险表 |
| MCP 管理器 | `electron/domains/ai/agent/mcp-manager.ts` | 连接/listTools/注册/预算折叠/竞态守卫 |
| MCP 仓储 | `electron/domains/ai/mcp/mcp.repo.ts` | mcpServer CRUD + IPC + McpManager 联动 |
| 工具循环 | `packages/tianshu-core/src/run-chat-stream.ts` | createReactAgent + AliasToolNode + 块状态机 |
| 别名层 | `packages/tianshu-core/src/tool-alias.ts` | TOOL_NAME_ALIASES + canonicalToolName 三端单源 |

## 2. 数据模型

### 2.1 技能两表（`apps/tianshu-desktop/prisma/schema.prisma:185`）

```prisma
model skillRecord {
  id          Int      @id @default(autoincrement())
  name        String   @unique   // = SKILL.md frontmatter name，去重键
  slug        String?            // SkillHub 市场来源 slug
  version     String?
  source      String             // builtin | local | market | user | workspace
  dir         String             // 技能目录绝对路径
  description String?
  enabled     Boolean  @default(true)
  scenarios   String?            // JSON 数组 ["daily","coding","design"]
  installedAt DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model skillStat {
  id        Int      @id @default(autoincrement())
  name      String
  event     String   // install | enable | disable | uninstall | batch_enable | batch_disable | batch_uninstall | create
  createdAt DateTime @default(now())
  @@index([name, createdAt])
}
```

- **skillRecord 不是源，是状态**：目录磁盘扫描（`agent/skill-loader.ts` `loadSkills`）才是文件源；`skill/skill-sync.ts:35` `syncSkillRecords(scanned, records)` 产出 `{toInsert, toDeleteIds, toUpdate}` 做对账——目录里消失的技能删行，新目录插行，`enabled/scenarios` 等 UI 状态保留（「目录为文件源、DB 为状态源」）。
- **skillStat 是独立埋点流**，不与 skillRecord 同步：`skill/skill-stats.ts:82` `recordSkillEvent(prisma, name, event)`（fire-and-forget 吞错——埋点失败绝不影响主流程）在 6 个写入点调用——`SkillInstaller.installItems`→`install`、`makeCreateSkillTool.execute`（`agent/create-skill.ts:203`）→`create`、`SkillRepository.setEnabled`→`enable/disable`、`batchSetEnabled`→`batch_enable/batch_disable`、`uninstall`、`batchUninstall`。聚合读经 `SkillRepository.stats()`（prisma `groupBy(["name","event"])` 下推 + `skill-stats.ts:127 aggregateGroupedSkillStats`）产出 `SkillStatItem {name, installs, creates, enables, disables, uninstalls, batchOps, lastActiveAt}`，走 IPC `skill:stats`。
- skillStat 的 `@@index` 不走 v1 快照，由 `ensureEventStatMaintenance` 启动幂等补建——避免快照 sha256 变化触发旧库 drop 重建（schema 注释明示）。
- 服务端镜像：`apps/tianshu-server/prisma/schema.prisma` 的 `SkillRecord`/`SkillStat`（`@@map("skillRecord")/("skillStat")`），注释标明「T6 移植 create_skill 工具所需表，逐字段复制自 mirror」。

### 2.2 MCP 与权限两表

```prisma
model mcpServer {           // schema.prisma:159
  id        Int      @id @default(autoincrement())
  name      String
  transport String             // "http" | "stdio"（parseMcpRow 归一）
  command   String?            // stdio 专用
  args      String?            // JSON 字符串列（parseJsonField 容错解析）
  env       String?
  url       String?            // http 专用
  headers   String?
  enabled   Boolean  @default(true)
  userId    Int?               // v12 多用户隔离
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([userId], map: "mcpServer_userId_index")
}

model toolPermission {      // schema.prisma:176 —— 工作空间级「已记住」清单
  id          Int      @id @default(autoincrement())
  workspaceId Int
  toolName    String          // 存老名（read_file 等），禁用语义跨改名延续
  createdAt   DateTime @default(now())
  @@unique([workspaceId, toolName], map: "idx_tool_permission_ws_tool")
}
```

`toolPermission` 的设计参照 Claude Code allowed-tools：审批卡上「记住此操作」落行，此后同工作空间同名工具直执行。它同时承载**两个语义**——`runToolCall` 的记忆直执行面（审批记忆），与安全中心的「用户禁用面」（`runtimeFilter` 读取同表，经 `filterDisabledTools` 在注入层剔除）。

### 2.3 监控两表

```prisma
model llmCallEvent {   // schema.prisma:481
  userId Int?; scene String  // chat | graph | automation
  modelId Int?; sessionId Int?; graphId Int?
  inputTokens Int; outputTokens Int; durationMs Int?
  @@index([userId, createdAt])
}
model toolCallEvent {  // schema.prisma:496
  userId Int?; scene String; toolName String
  state String  // done | denied | error（审批拒绝与安全门拒绝同口径计 denied）
  durationMs Int?; sessionId Int?
  @@index([userId, createdAt]); @@index([userId, toolName])
}
```

由 `@tianshu/core monitor-events.ts` 的 `recordLlmCall`/`recordToolCall`（fire-and-forget、PrismaLike 缺席静默跳过）写入；监控页聚合详见 `docs/design/monitoring.md`。

## 3. 核心技术方案

### 3.1 技能发现与注入

**磁盘格式（Claude Code SKILL.md 子集）**：每个技能 = 技能根下一个子目录，内含 `SKILL.md`；frontmatter 为 `---` 包裹的简易键值，**只解析 `name` 与 `description` 两个字段**（无 args 等扩展），缺一即跳过该技能。格式示例：

```markdown
---
name: jira-helper
description: 查询与创建公司内部 Jira 任务单
---
（正文为使用指引，read_skill 按需读取）
```

解析器 `agent/skill-loader.ts:36` `parseFrontmatter(raw)`；性能优化 `readHead()`（`FRONTMATTER_PEEK_BYTES = 4096`）只读文件头 4KB 探 frontmatter，畸形未闭合回退全读。扫描入口 `loadSkills(dirs: Array<{dir, source}>)`（skill-loader.ts:89）返回 `SkillInfo {name, description, dir, bodyPath, source}`，跳过点前缀隐藏目录（`.staging-*` 残留防幽灵技能）。技能根解析：`electron/commons/paths.ts:48` `skillsDir()` = `appDataDir("skills")` → `~/.tianshu/<分组>/skills`（数据根优先级 `TIANSHU_DATA_ROOT` 环境变量 > `data-root.json` 自定义 > 默认 `~/.tianshu`）；绑定工作目录的会话追加 `<工作区>/.tianshu/skills`（workspace 级技能）。

**每 send 重扫（无缓存）**：调用链 `chat.service.ts send() → streamAndPersist() → assembleContext()`（约 2178 行）→ `collectEnabledSkills`（1901）→ `collectSkills`（1888）→ `loadSkills(dirs)`——注释明确「每次 send 现算、无缓存——增删技能免重启生效」。与 WorkBuddy 的 watcher（rename 立即/change 防抖 3s）+ 8min lazy 兜底相反，天枢选择每轮全扫：技能量级小、4KB peek 成本低，换来零状态机、零 watcher 生命周期管理。同构副本：`orchestration/graph-executor.ts` `loadRunSkills`（图运行节点技能面）、`automation/resolve-attachments.ts`（定时任务附件解析）。

**两形态注入**：

1. **system 清单 + 渐进披露（progressive disclosure）**：`agent/skill-prompt.ts:16` `buildSystemPrompt(base, skills)` 在 system prompt 追加固定头（「你可以使用以下技能（调用 read_skill 工具并传入技能名可获取完整使用指引…）」）+ 每技能一行 `- name: description`；全文经 `read_skill` 工具按需读取（`agent/read-skill.ts:84` `makeReadSkillTool(skills, onRead)`：name 读 SKILL.md 正文、可选 path 读包内子文件如 `references/*.md`、`resolveWithinSkillDir` 双重边界防目录逃逸、256KB 截断、`onRead` 回调作为「读取即意图」信号——读到 `workflow-creator` 即把会话加入 `workflowIntentSessions` 集合驱动工作流组挂载）。ask 模式零技能注入；plan 模式技能段后追加 `PLAN_MODE_INSTRUCTION`。
2. **skill_ref 消息块（显式 ⚡ 引用）**：协议块类型 `packages/tianshu-protocol/src/chat-contract.ts:113` `SkillRefBlock { type: "skill_ref"; name: string }`，`ChatSendParams.skillRefs?: string[]` 携带；user 消息 blocks 前置 skill_ref 块（消息库不存全文），组装侧 `@tianshu/core blocks.ts:81` `blocksToModelMessages` 的 `loadSkill?: SkillBodyLoader` 参数把 skill_ref 展开为 `[引用技能 name] + SKILL.md 全文`（loader 实现在 chat.service.ts:2002，含 NUL 拒读 + 256K 截断）。前端 `ChatInput.tsx` 以 `⚡name` 内联 token（`chat/lib/inline-tokens.ts parseInlineTokens`）解析去重后随 `chat:send` 传主进程。

**安装与市场**：zip 安装经 `skill/skill-archive.ts` `validateArchiveEntries`（拒 zip-slip 与可执行扩展；上限 10MB/文件、50MB 总量、500 条目）、`locateSkillRoot`（SKILL.md 须在包根或唯一一级子目录）、`validateSkillMd`（必含 name+description）；落盘走 `.staging-` 暂存目录原子迁移（`skill/skill-installer.ts installSkillZip`，server 端同构移植）。SkillHub 市场（`api/skillhub.api.ts`：`skillhub:list/top/categories/install`）远端静态安全分级 `SkillHubSecurityStatus = "benign" | "caution" | "unknown"`；桌面被控端 SkillHubClient 宿主侧下载 zip 落盘（capability `skillhub`——移动端零流量只传 slug）。模型侧可用 `create_skill` 工具对话式创建技能（frontmatter name 须 kebab-case 且与目录一致），创建后进同一条「扫描→对账→注入」链路。

**技能生命周期**（六态，与 skillStat 事件一一对应）：

```
市场/zip 安装（install） ──┐
对话式创建（create）──────┤
                          ▼
                    [skillRecord 行 + 磁盘目录]
                          │
          启用/禁用（enable/disable，可批量 batch_*）←→ 每轮扫描对账
                          │
                    卸载（uninstall）
                    （builtin 拒卸载：skill-creator / workflow-creator）
```

每个生命周期动作都埋 skillStat 事件（fire-and-forget），管理页「统计」标签消费聚合结果；DB 行删除与磁盘目录删除同事务语义（目录删除失败行不删——下轮扫描会重新对账回来）。

**多维度过滤**：

- 全局开关：`SkillRepository.setEnabled`（`skill/skill.repo.ts:204`，updateMany + 埋点）；`setScenarios`（:221，白名单 `["daily","coding","design"]` 过滤后 JSON 落库）。内置技能 `BUILTIN_SKILL_NAMES = ["skill-creator", "workflow-creator"]`（`skill/builtin-skills.ts:16`，启动自愈安装于 Application.ts）不可卸载（`uninstallCore` 拒绝，卸载路径须 `isInsideDir(row.dir, skillsRoot())`）。
- `collectEnabledSkills` 只滤 **user 级**（`skill-sync.ts:67 filterDisabledSkills`：`source === "user" && disabled.has(name)`）——workspace 级项目本地技能不受全局开关影响（项目自治语义）；服务端等价逻辑内联在 `chat-runner.service.ts:1332`。
- 项目会话：`chat.service.ts:350 isolateProjectTools(skills, projectCtx)` 清单收窄为项目绑定技能交集（「预设≠围墙」，`read_skill` 工具仍全量可用）。
- 工作流组挂载信号：`skill.repo.ts:284 listGateStatus` 三列清单（name/source/enabled）供 `resolveWorkflowCreatorEnabled`（chat.service.ts:1925）三信号取或：会话内 read_skill 读过 / 用户侧安装（source!=="builtin"）且启用 / 场景命中。

### 3.2 内建工具族与命名别名层

**注册表**（`agent/tool-registry.ts`）：初始集 = `FILE_TOOLS`（read/write/ls/grep/rm，`file-tools.ts`）+ `makeRunCommandTool()`（bash，`command-tool.ts`）+ `makeWebTools()`（fetch/browse，`web-tools.ts`，内建 SSRF 守卫）+ `makeBrowserTools(guestControlResolver)`（browser 四件，`browser-tools.ts`，操控会话绑定的右栏浏览器 tab，guest 注册表解析操控目标）。MCP 经 `registerTools(defs)`/`unregisterTools(prefix)` 动态进出（就地过滤保持活数组引用有效）。`registry.find(name)` 内联 `canonicalToolName` 归一。

**完整工具面**（按注册文件，46 项双列见别名录）：

| 组 | 工具名 | 文件（`electron/domains/ai/agent/`） |
|---|---|---|
| 文件五件 | read / write / ls / grep / rm | `file-tools.ts` |
| 终端 | bash | `command-tool.ts` |
| web 双件 | fetch / browse | `web-tools.ts` |
| browser 四件 | browser_snapshot / browser_navigate / browser_click / browser_type | `browser-tools.ts` |
| 计划双件（项目会话） | todo_write / todo_read | `plan-tools.ts` |
| 技能双件 | create_skill / read_skill | `create-skill.ts` / `read-skill.ts` |
| 专家五件 | create_expert / update_expert / recommend_expert / list_experts / dispatch | `create-expert.ts` / `recommend-expert-tool.ts` / `dispatch-member-tool.ts` |
| 调度 | create_schedule | `automation-tool.ts` |
| 检索双件 | search_history / library_search | `history-search-tool.ts` / `library-search-tool.ts` |
| 工作流四件 | workflow_write / workflow_read / run_workflow / get_workflow_run | `workflow-tools.ts`（graph.repo 静态注册） |
| 展示四件 | show_table / show_summary / show_chart / confirm_form | `display-tools.ts` / `confirm-form-tool.ts` |
| 小组件 | widget | `widget-tool.ts` |
| MCP 动态 | mcp__\<server\>__\<tool\>（超预算折叠为 mcp__\<server\>__list_tools / call_tool） | `mcp-manager.ts` |

其中 `read_skill`、`dispatch`（专家团成员派发）为**每请求构造**（deps 持当次会话/成员/中止信号闭包），不进静态注册表；`show_*`/`confirm_form` 为消息流卡渲染配套（工作流结果表格/摘要/图表 + 执行确认表单）。

**工具定义形态**（`ToolDefinition`，`file-tools.ts` 导出类型）：`{name, description, parameters(zod schema), kind: "read" | "write", execute(ctx, args)}`——`kind` 是读写分级标签（tool-gate 免审判定消费），`execute` 收 `CommandContext`（持 sessionId/工作空间路径/onSecurityEvent 回调等），返回字符串回喂模型。以 bash 为例（`command-tool.ts`）：

```ts
const runCommandTool: ToolDefinition<z.infer<typeof runCommandSchema>> = {
  name: "bash",
  description: "执行工作空间内 shell 命令，返回退出码与输出；高危命令需批准",
  parameters: runCommandSchema,   // zod：{ command: string, ... }
  kind: "write",
  execute: async (ctx, args) => {
    if (isDangerousCommand(args.command)) { /* 安全事件 + 分流指引文案 */ }
    // … 工作空间 cwd 执行，stdout/stderr 合并截断 8KB（mergeOutput）
  },
};
```

输出侧统一瘦身：`tool-output-trim.ts`（core）对旧轮工具输出回喂前截断（只影响回喂副本，DB blocks/编辑重发/回看不动）；`TOOL_OUTPUT_SLICE = 2000` 在拒绝/中止文案截断口径上。

**命名别名层**（`packages/tianshu-core/src/tool-alias.ts`，纯数据零依赖三端单源）：2026-10-29「参照业界主流精简工具名」批，20 老名 → 15 新名单向映射 `TOOL_NAME_ALIASES`：

```ts
read_file: "read",  write_file: "write",  list_dir: "ls",  search_files: "grep",
delete_file: "rm",  run_command: "bash",  web_fetch: "fetch",  open_browser: "browse",
plan_create_item / plan_update_status / plan_append_summary: "todo_write",
plan_list_items / plan_get_item: "todo_read",
create_automation_task: "create_schedule",  recommend_experts: "recommend_expert",
dispatch_member: "dispatch",
create_workflow / update_workflow: "workflow_write",
list_workflows / get_workflow: "workflow_read",
```

`canonicalToolName(name)` 老名归一，新名/未知名/`mcp__` 前缀原样透传。历史 blocks 存老名**不迁移 DB**——三个消费点兜底：① `run-chat-stream.ts:58` `AliasToolNode extends ToolNode`（绑定面 `node.tools` 只出新名 schema、执行面 `runTool` 归一分发，46 工具双列对模型不可见）；② `tool-registry.find`/`filterDisabledTools` 与安全中心 `security/config-store.ts`（toolPermission 及安全配置存老名，禁用语义跨改名延续）；③ `src-react` 渲染匹配（老 blocks 兼容显示，如 `chat/lib/artifacts.ts`）。plan 五件参数形状不同（单条 vs 全量）仅做名字级路由，参数不匹配由 zod 报错让模型自纠；workflow 四件老参数是 write/read 子集，老名调用完全透明。

**注入层双过滤**（`chat.service.ts:1758 collectToolDefinitions`，装配输入 `ToolGroupGate {scenario, assistantBound, workflowCreatorEnabled}` 由 `assembleContext` 构造）：

1. **场景门控**（内层，`agent/tool-groups.ts filterToolsBySession`）：核心组 `CORE_TOOL_NAMES` 14 件恒注入（文件五件 + browser 四件 + browse + bash + fetch + create_skill + read_skill）；工作流组四件 + 展示组四件须 `scenario ∈ {automation, coding}` 或 workflow-creator 挂载信号（`isWorkflowGroupAllowed` 三信号取或）；专家组两件须 experts 场景或会话绑定专家。实现是**黑名单式**——门控组之外一律放行，`mcp__` 前缀与技能挂载工具照旧注入，新增工具不因不在核心组被误剔。
2. **用户禁用**（外层，`filterDisabledTools`）：安全中心禁用面，「禁用=对模型不存在」（SP6 裁定），双侧经 `canonicalToolName` 归一等价比较（老名 DB 行命中新名 def）。

未绑定工作目录的会话另有白名单（`collectToolDefinitions` 内 `workspaceScoped` 分支）：`mcp__*`/`browser_*` 前缀式 + bash/create_skill/create_expert/update_expert/library_search/search_history/widget/工作流无工作空间三件（`WORKFLOW_NO_WORKSPACE_TOOLS`）/create_schedule（落库走默认空间兜底）保留；文件五件/browse/fetch（需工作空间语境）剔除——2026-11-01 审查快修把 browser 四件从连带剔除中救回。plan 双件非项目会话剔除。

### 3.3 MCP 接入

**管理链路**：`electron/domains/ai/mcp/mcp.repo.ts`（`McpRepository`）注册 IPC `mcpServer:list/create/update/delete/reconnect/statuses/openHub`（经 `handleUser` 带 userId 隔离；`openHub` 外链 `MCP_HUB_URL = "https://mcp.so"`，渲染层不传 URL 防任意跳转）。secret 字段（headers/env 中的凭据）经 `security/secret-field.ts sealSecret/openSecret` 加密落库，读面恒掩码（`REDACTED_SECRET` 三态：undefined 保留 / null 清除 / 含掩码按未传——`mcp-contract.ts` 口径）。前端 `src-react/domains/ai/mcp/`：`McpManageDialog.tsx`（管理弹窗主组件）、`ConnectorCard.tsx`（连接器卡片，产品语义叫「连接器」）、`ConnectorMarketView.tsx`（市场发现页）、`lib/mcp-json.ts` + `JsonConfigEditor.tsx`（JSON 批量导入导出，`syncParamsChanged` 做增量同步）。`mcpServer:statuses` 轮询驱动状态徽标。

**transport 现状**（`agent/mcp-manager.ts`，SDK 为 `@modelcontextprotocol/sdk`）：

- `http` → `StreamableHTTPClientTransport`（MCP streamableHttp——现行标准 remote transport；SSE transport 未接入）；建链前 `assertMcpUrlAllowed`（mcp-manager.ts:138）经 `security/network-gate.ts getNetworkGate` 做 SSRF/域策略预判，deny 在 SDK transport 构造**之前**拦截（判定自身抛错视为放行 + winston error，生产注入面终审口径）；
- `stdio` → `StdioClientTransport`，子进程 env 经 `resolveMcpEnv` 合并代理注入（门未装/代理未启动原样返回）。**stdio 在桌面端本地可配可连**（存量能力，mcpServer 表 command/args 列即为其保留），但**远程写面明确只开放 HTTP**：`packages/tianshu-protocol/src/mcp-contract.ts` 头注释「写面 v1 仅 HTTP transport——stdio command/args 是被控宿主机进程执行面，移动端只读摘要（name/transport/enabled/status），不可创建/编辑参数；stdio 类型的 save 由服务端拒绝（`MCP_STDIO_FORBIDDEN`）」。按 2026-10-26 用户裁定，**stdio MCP 写面（远程创建/编辑 stdio server）明确不做**，本文第 6 节改进空间亦不含此项。

**生命周期**：`McpManager`（依赖注入 `createClient`/`prisma` 工厂，单测可换 fake）连接 → `listTools` → 以 `toolPrefix(serverName) = "mcp__<server>__"` 注册进 tool-registry；状态机 `McpServerState = "connecting" | "connected" | "error" | "disabled"`，`McpServerStatus {id, name, state, toolCount, deferred, error?}`。`ServerRecord.generation` 代际计数：connect 开始与 `setEnabled(false)` 各自递增，挂起的 connect 在 await 恢复后核对代际不符即整体丢弃结果（I1 竞态守卫）。重连/停用经 `unregisterTools(prefix)` 清旧注册。

**工具面预算折叠**（2026-11-01 批）：`MCP_TOOL_SURFACE_BUDGET_TOKENS = 4000`（`estimateTokens` 1token≈2 字符口径，与 `context-usage.ts toolDefinitionTokens` 同源）。依据实测：22 工具 HTTP MCP ≈12K 字符 ≈6K token/每轮；超线 server 折叠为 `mcp__<server>__list_tools/call_tool` 两聚合工具——引擎（langgraph）工具集静态绑定不支持动态挂载，defer 必须在注册层完成。`list_tools` 返回全工具目录（schema 仅在模型查询时进上下文——与专家目录出 system 批同构的渐进披露）；`call_tool` 按目录转发并白名单校验（目标工具不在目录即报错引导先 list），kind 恒 write 保守走审批（目标工具只读性运行时未知）。直接注册时 `tool.annotations?.readOnlyHint === true ? "read" : "write"` 定读写面（readOnlyHint 缺失按 write）。

**权限面**：`NETWORK_TOOL_NAMES`（fetch/browse/browser 四件）+ `mcp__` 前缀整体免审（2026-10-24 裁定——注入本就来自 enabled server，「已启用的连接器」语义天然成立）；`toolPermission` 记忆（工作空间级）对 MCP 同样生效（DB 行 toolName 存 `mcp__server__tool` 全名）；完全访问（full 档）直执行（含 MCP）。

**一次连接走查**（用户在连接器市场点「添加」到模型可调用）：

1. `McpManageDialog` 提交 → IPC `mcpServer:create`（`McpRepository.create`：secret 字段 `sealSecret` 加密落库）；
2. `McpManager.connect(row)`：http 型先 `assertMcpUrlAllowed` 过网络门 → `StreamableHTTPClientTransport` + `client.connect`；失败置 error 态（error 文案含 host 与规则）；
3. `listTools()` → 逐工具 `parseMcpRow` 无关的注册构造：`deferred = estimateTokens(直接工具面) > 4000`——线内直接注册（readOnlyHint 定 read/write kind），线外注册 `list_tools/call_tool` 两聚合；
4. `registerTools(defs)` 进注册表；`McpServerStatus` 经 `mcpServer:statuses` 透出（state/toolCount/deferred）；
5. 下一次 send 的 `collectToolDefinitions` 里 `registry.getDefinitions()` 自然带上新工具——**无重启、无刷新会话**；
6. 模型调用 `mcp__server__tool`（或折叠后 `call_tool` 两跳）→ `runToolCall` 门禁（write 未记忆挂审批；记忆过直执行）→ `client.callTool` → 结果回喂循环 + `recordToolCall` 埋点。

### 3.4 工具执行与权限过滤

**执行侧门禁 `runToolCall`**（`agent/tool-gate.ts:462`，包装注册表每个工具的 execute；签名 `(def, agent, toolCallId, input, abortSignal, onChunk?, finalStates?) → Promise<string>`）——这是「block 非注入滤」的真身，逐层：

1. **命令判定门（SP2）**：仅 bash；`resolveCommandGate(agent, toolName, input)` 三档——`block`（程序黑名单命中：输出 `COMMAND_BLOCKED_OUTPUT = "用户拒绝了此操作"` 回喂模型，终态 denied + `emitCommandEvent("command-safety.blocked", "blocked", {source:"blacklist"})` 安全埋点）/ `ask`（挂审批；`agent.unattended` 态强拒 `COMMAND_UNATTENDED_OUTPUT`）/ `allow`、`default` 回落既有链路；
2. **危险分级线（权限放宽 spec §4.5）**：`resolveCommandRisk → assessCommandRisk`（实现在 `electron/domains/security/command-risk.ts:83`，HIGH/CRITICAL 危险命令表）对 bash 评级——HIGH/CRITICAL 在 default 与 full 两档**均强制审批**（对齐 WorkBuddy bypass「requires confirmation every time」）；unattended 强拒；`command-safety.needs-approval` 埋点 source=risk-table；
3. **文件判定门（SP3/SP4）**：`FILE_GATE_TOOLS`（文件五件）经 `resolveFileGate`——block 挂审批（unattended 强拒；full 豁免）；`rm` 批量删除预估门 `resolveBulkDelete`（`BULK_DELETE_THRESHOLD_DEFAULT = 50` 条）无条件强制审批（回收站/备份保护不依赖审批照常兜底）；
4. **write 审批判定**：full 档直执行（含 MCP）；`toolPermission` 表已记住直执行；default 档审批面收窄为「高危询问」——`AUTO_EXEMPT_WRITE_TOOLS`（todo_write/create_skill/create_expert/update_expert——DB 写低风险免审集，spec §4.4）免审直执行；其余 write 未记忆挂起审批；
5. **审批流**：`requestToolApproval`/`awaitApproval`（tool-gate.ts:188/263）经 agent 回调推 `tool-request` chunk → 渲染层审批卡（`awaiting-approval` 状态块）→ 用户决议（approve 落记忆可选 / deny）；拒绝以 `TOOL_DENIED_OUTPUT` 文案回喂（循环继续不炸流）；`raceWithAbort` 中止竞速防流悬挂；中断时未终态工具块统一记 error「已中断」（`run-chat-stream.ts finalizeInterruptedToolBlocks`，非终态集 ready/awaiting-approval/running）。

**工具块状态机**（`ToolCallBlock.state`，`run-chat-stream.ts` 维护，前端渲染按态出卡）：

| 状态 | 进入时机 | 出口 |
|---|---|---|
| ready | 模型发出 tool_call（args 落块） | 执行开始 |
| awaiting-approval | runToolCall 挂审批 | 批准→running；拒绝/超时→denied |
| running | execute 在途 | 完成→done/error |
| done | 成功（output 落块） | 终态 |
| denied | 审批拒绝/安全门拒绝/中止（`finalStates` Map 显式标记） | 终态 |
| error | execute 抛错/输出「错误:」前缀/中断收尾（「已中断」） | 终态 |

**会话级权限模式**（`agent/permission-mode.ts`）：`AccessMode = "default" | "full"`，`PermissionStore` 纯内存 Map（进程生命周期，不落盘），未设置缺省 default（安全侧）；`listFull()` 供系统授权卡展示。`full` = 用户显式免责 + 内置硬线（程序黑名单/危险分级）其余询问全豁免；`unattended` 是第三运行态（自动化/图运行/无人值守）：一切 ask 强拒。审批记忆管理面五端点契约在 `packages/tianshu-protocol/src/permission-contract.ts`（`permission/listRemembered/revokeRemembered/revokeAllRemembered/fullGrants/revokeAllFull`——桌面被控面与无头端双端同批落地，full grants 最小公共形状 `{sessionId, title}`）。

**安全配置面**（`electron/domains/security/config-store.ts`）：命令黑名单/域策略/文件备份策略等存 option 表 `type="security"`，写为 upsert 语义纯函数（vitest 直测）；消费 `canonicalToolName` 归一工具名（`BUILTIN_TOOL_NAMES` 内建清单在 `security/defaults.ts`）——禁用配置与改名别名层同源。

**监控埋点**：审批拒绝/安全门拒绝/命令门拒绝均以 `state:"denied"` 同口径计 `recordToolCall`（spec §4.1 #3「安全门拒绝也是终态」）；`emitFileEvent`/`emitCommandEvent` 产 `command-safety.*`/文件事件进 `securityAuditLog` 域。

### 3.5 server 端对称实现

- **`src/core/tools/`**：桌面 golden 的移植副本——`tool-registry.ts` 头注释「自 mirror electron/domains/ai/agent/tool-registry.ts 移植」，无头集 = 文件五件 + bash + fetch + **browser 四件桥版**（`bridge/browser-bridge-tools.ts`，TB-T1：桥工具默认注册、无静态 capability 变化，运行时可用性由「有无活跃控制端连接」决定，离线即拒「桌面控制端不在线」）+ library_search + history_search；plan 双件与 create_skill 按会话装配注册（`ChatRunnerService`）；工作流四件 + 展示组由 GraphModule 启动工厂注册（deps 闭包 `GraphService.run`）——graph LLM 节点 `tools:true` 经 registry 获得。`tool-gate.ts`（23.5K）/`file-tools.ts`/`command-tool.ts`/`skill-loader.ts`/`skill-installer.ts`/`skill-archive.ts`/`read-skill.ts`/`create-skill.ts` 均为逐字移植 + deps 注入面（server jest partial-mock interop 坑的标准对策）。widget/mcp__/dispatch 等渲染层/编排专属工具无头端不注册。
- **`src/modules/skills/`**：`skills.controller.ts`（`@Controller('skills')`）五 POST 端点——`query`（清单/联想候选）、`read`（读全文）、`setEnabled`（启停，upsert skillRecord）、`installUpload`（base64 zip ≤3MB 直装，冲突返回 `{status:"conflict"}` + overwrite 二次确认）、`stats`（事件聚合）；`skills.service.ts` 的 `listSkills()` 动态 import `src/core/tools/skill-loader`，`skillsDir()` 解析 `tianshu.dataRoot` 配置（`TIANSHU_DATA_ROOT` 覆盖）下 `skills/`；DTO（`dto/skill-wire.dto.ts`）class implements 协议类型做编译期绑定。技能扫描对账语义与桌面同构（扫描态无记录视为 enabled=true）。
- **`src/modules/tool/`**（`tool.controller.ts`）：工具桥回传入口 `POST tool/respond`——控制端桌面执行结果（`ToolRespondDto {requestId, result}`，requestId 一次性，重复/未知/超时收敛 4005）经 `core/tools/bridge/bridge-registry.ts respondBridgeTool` 唤醒挂起的桥工具 promise；直连 HTTP 与 relay req 帧同达本路由。`@Public` 豁免 JWT 守卫；静态 token 守卫（TIANSHU_TOKEN）仍生效。
- **控制端桥执行面**（`electron/domains/server/bridge-executor.ts`，TB-T2）：无头端 `tool.request` 事件（广播给全部活跃控制端连接，多控制端并发首个 respond 生效）→ 本机隐藏 BrowserWindow 单例（GuestControl：executeJavaScript/loadURL）复用桌面 browser 四工具；read（snapshot）+ navigate（工具内 SSRF 已守）直执行，write（click/type）推 `server:bridgeApproval` 审批卡等渲染层 `server:bridgeDecision`（`BridgeApprovalCard.tsx`；本地 30s 上限 `BRIDGE_APPROVAL_TIMEOUT_MS`，拒绝为默认安全态，`BRIDGE_DENIED_ERROR = "denied by user"`）；结果 POST `tool/respond` 回传。
- **被控面 MCP 透出**（`electron/domains/server-face/mcp-tap.ts`）：`mcp/query|setEnabled` 两端点（capability `mcp`，仅桌面被控端——mcpServer 表在此，无头端无 MCP 概念不实现不报）；移动端/远程端只读摘要 + 启停，增删改引导回桌面端。
- **别名单源双侧**：`canonicalToolName` 自 `@tianshu/core` 单源——desktop 主进程经 alias 直引源码，tianshu-server 经 workspace dist 消费，双侧归一杜绝工具名双份漂移（2026-11-01 审查架构债项的收敛成果）。

## 4. 三端布局

| 端 | 技能 | 工具 | MCP | 位置 |
|---|---|---|---|---|
| 桌面端 | skillsDir 扫描/zip 安装/SkillHub 市场/管理页/⚡引用 | 静态注册表 + tool-gate 执行门 + 审批 UI | McpManager 全量（http 本地+远程、stdio 本地） | `electron/domains/ai/{skill,agent}`、`src-react/domains/ai/{skills,chat,mcp}` |
| 无头端 | `modules/skills` 五端点 + `core/tools/skill-*` 移植 | `core/tools/` 无头集 + 桥版 browser + `modules/tool` respond 端点 | 不实现（capability 不报，`DESKTOP_CAPABILITIES` 注释明示） | `apps/tianshu-server/src/{modules/skills,modules/tool,core/tools}` |
| 移动端 | 经 `skill-contract.ts`/skillhub 契约消费被控端（zip 宿主侧下载，零流量） | 无本地工具面（经被控端会话间接获得） | 经 `mcp-contract.ts` 只读摘要 + 启停（`MCP_STDIO_FORBIDDEN` 写面拒绝） | `apps/tianshu-mobile`（协议消费方） |

协议单份：`packages/tianshu-protocol/src/skill-contract.ts`（`SKILL_SCENARIOS`、`SkillBriefExtension`、`SkillSetScenariosPayload`、`SkillStatItem`、SkillHub DTO 族、`SKILL_ERROR_CODES = [SKILL_NOT_FOUND, SKILL_BUILTIN, SKILLHUB_UNAVAILABLE, SKILL_UPLOAD_INVALID]`）、`mcp-contract.ts`（`McpStatusItemDto/McpSavePayload/McpDetailResult`、`MCP_ERROR_CODES`）、`permission-contract.ts`（五段契约）。桌面技能管理页 api 通道（`skills/api/skill.api.ts SkillApi`）：`skill:list/setEnabled/setScenarios/batchSetEnabled/uninstall/batchUninstall/import(dryRun 预检)/pickImport/stats/readSkill/openDir`。

**测试布局**（vitest，真库依赖的 gate 集成测试显式 cwd 到沙箱——工作区周期性 reset 事故的纪律产物）：

| 测试 | 覆盖 |
|---|---|
| `tests/security/command-gate.test.ts` / `command-gate-integration.test.ts` | 命令门三档 + 黑名单 |
| `tests/security/file-gate-integration.test.ts` / `bulk-delete-gate.test.ts` | 文件门 + 批量删除预估门 |
| `tests/security/disabled-tools.test.ts` | 注入层禁用（SP6）+ 改名别名延续 |
| `tests/agent/tool-gate-session-id-null.test.ts` / `tests/ai/agent/approval-timeout.test.ts` | 无会话执行（图运行）+ 审批超时收敛 |
| `tests/ai/mcp-manager.test.ts` | MCP 连接/折叠/代际竞态（createClient/prisma 均可注入 fake） |
| `tests/ai/builtin-skills.test.ts` / `tests/core/workspace-files-scan.test.ts` | 内置技能自愈安装 + 共享扫描纯函数 |

## 5. 业界主流做法对比

**Claude Code skills（Anthropic Agent Skills）**：同样 SKILL.md + frontmatter（name/description）+ 渐进披露（清单常驻 system，正文按需读取），天枢与之间源到「每技能一行清单 + read_skill 两跳」的形态（skill-prompt.ts 头注释即参照）。差异点：① Claude Code skills 支持 `allowed-tools` 声明与 scripts/ 子目录可执行资源（技能可带代码），天枢技能是纯 prompt 资产（无 per-skill 工具白名单、无可执行资源——skill-archive 拒可执行扩展恰是有意收紧）；② Claude Code 按目录层级聚合（personal/project/team），天枢以 user/workspace 两级 + 项目 `boundSkillNames` 预设近似；③ 发现机制 Claude Code 启动扫描 + 提示词触发重扫，天枢每 send 全扫（更简单，技能量级小时无差）；④ Claude Code 技能市场分发（skills.anthropic.com 生态），天枢 SkillHub 自持 + mcp.so 外链。

**MCP（Model Context Protocol）**：业界 transport 已收敛为 streamableHttp + stdio（HTTP+SSE 已废弃）。天枢用官方 SDK 同轨；工具面预算折叠（4K token 线，超线折叠 list_tools/call_tool 两跳）与 Anthropic 官方对「MCP 工具过多导致上下文膨胀」的建议方案一致，且因 langgraph 静态绑定选择**注册层 defer**（而非消息层动态挂载），工程上是当下约束的合理解。天枢 http 入口前置 SSRF 门（`assertMcpUrlAllowed` 在 SDK transport 之前拦截）严于多数客户端实现。stdio 远程写面不开放（`MCP_STDIO_FORBIDDEN`）与「stdio 是宿主机进程执行面」的安全语义一致——业界托管产品（如 ChatGPT connectors）同样只收 remote MCP。

**OpenAI function calling + Apps/connector**：OpenAI 走「平台侧 connector 注册表 + OAuth 授权 + 每 action 审批」，工具定义进 Responses API `tools` 参数，运行时审批由平台 UI 承接。天枢不依赖托管平台：工具面本地注册、审批本地渲染层（awaiting-approval 块）、记忆本地表（toolPermission）——可控性与数据主权更强，代价是缺平台级 connector 生态与托管 OAuth。读写分级上两者同构（OpenAI per-action vs 天枢 read/write kind + 危险分级表）。

**Coze 插件商店**：Coze 以「插件 = 预封装 API 集合 + 平台统一鉴权 + 市场分发」为核心，模型侧只见工具 schema，插件在云端执行。天枢 SkillHub（`skillhub:list/top/categories/install`，benign/caution/unknown 安全分级）对标其市场分发形态，但分发的是 prompt 资产而非 API 封装；MCP Hub 外链（mcp.so）补 connector 发现。本质差异：Coze 插件云端执行（数据出域），天枢 MCP 在本地主进程执行（数据不出域）；Coze 无本地文件/终端类高权限工具，天枢有（故需要 tool-gate 全套门禁——这是「桌面级 agent」与「云端 bot builder」的分野）。

**Composio 统一工具层**：Composio 把数百 SaaS 工具统一成一致 schema + 托管 OAuth + per-action ACL（limit 清单：allow/deny 逐工具粒度）。天枢无外部统一层——对应物是内建注册表 + `filterDisabledTools`（工作空间级 allow/deny）+ tool-gate 危险分级 + toolPermission 记忆，粒度对齐 Composio 的 per-tool/per-action 混合面。差异：Composio 面 OAuth 托管与 schema 归一（输出格式统一），天枢 MCP 工具 schema 原样透传（各 server 参差，仅 token 预算折叠兜底）；Composio 是 SaaS 依赖，天枢自持。

**工具最小权限与运行时门禁范式**（Claude Code permission modes / WorkBuddy 工具控制三层 / OpenCode 等）：业界共识三层——注入面收窄（对模型不可见）、执行面硬门（运行时拦截，不信任 prompt 层过滤）、记忆面（allowed-tools 持久化 + 审批仪式）。天枢三层齐备且显式分层命名：`filterToolsBySession`（产品语义）→ `filterDisabledTools`（安全语义，SP6）→ `runToolCall`（执行硬门）→ `toolPermission`（工作空间记忆）+ `PermissionStore`（会话 full 档）+ `unattended`（无人值守强拒态）。WorkBuddy 对照（REQUIRED/PRODUCT/内置 MCP 三层注册、执行侧 block 非注入滤、HIGH/CRITICAL 硬审批）是天枢直接参照系，2026-10-24 权限放宽批吸收其 bypass 语义（default 档审批面收窄为高危询问）。天枢独有设计：unattended 态显式建模（业界多数靠「无人应答超时即拒」隐式达成）+ 批量删除预估门（参数级门禁先例）+ 工具改名的别名层兜底（DB 历史不迁移的工程取舍）。

**小结**：天枢与业界最大的分岔在「运行位置」——Claude Code/OpenAI/Coze/Composio 全部或部分依赖云端托管（市场、OAuth、connector 执行），天枢三层能力全部本地执行、本地治理（mcp.so 只做发现外链、SkillHub 只做分发），因此把工程重心放在**执行侧门禁与渐进披露**（token 经济学）而非生态集成；这与其桌面级数据主权定位自洽，也解释了为何 stdio 写面这类「远程操控宿主机进程面」的能力被显式排除。

## 6. 改进空间

以下均为可落地项（不含 stdio MCP 写面——已裁定不做）：

1. **技能 per-skill 工具面声明**：SKILL.md frontmatter 增可选 `tools` 字段（挂载该技能时附加注入对应工具组），对齐 Claude Code `allowed-tools`；现工作流组挂载已具备「技能即开关」语义（`WORKFLOW_CREATOR_SKILL_NAME` 三信号），可把该机制泛化为 frontmatter 声明驱动。改动集中：`skill-loader.ts`（解析新字段）+ `tool-groups.ts`（挂载信号源）+ `chat.service.ts` 装配；协议面 `SkillInfo` 加可选列（增量兼容）。
2. **技能市场安全分级自动化**：`SkillHubSecurityStatus`（benign/caution/unknown）目前是远端静态标注；可加本地静态扫描——SKILL.md 正文敏感指令模式（诱导读取凭据/危险命令的措辞）+ 包内文件构成检测（`skill-archive.ts` 已有可执行扩展拒绝基础），install 前复检并与远端标注取严，结果进安装确认弹窗。
3. **MCP 工具面折叠的会话级自适应**：`MCP_TOOL_SURFACE_BUDGET_TOKENS = 4000` 是全局静态线；可按会话 contextWindow（`context-usage.ts` 已有 token 估算面）动态调线——小窗模型更激进折叠、大窗模型保直注体验；折叠判定输入增 modelContextWindow 一维即可，注册逻辑不动。
4. **MCP 健康巡检**：`McpServerStatus` 只有连接时点状态，无周期探活——server 半死（TCP 活、MCP 死）要等首次调用失败才暴露，且失败后不自愈。可在 `mcp-manager.ts` 加低频 listTools 探活（复用 generation 守卫防与用户操作竞态；指数退避），状态变化推 `mcpServer:statuses` 事件（现轮询改订阅可选）。
5. **toolPermission 记忆的过期与审计面**：记忆条目目前无过期与使用计数（`createdAt` 后永久有效），长期授权面只增不减；可加 `lastUsedAt` 回写（`runToolCall` 记忆直执行分支顺手埋点，fire-and-forget 同款）+ 安全中心按「90 天未用」提示清理，附带按工作空间维度的记忆量统计。
6. **审批粒度从工具级到参数级**：`resolveBulkDelete` 已是参数级先例（rm 目录预估）；可把「write 限路径前缀」「bash 限命令前缀」纳入记忆形态——`toolPermission` 行增可选 pattern 列（如 `bash:git *`、`write:src/**`），`runToolCall` 记忆命中判定从全等改为模式匹配，对齐 Claude Code allowed-tools 规则语法（`Bash(git:*)` 形态）。需同步 `permission-contract.ts` 契约与双端。
7. **server 端工具面与桌面 golden 的单源收编**：`core/tools/` 移植副本靠 `check:drift` 容差守护，但 `assessCommandRisk` 危险表等安全语义双份无单测对照断言，分叉即安全漏洞；可把危险表与 FILE_GATE/免审集常量抽 `@tianshu/core` 单源（先例：canonicalToolName/monitor-events 收编），两端各持薄壳。`tool-alias.ts` 头注释已列「名字耦合点清单」可作迁移地图。
8. ✅ **MCP 调用结果进 monitor 聚合**（2026-11-05 落地）：`toolCallEvent` 已覆盖 MCP（toolName 带 `mcp__` 前缀，`@@index([userId, toolName])` 现成），`monitor-stats.ts` 增 `mcpServerOf` 切 server 段（`mcp__<server>__<tool>` 前缀后首个 `__` 为界）+ `MonitorStats.mcpByServer` 按 server 聚合（次数/成功率/平均延迟，total 降序）——零协议破坏（字段可选，旧端/移动端增量兼容）、零埋点变更，纯读面；桌面监控页新增「MCP 服务」聚合卡（mcpByServer 缺席时整卡不渲染，i18n 双语）；core 单测 `packages/tianshu-core/src/monitor-stats.test.ts` + server 端点 spec 锚 `mcp__github__create_issue` 聚合 + 桌面 MonitorView 渲染测试三端护栏。
9. **审批卡的会话外聚合入口**：审批挂起发生在会话流内，切走会话即看不见挂起卡（automation/graph 场景尤甚）；可在 monitor 或顶栏加「待审批」聚合角标（数据源 `finalStates` 挂起态或 face 事件总线），点击跳转对应会话。
