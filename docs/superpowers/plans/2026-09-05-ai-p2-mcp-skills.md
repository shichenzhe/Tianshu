# P2 扩展生态实施计划（MCP 接入 + SKILL.md 技能加载）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 P2 spec：MCP server 接入（stdio + streamable HTTP，readOnlyHint 分级审批，聚合进 tool-registry）与 SKILL.md 渐进披露技能加载（read_skill 内置工具 + system 注入）。

**Architecture:** agent/ 子域新增 mcp-manager（生命周期/状态机/工具注册）与 skill-loader + read-skill（文件系统即配置）；chat.service 的 ToolSet 组装扩展为「内置（含 read_skill）+ workspace 文件四件（绑定后）+ mcp__\*（manager 注册）」；零 DB 迁移；UI 仅一个设置页。

**Tech Stack:** 既有栈 + `@modelcontextprotocol/sdk`（唯一新增依赖）

**Spec:** `docs/superpowers/specs/2026-09-05-ai-p2-mcp-skills-design.md`（执行者需同时阅读）

## Global Constraints

- Prettier 3 defaults；t() 全覆盖双语；主题变量 only；overlay `border-border/50 rounded-lg shadow-lg`
- agent/ 子域模块禁 import electron **除 mcp-manager 的 transport 构造与 app 路径**（skill-loader 接收目录参数注入，保持可测；mcp-manager 以目录/行参数注入为主，electron 依赖集中并在测试中 vi.mock）
- MCP API 事实（预期，**执行时以 node_modules/@modelcontextprotocol/sdk .d.ts 为准**）：`import { Client } from "@modelcontextprotocol/sdk/client/index.js"`、`StdioClientTransport`（`sdk/client/stdio.js`）、`StreamableHTTPClientTransport`（`sdk/client/streamableHttp.js`）；`client.connect(transport)`、`client.listTools()` → `{ tools: Array<{ name, description?, inputSchema, annotations? }> }`、`client.callTool({ name, arguments })` → `{ content: Array<{ type, text? }> }`。不符时按实际调整并回报
- 错误回喂语义沿用 P1（"错误: …" 字符串 tool-result，不断循环）；MCP 审批不吃工作空间授权（spec 决策 #1）
- 工具命名 `mcp__<server>__<tool>`；read_skill 上限 256KB
- 测试 `tests/**`；zero-schema（mcpServer 表 P0 已建）

## 文件结构总览

```
新建：
  electron/domains/ai/agent/skill-loader.ts      (T1)
  electron/domains/ai/agent/read-skill.ts        (T2)
  electron/domains/ai/agent/mcp-manager.ts       (T4)
  electron/domains/ai/agent/skill-prompt.ts      (T3: buildSystemPrompt 纯函数)
  electron/domains/ai/mcp/mcp.repo.ts            (T6: 表 CRUD + IPC)
  src-react/domains/ai/mcp/views/McpSettingsView.tsx + components/McpServerDialog.tsx (T7)
测试：
  tests/ai/skill-loader.test.ts (T1) / read-skill.test.ts (T2) / skill-prompt.test.ts (T3)
  / mcp-manager.test.ts (T4) / mcp-integration.test.ts (T5)
修改：
  package.json (T1 装 SDK) / electron/Application.ts (T4/T6 接线)
  electron/domains/ai/chat/chat.service.ts (T3 system 注入、T5 ToolSet 合并)
  src-react/domains/ai/api/mcp.api.ts (T6 新建) / lib/ipc.ts (T6)
  src-react/routes/index.tsx (T7) / docs/guide.md (T8) / i18n (T7)
```

---

### Task 1: 依赖安装 + skill-loader（TDD）

**Files:**
- Modify: `package.json`（`npm i @modelcontextprotocol/sdk`）
- Create: `electron/domains/ai/agent/skill-loader.ts`
- Test: `tests/ai/skill-loader.test.ts`

