# P3 交互重构设计（输入框卡片化 · 权限分级 · 终端工具 · 模式系统）

- 日期：2026-09-05
- 状态：基于需求方 PRD v3.1 + 7 条裁定（R5/R6 已按反馈修订）
- 前置：P0-P2 已合并；本设计重构输入区交互并新增终端工具与模式系统
- DB：v3（session 加 mode 列）；零新依赖

## 决策记录

| # | 决策点 | 结论 |
|---|---|---|
| R1 | 完全访问持久性 | **会话级不持久**（内存 Map；重启/新会话回默认）。随时撤回立即生效 |
| R2 | 授权模型简化 | **废弃 workspace.writeApprovedAt 读取路径**：两级模型（默认=沙箱+审批 / 完全访问=直执行）取代 P1 三级；ApprovalBanner「允许并记住」按钮移除；DB 列保留不读（历史兼容，guide 注记） |
| R3 | 终端工具 | `run_command`：默认态审批 + cwd=工作空间根；完全访问直接执行 + 任意 cwd；**危险模式硬拦截常开**（见 §3）；60s 超时；stdout+stderr 合并截断 8KB 回喂 |
| R4 | @ 文件引用 | 文本文件 ≤512KB 读内容注入 user 消息前缀块 `[引用文件 <path>]\n<内容>`；二进制/超限返回错误提示不阻塞发送（toast） |
| R5 | 模式系统 | 三态（PRD 模式项扩展）：**默认 Agent**（现状全能力）/ **ASK 仅问答**（ToolSet 全空+技能清单不注入，纯对话）/ **PLAN 计划**（system 注入「先输出完整计划，经我确认前不调用任何工具」）；会话级选择，**持久化 session.mode**（null=Agent） |
| R6 | ~~网络声明注入~~ | **取消**（不注入任何网络相关 system 文本） |
| R7 | MCP 审批独立 | 完全访问不豁免 MCP 工具审批（PRD 权限列表严格限定文件+终端） |

## 1. 输入框重构（PRD §2）

ChatInput 重构为卡片式布局（`ChatPane` 内）：

```
┌────────────────────────────────────────────────┐
│ [＋] [🔒 默认权限 ^]      今天帮你做些什么？      │  ← 上行：控制区 + 占位
│                                                │
│  （textarea，field-sizing 自适应保留）           │
│                                                │
│                          [模型选择器] [发送⏎]   │  ← 下行右：模型 + 发送
└────────────────────────────────────────────────┘
```

- 容器：`rounded-xl border border-border/50 bg-card shadow-sm focus-within:border-primary/40 px-3 py-2`（PRD「圆角卡片悬浮感」）
- **左上「＋」按钮**（Plus 图标，ghost）：唤起扩展菜单（§4）
- **权限状态胶囊**（＋右侧）：默认态 `盾牌图标+「默认权限」+ChevronUp`；完全访问态 `Unlock 高亮+「完全访问」+ChevronUp`（`text-primary`）；点击向上弹出权限面板（§2）
- 右下：ModelPicker（复用现有，尺寸适配）+ 发送/停止按钮（现有逻辑）
- 占位符：`chat:input.placeholder`「今天帮你做些什么？@ 引用资产文件... / 调用技能与指令」
- 现有 ModelPicker/AssistantPicker 从输入行独立按钮移入卡片：ModelPicker 移下行右；**AssistantPicker 并入「＋→ 专家」子菜单**（输入行不再单独占位）；齿轮设置菜单**保留**（模型服务管理等入口不进 ＋ 菜单，两者职责分离——PRD 未规定模型服务管理入口，保持现状）

## 2. 权限控制模块（PRD §3.1）

**主进程** `agent/permission-mode.ts`：

```ts
export type AccessMode = "default" | "full";
export class PermissionStore {
  private modes = new Map<number /*sessionId*/, AccessMode>();
  get(sessionId): AccessMode;                    // 缺省 "default"
  set(sessionId, mode): void;                    // 随时切换立即生效（下一工具判定即查）
}
```

- 判定点：chat.service 的 runToolCall 审批分支重写——`kind==="write"` 且工具为**文件写/命令类**（`write_file`/`run_command`）且 `permissions.get(sessionId)==="full"` → 跳过审批直执行；MCP（`mcp__*`）与 read 类不受影响（read 本就免审）
- **IPC**：`permission:get(sessionId)` / `permission:set(sessionId, mode)`（set 时作废该会话未决审批中的文件/命令类？——**否**：已挂起的审批按原决议走（用户已在看着那个弹窗），新调用走新模式。简单且无竞态）
- **chat:status 快照**含 accessMode（切回会话胶囊状态恢复）

