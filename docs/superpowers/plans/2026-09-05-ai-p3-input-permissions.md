# P3 交互重构实施计划（输入框卡片 · 权限分级 · 终端工具 · 模式系统）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 P3 spec：输入框卡片化（＋菜单/权限胶囊/文件引用 chips）、两级权限（默认审批/完全访问直执行+Modal 确认）、run_command 终端工具（危险拦截）、三态模式系统（agent/ask/plan，DB v3）。

**Architecture:** 权限为会话级内存 Map（PermissionStore）；模式持久化 session.mode；file-tools 按 ctx.fullAccess 放开路径边界；审批判定重写为「文件写+命令类工具 × full 模式跳审批」（MCP 永不豁免）。

**Tech Stack:** 既有栈；零新依赖；DB v3（session.mode）

**Spec:** `docs/superpowers/specs/2026-09-05-ai-p3-input-permissions-design.md`（执行者需同时阅读——含 PRD 逐字文案）

## Global Constraints

- Prettier 3 defaults；t() 全覆盖双语；主题变量 only；PRD 文案**逐字**（spec 已载，勿改写）
- agent/ 纯 Node 模块禁 import electron（permission-mode/command-tool 可测性；electron 集中 service）
- 危险拦截清单与权限无关常开；60s 超时；输出截断 8KB；文件引用 ≤512KB
- 完全访问不豁免 MCP（`mcp__*` 前缀判定）；read 类始终免审不变
- 测试 tests/**；v3 脚本幂等（--/ignore）
- R2：writeApprovedAt 读取路径全数移除（列保留）；ApprovalBanner「允许并记住」按钮删除

## 文件结构总览

```
新建：
  electron/infrastructure/script/v3/upgrade-table.sql     (T1)
  electron/domains/ai/agent/permission-mode.ts            (T1)
  electron/domains/ai/agent/command-tool.ts               (T2)
  src-react/domains/ai/chat/components/PermissionCapsule.tsx (T5，含 Panel/Modal 或拆分)
  src-react/domains/ai/chat/components/FullAccessModal.tsx   (T5)
  src-react/domains/ai/chat/components/PlusMenu.tsx       (T7)
修改：
  prisma/schema.prisma / Constants.ts                     (T1 v3)
  electron/domains/ai/chat/session.repo.ts               (T1 setMode + toSession)
  electron/domains/ai/agent/file-tools.ts                (T3 ctx.fullAccess 边界)
  electron/domains/ai/chat/chat.service.ts               (T4 集成)
  src-react/domains/ai/api/{chat,session}.api.ts + lib/ipc.ts (T1/T4)
  src-react/domains/ai/chat/components/{ChatInput,ApprovalBanner,MessageList}.tsx (T5/T6)
  src-react/domains/ai/chat/views/ChatView.tsx           (T6)
  i18n chat.json 双语                                    (T5/T6/T7)
  docs/guide.md                                          (T8)
测试： permission-mode.test.ts (T1) / command-tool.test.ts (T2) / permissions-integration.test.ts (T4) / v3-migration.test.ts (T1)
```

---

### Task 1: DB v3 + PermissionStore + 模式/权限 IPC（TDD）

**Files:**
- Create: `electron/infrastructure/script/v3/upgrade-table.sql`、`electron/domains/ai/agent/permission-mode.ts`
- Modify: `prisma/schema.prisma`（session 加 `mode String?`）、`electron/Constants.ts`（DATABASE_VERSION=3）、`session.repo.ts`（toSession + `setSessionMode(id, mode)` + IPC `session:setMode`）、`chat.service.ts`（IPC `permission:get/set`——store 挂 service）、`src-react/lib/ipc.ts`（3 通道）、`session.api.ts`（record+setMode 方法）
- Test: `tests/ai/permission-mode.test.ts`、`tests/ai/v3-migration.test.ts`

**Interfaces:**
- Produces:
  - `type AccessMode = "default" | "full"`；`class PermissionStore { get(sessionId): AccessMode; set(sessionId, mode): void }`（缺省 default）
  - `type SessionMode = "agent" | "ask" | "plan"`（api 层导出；DB null → "agent"，repo toSession 归一）
  - `SessionApi.setMode(id, mode)`；`ChatApi.getPermission(sessionId): Promise<"default"|"full">` / `setPermission(sessionId, mode)`
  - v3 SQL：`--/p 会话加模式列（P3：agent 默认/ask 仅问答/plan 计划）` + `--/ignore` + `ALTER TABLE session ADD COLUMN mode TEXT NULL;`

**Steps**：v3 SQL/schema/Constants → prisma generate → PermissionStore TDD（get 缺省/set 覆盖/会话隔离 3 例）→ v3 迁移测试（node:sqlite 两轮，抄 v2-migration.test.ts 模式改表名/列名/SQL 路径）→ repo/api/ipc → service 挂 store + 2 handler（get 返回 store.get；set 调 store.set，无会话校验静默收）→ 三闸（153+4）→ Commit `feat(ai): 会话模式列与权限存储（P3）`

### Task 2: 危险命令拦截 + run_command 工具（TDD）

**Files:**
- Create: `electron/domains/ai/agent/command-tool.ts`
- Test: `tests/ai/command-tool.test.ts`

**Interfaces:**
- Produces:
  - `isDangerousCommand(command: string): boolean`（导出供测）；清单（spec §3 五类）：`rm` 带递归/强制旗标且目标为 `/` 或 `/` 开头无子路径限定（正则实现：`/\brm\b[^|;&]*\s-[a-zA-Z]*[rf][a-zA-Z]*\b[^|;&]*(\s|^)\/(\s|$)/`——**执行时以测试矩阵为准调正则**，矩阵必须含：`rm -rf /`✗ `rm -rf /Users`✗（/ 开头即拦）`rm -rf ./node_modules`✓ `rm -r dist`✓、`mkfs`✗（任意）、`\bdd\b[^;]*\bof=\/dev\/`✗ `dd if=a of=b.img`✓、`:(){:|:&};:`✗（fork 炸弹字面/变体）、`chmod -R 777 /`✗ `chmod -R 777 ./x`✓）
  - `makeRunCommandTool(): ToolDefinition<{ command: string; cwd?: string }>`——name `run_command`、kind "write"、description「在工作空间内执行 shell 命令（默认需用户批准；完全访问时免确认）。返回退出码与输出。」
  - execute：`isDangerousCommand` 先拦（返回 `错误: 该命令被安全策略拦截（高风险破坏性操作）`）；`child_process.exec(command, { cwd: ctx.fullAccess ? (args.cwd ?? undefined) : 工作空间根（args.cwd 经 resolveSafePath，越界忽略）, timeout: 60_000, maxBuffer: 1024*1024 })` → stdout+stderr 合并截断 8KB；成功 `\`退出码 0\`\n<输出>`；非零/超时 `错误: 命令失败（退出码 N/超时）\n<输出>`
  - ToolContext（file-tools.ts）**T3 会加 fullAccess——本任务先在 command-tool 内自持类型**：接收 `{ workspacePath, sessionId, fullAccess }`（structural 兼容现有 ctx，多出的字段不冲突）

**Steps**：拦截矩阵 TDD（10+ 例）→ exec mock（vi.mock node:child_process）测退出码/超时/截断/cwd 回退 4 例 → 三闸（+~14）→ Commit `feat(ai): run_command 终端工具与危险命令拦截（P3）`

### Task 3: 文件工具完全访问边界放开

**Files:**
- Modify: `electron/domains/ai/agent/file-tools.ts`
- Test: `tests/ai/file-tools.test.ts`（追加）

**Interfaces:**
- Produces: `ToolContext` 增 `fullAccess?: boolean`（可选，缺省 false=现状）；`resolveSafePath(workspacePath, relative, fullAccess?)`——fullAccess=true 时**跳过校验**直接 resolve 返回（任意位置读写）；file-tools 各 execute 的 resolveSafePath/safeRealPath 调用透传 ctx.fullAccess（read_file/list_dir/search_files 在 full 下的路径基点：**args.path 为绝对路径时以该路径为基**——实现：fullAccess 且 path.isAbsolute(relative) → 直接用，否则仍以 workspacePath resolve——搜索/列目录的根同理：full 态接受绝对路径根）。**注意 search_files 的 collectFiles root 与 read 的边界判断都要覆盖**。

**Steps**：追加测试（full 态读工作空间外文件 ✓ / write 到任意路径 ✓ / default 态越界仍拒 ✓（回归锚）/ full 态相对路径仍基于工作空间 ✓）→ 实现 → 三闸 → Commit `feat(ai): 文件工具完全访问边界（P3）`

### Task 4: chat.service 集成（审批两级判定 · 模式组装 · 命令注册 · status）（TDD）

**Files:**
- Modify: `electron/domains/ai/chat/chat.service.ts`、`agent/tool-registry.ts`（或 Application 接线处——run_command 注册进 registry 初始集）
- Test: `tests/ai/permissions-integration.test.ts`

**Binding decisions:**
1. **审批判定重写**（runToolCall 现有 write 分支）：`needsApproval = def.kind==="write" && (def.name.startsWith("mcp__") || !fullAccess)`——fullAccess 来自 `this.permissions.get(sessionId)`；即 full 下 write_file/run_command 直执行，MCP 恒审批。**删除 isWriteApproved/workspace.writeApprovedAt 读取**（R2）。
2. **ToolContext.fullAccess** 注入：buildToolSet 组装时带 `fullAccess: permissions.get(sessionId)==="full"`。
3. **run_command 注册**：registry 初始集 `registerTools([...FILE_TOOLS, makeRunCommandTool()])`（tool-registry.ts 改种子）——注意 ask 模式的零工具在组装层过滤（见 4）。
4. **模式组装**（streamAndPersist）：
   - `mode = session.mode ?? "agent"`
   - ask：tools 空（不注入任何 ToolSet）、collectSkills 返回空（技能清单与 read_skill 全不注入）、system 仅 assistant 原文
   - plan：system 追加（buildSystemPrompt 之后）`\n\n`+计划指令段（spec §4 逐字）
   - agent：现状
5. **chat:status** 快照加 `accessMode`（getPermissions 透出）；`permission:get` 已有。
6. summarizeArgs 对 run_command：args.command 前 60 字符（现有通用逻辑可能已覆盖——确认，不足则补工具名特判）。

**Tests**（复用 chat.service.test mock 模式）：full 下 write_file 无审批 chunk 直 done / default 下有 awaiting-approval（回归）/ full 下 mcp__ write 仍 awaiting / ask 模式 ToolSet 空且 system 无技能段 / plan 模式 system 含计划指令 / run_command 在 ToolSet 且危险命令返回拦截串（经 registry 查 find("run_command")）→ 6 例。

**Steps**：TDD → 实现 → 三闸（+6）→ Commit `feat(ai): 两级审批/模式组装/命令注册集成（P3）`

### Task 5: 权限 UI（胶囊/面板/确认 Modal）+ Banner 去记住

**Files:**
- Create: `src-react/domains/ai/chat/components/PermissionCapsule.tsx`（含上弹 Panel）、`FullAccessModal.tsx`
- Modify: `ApprovalBanner.tsx`（删「允许并记住」按钮与 rememberAvailable 相关逻辑——props 保留兼容或清理调用链）、`MessageList.tsx`（banner 记住相关透传清理）、`ChatView.tsx`（权限态接线：挂载时 `ChatApi.getPermission` 存本地 state + setPermission 调用点）、chat.json 双语

**Binding UI spec:**
- 胶囊：`rounded-full border border-border/50 px-2.5 h-8 flex items-center gap-1.5 text-xs`；默认态 ShieldCheck `text-muted-foreground` + `t("chat:permission.default")`；full 态 Unlock `text-primary` + `t("chat:permission.full")`；ChevronUp 收尾。点击 → Popover（side top）内：状态描述文案（spec §2 两句逐字）+ Label「允许完全访问」+ Switch（受控：本地 optimistic + full 态关 → 直接 setPermission("default")）
- Switch 开 → 打开 FullAccessModal（AlertDialog，modal 强制）：结构按 spec §3.1.2 逐字（标题/风险文案/两项权限列表/免责 Checkbox 必选才激活确认按钮/取消+允许完全访问 destructive）；确认 → setPermission("full") + 关闭；任何取消 → Switch 回 false
- 会话切换：ChatPane 挂载 getPermission 初始化（key=session.id 已保证重建）
- i18n 键组 `permission.*`：default/full/panelDefaultDesc/panelFullDesc/allowFullAccess/modalTitle/modalRisk/fileOps/terminalOps/disclaimer/confirmFullAccess（PRD 文案逐字翻译双语）

**Steps**：组件 → Banner 清理 → 接线 → 三闸 → Commit `feat(ai): 权限胶囊与完全访问确认流（P3）`

### Task 6: 输入框卡片重构 + 文件引用

**Files:**
- Modify: `src-react/domains/ai/chat/components/ChatInput.tsx`（大改）、`ChatView.tsx`（ChatPane 输入区布局）、`electron/domains/ai/chat/chat.service.ts`（IPC `file:pickAndRead`：dialog openFile+multiSelections → 逐文件 stat/NUL/≤512KB → `Array<{path,content}|{path,error}>`）、lib/ipc.ts（通道）
- chat.json：`input.placeholder` 改 PRD 文案 + `attach.*` 键组（chips 移除/读取失败等）

**Binding UI spec:**
- ChatInput 新结构（props 增 `pendingFiles/onRemoveFile` 或内部自持+暴露发送拼装——**取内部自持**：`pendingFiles: Array<{path, content}>` state；onSend 回调签名改 `(content: string)` → **改为 `(content: string, files: Array<{path,content}>)`**，ChatView.handleSend 拼装注入块）；chips 渲染于卡片内 textarea 上方（`flex flex-wrap gap-1`，每 chip `📎 path 尾段 ×`）
- 卡片容器样式 spec §1（rounded-xl/border/-focus-within）；左上行：PlusMenu 占位（T7 前先留 ghost 按钮空槽——**T6/T7 连续执行，直接在 T6 留 `data-plus-slot`，T7 填**）+ PermissionCapsule（T5 组件）；右下行 ModelPicker + 发送/停止
- handleSend 拼装：`files.length>0` → 前缀块逐文件 `[引用文件 ${path}]\n${content}\n\n` + content
- 手测路径：＋菜单 T7 后闭环

**Steps**：service IPC → ChatInput 重构 → ChatView 布局 → i18n → 三闸 → Commit `feat(ai): 卡片式输入框与文件引用（P3）`

### Task 7: PlusMenu（五项 + 模式/专家子菜单）

**Files:**
- Create: `src-react/domains/ai/chat/components/PlusMenu.tsx`
- Modify: `ChatInput.tsx`（填 plus 槽：props `onPickFiles/onOpenSkills` 等——PlusMenu 自持多数逻辑，仅文件结果回传 chips 需回调）、chat.json `plus.*` 键组

**Binding spec:**
- DropdownMenu：添加文件（invoke file:pickAndRead → 成功项回调 onPickFiles；带 error 项 toast 丢弃）/ 模式（DropdownMenuSub 三选一，当前项 ✓；`SessionApi.setMode` + invalidate sessions；选中非 agent 在卡片显示小徽标——PermissionCapsule 右侧 `text-xs text-muted-foreground` 的 `ASK`/`PLAN`）/ 专家（Sub 列助手 + 「不使用」顶项 → setAssistant + invalidate）/ 技能（两项：提示文案项（禁用态「输入 @ 技能名可调用」）+ 打开技能目录）/ 连接器（navigate /module/ai/mcp）
- **模式徽标数据源**：session.mode 经 sessions query（setMode 后 invalidate 刷新，ChatPane 从 session prop 读）

**Steps**：组件 → 接线 → i18n → 三闸 → Commit `feat(ai): 加号扩展菜单与模式/专家子菜单（P3）`

### Task 8: 终验

- guide.md：P3 段（权限两级/模式三态/命令工具与拦截/文件引用）+ 移除指引核对（writeApprovedAt 列存留注记、新组件）
- 三闸（expect 153+4+14+5+6 = ~182）；DoD 八项手测清单转交人工
- Commit `docs(ai): P3 指南与收尾`

## 任务依赖

T1 → T4；T2 → T4；T3 → T4；T4 → T5/T6；T6 → T7；T8 最后。SDD 串行序：1 2 3 4 5 6 7 8。