**Interfaces:**
- Produces:
  - `interface SkillInfo { name: string; description: string; dir: string; source: "user" | "workspace"; }`
  - `loadSkills(dirs: Array<{ dir: string; source: "user" | "workspace" }>): SkillInfo[]`——按数组序（用户级在前）加载，同名后者忽略；SKILL.md 正文路径约定 `<dir>/<entry>/SKILL.md`；frontmatter 解析 `parseFrontmatter(raw): { name?: string; description?: string }`（`---` 行包裹块内逐行 `^(\w+):\s*(.+)$` 提取，缺 name 或 description 的跳过）；目录不存在/不可读 → 静默跳过该 dir

- [ ] **Step 1** `npm i @modelcontextprotocol/sdk`（并记录版本到报告）
- [ ] **Step 2** 写失败测试（临时目录矩阵）：标准两级加载与同名优先 / 无 frontmatter 跳过 / 缺 description 跳过 / 非法目录静默 / name 含空格保留原样（目录名与 frontmatter name 不一致时以 frontmatter name 为准，目录名仅作定位）
- [ ] **Step 3 RED → 实现（纯 node:fs/promises readdir+readFile，无 electron）→ GREEN**
- [ ] **Step 4 三闸 + Commit** `feat(ai): SKILL.md 扫描与 frontmatter 解析（P2）`

### Task 2: read_skill 内置工具（TDD）

**Files:**
- Create: `electron/domains/ai/agent/read-skill.ts`
- Test: `tests/ai/read-skill.test.ts`

**Interfaces:**
- Consumes: T1 `SkillInfo`/`loadSkills`
- Produces: `makeReadSkillTool(skills: SkillInfo[]): ToolDefinition<{ name: string }>`——execute 查 skills 中 name（精确匹配）；未知名 → `"错误: 技能不存在"`；读 `<dir>/<name>/SKILL.md` 全文（注意：以 SkillInfo.dir + 再拼 entry？——**修正：SkillInfo 增 `bodyPath: string` 字段（T1 一并产出），此处直接读 bodyPath**）；≤256KB 超限截断尾部加 `…（已截断）`；kind: "read"；description 中文「读取指定技能的完整使用指引（SKILL.md 正文）」

- [ ] Steps：TDD（存在/未知名/截断/路径穿越——skills 数组外的 bodyPath 无法触达因 execute 只查表内 name → 天然隔离，测试钉死「未知名不落盘任何读取」）→ 三闸 → Commit `feat(ai): read_skill 内置工具（P2）`
  （T1 若未含 bodyPath 字段，本任务补上并同步 T1 测试——在报告注明）

### Task 3: system prompt 注入（TDD）

**Files:**
- Create: `electron/domains/ai/agent/skill-prompt.ts`
- Modify: `electron/domains/ai/chat/chat.service.ts`（streamAndPersist 组装 system 处调用——定位：assistantRow?.systemPrompt 赋值点，改为 `buildSystemPrompt(assistantRow?.systemPrompt, skills)`）
- Test: `tests/ai/skill-prompt.test.ts`

**Interfaces:**
- Produces: `buildSystemPrompt(base: string | undefined, skills: SkillInfo[]): string | undefined`——skills 空时原样返回 base（可能 undefined）；非空时模板（spec §2 模板逐字）追加；调用点：send/regenerate 前 `loadSkills(userSkillsDir, workspaceSkillsDir?)` 即时扫描（userSkillsDir = `app.getPath("userData")/skills` 经 service 注入或直接 electron 调用集中在 service 层）

- [ ] Steps：TDD（无 skills 返 base / 有 skills 追加段含全部 name: description / base undefined + skills → 仅技能段 / 换行拼接正确）→ 三闸 → Commit `feat(ai): 技能清单渐进披露注入 system（P2）`

### Task 4: mcp-manager（TDD，SDK API 校验点）

**Files:**
- Create: `electron/domains/ai/agent/mcp-manager.ts`
- Modify: `electron/Application.ts`（registerServices 接线 `new McpManager(...)` + `void manager.startupConnectAll()` fire-and-forget）
- Test: `tests/ai/mcp-manager.test.ts`