**渲染层**：
- `PermissionCapsule`（胶囊）+ `PermissionPanel`（向上弹出 Popover：状态描述文案（PRD 两句逐字）+「允许完全访问」Switch）
- Switch 开 → **全屏 Modal**（AlertDialog 强制交互）：标题「⚠️ 确认允许完全访问？」、风险文案逐字、权限列表两项（📂 文件操作 / 💻 终端命令，PRD 逐字）、免责勾选（必选才激活确认按钮）、[取消][允许完全访问]（destructive 警示色）；确认 → `permission:set("full")`；取消/关闭 → Switch 弹回
- 关闭路径：面板 Switch off → 直接 `permission:set("default")` 无需确认（PRD §4.1 撤回即生效）

## 3. 终端工具 run_command（PRD 场景 A/B）

`agent/command-tool.ts`（ToolDefinition，kind: "write"，name: "run_command"）：

```ts
parameters: z.object({
  command: z.string().describe("要执行的 shell 命令"),
  cwd: z.string().optional().describe("工作目录（默认工作空间根；完全访问时可用任意路径）"),
})
```

- 执行：`child_process.exec(command, { cwd, timeout: 60_000, maxBuffer: 1MB })`；stdout+stderr 合并；成功返回 `退出码 0\n<输出截断8KB>`；失败/超时返回 `错误: 命令失败（退出码 N/超时）\n<输出截断>`
- **cwd 策略**：默认态强制工作空间根（入参 cwd 经 resolveSafePath 校验，越界忽略回退根）；完全访问不限定
- **危险拦截（常开，与权限无关）**：`isDangerousCommand(command): boolean` 正则清单——`rm\s+(-[a-z]*[rf][a-z]*\s+)+/( |$)`（rm -rf 根）、`mkfs`、`\bdd\b.*of=/dev/`、`:(){:|:&};:`、`chmod\s+-R\s+777\s+/`、`mv\s+[^ ]+\s+/dev/null` 不拦（常见）……**清单**：以上前五类；命中 → 返回 `错误: 该命令被安全策略拦截（高风险破坏性操作）`，不执行
- 单测：清单矩阵（各危险形态/变形空格/正常命令不误伤）、cwd 回退、超时、输出截断、退出码语义
- **注入**：加入 FILE_TOOLS 同级 registry（`registerTools([runCommandTool])` 于 file-tools 旁；ToolContext 增 `fullAccess: boolean`——execute 判定 cwd 放开与审批跳过都在 service 层，工具只按 ctx.fullAccess 决定 cwd 校验严格度）

## 4. 「＋」扩展菜单（PRD §3.2）

`PlusMenu`（DropdownMenu，项按 PRD）：

| 项 | 行为 |
|---|---|
| 添加文件 | IPC `file:pickAndRead`（dialog 多选 → 逐个读 ≤512KB 文本）→ 引用文件加入卡片「待引用条」区（chips 可移除）；发送时拼注入（R4） |
| 模式 | 二级子菜单（Radix SubMenu）三选一（默认/仅问答/计划）→ `session:setMode`（新 IPC，写 session.mode）→ 卡片模式徽标显示当前模式（非默认时在胶囊右侧小徽标 `ASK`/`PLAN`） |
| 专家 | 子菜单列助手（AssistantApi.list）→ 选中即 `session:setAssistant`（等价原 AssistantPicker，快捷复选标记当前项） |
| 技能 | 打开技能目录（复用 `skill:openDir`）+ 首项「输入 @ 技能名可调用」提示文案 |
| 连接器 | 跳 `/module/ai/mcp`（PRD：网络访问唯一通道） |

**模式实现**（R5）：
- session.mode：`"agent"(null) | "ask" | "plan"`；`session:setMode` IPC + repo 方法 + v3 迁移（ALTER ADD COLUMN mode TEXT NULL）
- chat.service 组装时：`mode==="ask"` → tools 传空 + **技能清单不注入**（buildSystemPrompt 收空数组）+ read_skill 不注入；`mode==="plan"` → system 追加计划指令段：`当前处于计划模式：请先分析任务并输出完整可执行的计划（步骤/涉及文件/命令），在我明确确认之前不要调用任何工具执行操作。`；agent → 现状
- 历史/标题/搜索等其余行为三态共用