**Interfaces:**
- Produces:
  - `interface McpServerRow`（prisma mcpServer 行：id/name/transport/command/args/env/url/headers/enabled——JSON 字段在 repo 层 parse，manager 接收已解析对象 `{ id, name, transport, command?, args?: string[], env?: Record<string,string>, url?, headers?: Record<string,string> }`）
  - `class McpManager`：
    - `constructor(deps: { createClient: (row) => Promise<McpClientLike>; registerTools: typeof registerTools })`——**client 工厂注入**（测试 fake；生产实现 import SDK 构造 Client+Transport）
    - `startupConnectAll(): Promise<void>`（查 enabled 行逐个 connect，失败记状态不抛）
    - `connect(row): Promise<void>`（connected → 每工具注册 `mcp__<name>__<tool>`，kind = annotations?.readOnlyHint === true ? "read" : "write"；重连前先 unregister 旧工具——**tool-registry 需加 `unregisterTools(prefix)`：本任务实现**（按 name 前缀过滤移除））
    - `setEnabled(id, enabled)`（关 → unregister + 断开；开 → connect）
    - `getStatuses(): Array<{ id, name, state, toolCount, error? }>`（state: connecting|connected|error|disabled）
  - `interface McpClientLike { listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: unknown; annotations?: { readOnlyHint?: boolean } }> }>; callTool(args: { name: string; arguments?: unknown }): Promise<{ content?: Array<{ type: string; text?: string }> }>; close(): Promise<void>; }`
  - 工具 execute 闭包：调 client.callTool → content 中 type==="text" 的 text 以 "\n" join；client 已断/抛错 → `"错误: MCP 服务不可用（<server>）"`；inputSchema 透传给 ToolDefinition.parameters（**SDK 的 inputSchema 是 JSON Schema——而 ToolDefinition.parameters 是 zod**！适配：`z.custom()` 宽容透传？——**修正设计**：ToolDefinition.parameters 放宽为 `z.ZodType | JsonSchemaObject`，或 mcp 工具定义绕过 zod 用独立通道。**取：registry/ToolDefinition.parameters 类型放宽为 `z.ZodType<any> | object`，chat.service 的 buildToolSet 传 SDK 时 parameters 字段直接给 inputSchema 对象（SDK 接受 JSON Schema）——在 T5 处理，T4 的 ToolDefinition 构造用 `parameters: inputSchema ?? z.object({})`**）
- SDK 生产工厂（mcp-manager 内部 `defaultCreateClient`）：**先读 node_modules/@modelcontextprotocol/sdk 的 .d.ts 核实**导入路径与构造签名（Client 构造/transport 选项），不符按实际回报再写；stdio: `new StdioClientTransport({ command, args, env })`；http: `new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } })`（预期形态）

- [ ] Steps：TDD（fake client：connected 注册计数与 mcp__ 前缀 / readOnlyHint 三分支 kind / 连接失败 error 状态不抛 / setEnabled off→unregister / 断连后调用返回错误串——经注册的 execute 调用）→ 三闸 → Commit `feat(ai): MCP 生命周期管理与工具注册（P2）`
  （SDK 真连不在单测——报告记录 .d.ts 核实结论）

### Task 5: chat.service 集成（TDD）

**Files:**
- Modify: `electron/domains/ai/chat/chat.service.ts`
- Test: `tests/ai/mcp-integration.test.ts`