## 5. @ 文件引用（R4）

- 「＋→添加文件」选定后 chips 暂存于 ChatInput 本地 state（`pendingFiles: Array<{path, content}>`）
- 发送时：若有 pendingFiles，user 消息 blocks 前置 `text` 块 `[引用文件 <path1>]\n<content1>\n\n[引用文件 <path2>]\n<content2>\n\n`+ 原输入；chips 清空
- 主进程 `file:pickAndRead` handler：`dialog.showOpenDialog({properties:["openFile","multiSelections"]})` → 逐个 stat ≤512KB + NUL 检测 → 返回 `Array<{path, content} | {path, error}>`（二进制/超限带 error 理由，渲染层 toast 并丢弃该文件）

## 6. 运行时呈现（PRD §3.3）

- 场景 A（默认态审批）：复用 P1 ApprovalBanner（移除「允许并记住」按钮——R2）——argSummary 已覆盖文件/命令（run_command 摘要 = 命令文本前 60 字符）
- 场景 B（完全访问直执行）：ToolCallCard 天然显示「已执行/已读取」状态（现有 state 机制，无需新组件）；完全访问下 write_file 的 cwd 限制？——**PRD 说任意位置文件**：完全访问时 write_file/read 等的 resolveSafePath 边界放开（ctx.fullAccess 传入 file-tools：跳过工作空间校验）——**R3 扩展：文件工具同享完全访问的边界放开**（与 PRD 权限列表「任意位置的文件」一致；read 免审本就无碍，write 在 full 下直执行+任意路径）
- MCP 断开提示：现有错误回喂（「错误: MCP 服务不可用」）在 ToolCallCard 显示——满足 PRD §4.3

## 7. 测试策略

| 对象 | 方式 |
|---|---|
| PermissionStore | get/set/缺省/会话隔离 |
| isDangerousCommand | 矩阵：5 类危险形态+空格变形+相似安全命令不误伤（rm -rf ./node_modules ✓放行、rm -rf / ✗拦截） |
| command-tool 执行 | exec mock（child_process vi.mock）：退出码/超时/截断/cwd 回退/拦截优先 |
| 模式组装 | ask（零工具零技能注入）/ plan（计划指令段）/ agent 现状——buildSystemPrompt 与 ToolSet 双断言 |
| 完全访问判定 | full 下 write_file/run_command 跳审批直执行；default 下审批；MCP 不受 full 豁免 |
| v3 迁移幂等 | node:sqlite 两轮（同 v2 模式） |

## 8. 错误处理

- 命令超时/失败 → 错误串回喂（不断循环）；危险拦截同
- 文件引用读取失败 → 该文件丢弃 + toast，不阻塞发送其余
- permission:set 对不存在会话 → 静默 no-op
- Modal 中途关闭（Esc/点外）→ 视为取消，Switch 弹回

## 9. DoD

1. 新输入框卡片布局生效：＋菜单、权限胶囊、占位符、右下模型+发送
2. 默认权限发「读取 xx 文件」→ 审批横幅（无「允许并记住」）；「运行 ls」→ 命令审批
3. 开完全访问（Modal 勾选免责才可确认）→ 同类请求直接执行，卡片显「已执行命令：ls」
4. 会话中关开关 → 下一条命令恢复审批（立即生效）；重启应用 → 回默认权限
5. ASK 模式：纯对话（无任何工具调用、无技能注入）；PLAN 模式：先输出计划；模式重启保留
6. ＋→添加文件 → chips → 发送后消息含引用内容块
7. `rm -rf /` 在完全访问下仍被拦截
8. test/lint/typecheck 全绿；v3 旧库升级无感；GUI 手测清单转交人工

## 10. 明确不做（YAGNI）

- @ 的输入内联自动补全（输入 @ 字符触发弹窗联想）——P3 用＋菜单选文件，内联联想后续
- 完全访问的持久化/白名单目录；命令执行的白名单会话记忆
- MCP 在完全访问下的豁免（R7）；网络相关任何声明（R6 取消）
- 文件上传（PRD「上传」语义模糊，本地应用无上传目标）；多模态附件渲染（引用以文本注入）