**Interfaces:**
- Consumes: T4 registry 的 mcp__ 工具（经 registry.getDefinitions 自然到达——**chat.service 现有 buildToolSet 按 registry.getDefinitions() 遍历**；P1 现状是「绑定才有文件工具」——确认现状后调整：ToolSet 组装 = read_skill（常驻）+ 文件四件（绑定后）+ mcp__（registry 全量）；若 P1 实现为 registry 只含文件工具且绑定逻辑在 service，则本任务把 mcp-manager 注册的工具也并入：`registry.getDefinitions()` 已天然包含（manager 用同一 registry）——**关键改动点：P1 的「未绑定 → 无工具」分支需改为「未绑定 → 仅 read_skill + mcp__」**）
- Produces: 无新接口；行为变更（DoD 7 零回归除外——未配置 MCP/skill 时 read_skill 仍会注入！**与 spec DoD 7「与 P1 完全一致」冲突——修正 spec 解释：DoD 7 指「无可见行为变化」，read_skill 常驻注入属 P2 新增预期行为，DoD 7 判定标准调整为「无回归错误且纯对话流式正常」**，此修正在 T8 时写回 spec 或 guide）

- [ ] Steps：TDD（注入的 ToolSet 含 read_skill 常驻 / 绑定后含文件+mcp / 未绑定含 read_skill+mcp；MCP 审批不吃工作空间授权——write 类 mcp 工具在已授权工作空间仍 awaiting-approval）→ 三闸 → Commit `feat(ai): agent ToolSet 合并 MCP 与 read_skill（P2）`

### Task 6: mcp.repo + api + IPC

**Files:**
- Create: `electron/domains/ai/mcp/mcp.repo.ts`、`src-react/domains/ai/api/mcp.api.ts`
- Modify: `src-react/lib/ipc.ts`、`electron/Application.ts`（repo 接线；manager 与 repo 的联动：repo 的 create/update/delete/setEnabled 后调 manager 对应方法——**在 repo 内持 manager 引用或 Application 层组装，取简单者：repo 构造接收 manager?**

**Interfaces:**
- Produces: `mcpServer:list/create/update/delete/reconnect/setEnabled/statuses` 七通道；`McpServerRecord`（含解析后的 args/env/headers 对象字段或 JSON 字符串——**取 JSON 字符串保持表单简单，UI 层 stringify/parse**）；delete/reconnect/setEnabled 同步驱动 manager

- [ ] Steps：实现（repo CRUD 模式照 session.repo；JSON 列存取）→ 三闸 → Commit `feat(ai): mcpServer 仓储与 IPC（P2）`

### Task 7: McpSettingsView 设置页

**Files:**
- Create: `src-react/domains/ai/mcp/views/McpSettingsView.tsx`、`src-react/domains/ai/mcp/components/McpServerDialog.tsx`
- Modify: `src-react/routes/index.tsx`（`/module/ai/mcp`）、i18n ai.json 双语（`mcp.*` 键组：页面标题/描述/transport 两型标签/状态徽标四态/启停/重连/删除确认等 ~15 键）、ProviderSettingsView 顶部或 Sidebar 加入口（取 Sidebar 模块区无改动成本最低的：路由可达 + AI 相关页面互链——在 ProviderSettingsView 页头加一个跳转链接按钮）

- 表格列：名称 / 传输（badge: stdio|http）/ 状态徽标（connected 绿点文本色 text-primary、error text-destructive、connecting/disabled text-muted-foreground）/ 工具数 / 启停 Switch / 操作（编辑、重连 error 时、删除 AlertDialog）
- Dialog：transport Select 切换两组字段（stdio: command/args(JSON)/env(JSON)；http: url/headers(JSON 含 Bearer)）+ enabled Switch + name；JSON 输入校验复用 parse 模式（非法 → toast ai:mcp.invalidJson）

- [ ] Steps：实现 → 三闸 → Commit `feat(ai): MCP 服务管理设置页（P2）`

### Task 8: 终验

**Files:** docs/guide.md（P2 能力说明 + 移除指引核对：mcp 域/skills 目录/依赖项）；spec DoD 7 措辞修正（见 T5）

- [ ] 三闸（expect 100+T1~T5 新增）→ Commit `docs(ai): P2 指南与收尾`
- DoD 八项手测清单转交人工（spec §6）

## 任务依赖

T1→T2→T3；T4 独立（SDK 校验）；T4+T3→T5；T4→T6→T7；T8 最后。SDD 串行序：1 2 3 4 5 6 7 8
