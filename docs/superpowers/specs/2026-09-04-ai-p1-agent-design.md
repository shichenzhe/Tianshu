# P1 Agent 能力设计（工具调用循环 + 审批 + 工作空间文件工具）

- 日期：2026-09-04
- 状态：设计已与需求方五段逐项确认
- 前置：P0（chat 核心）+ P0.5（体验快赢）已合并；本设计激活 P0 预留接口（ToolCallBlock、workspace.directoryPath）
- 路线：P1 之后为 P2（MCP + SKILL.md，聚合进本文的工具注册表）

## 决策记录

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 审批粒度 | 读写分级：read 类（read_file/list_dir/search_files）免审；write 类（write_file）每次审批，除非工作空间已持久授权 |
| 2 | 授权记忆 | 工作空间级、跨会话持久（workspace.writeApprovedAt），UI 可见可撤销；撤销即恢复审批 |
| 3 | 步数上限 | 参照 Claude Code：宽上限做保险丝——常量 50 步；上下文截断为自然限界；用户随时中断 |
| 4 | 拒绝语义 | 拒绝以 tool-result `"用户拒绝了此操作"` 回喂，循环继续（模型自适应换路或解释）；不终止循环 |
| 5 | 中断语义 | 沿用 P0 abort：已落库内容保留；未决审批全部作废（resolve 拒绝）+ 状态机复位 |
| 6 | 工具集边界 | 路径全部限定工作空间内（resolve+realpath 前缀校验）；read ≤512KB / write ≤1MB；不做危险后缀黑名单（YAGNI） |
| 7 | search_files | 对齐 Claude Code Grep：正则 pattern + glob 过滤 + output_mode（content/files_with_matches）+ head_limit≤50；默认排除 node_modules/.git/dist；纯 Node 实现零新依赖 |
| 8 | UI 形态 | 内联折叠工具卡 + 消息流内联审批（无模态）+ 输入框上方细进度条 |
| 9 | 工具注入 | 按绑定状态动态：未绑定目录 = 纯对话（P0 体验零打扰）；绑定即注入 4 文件工具 |
| 10 | 注册表 | 单一 tool-registry（name/description/parameters(zod)/execute/kind）；P2 MCP 工具聚合进同一 registry，agent loop 不感知来源 |

## 1. 总体架构与 Agent Loop

```
electron/domains/ai/
├── agent/
│   ├── tool-registry.ts   # ToolDefinition 接口 + 内置工具注册表
│   ├── file-tools.ts      # 4 个内置文件工具（路径安全 + 限制）
│   └── approval.ts        # pendingApprovals Map（toolCallId → resolver）
└── chat/chat.service.ts   # streamAndPersist 升级为 agent loop
```

数据流（chat:send / chat:regenerate 触发）：

1. 解析上下文（模型/助手/参数合并/历史）——沿用 P0
2. 工具集注入：workspace.directoryPath 已绑定 → registry 文件工具（SDK tool() 包装，execute 闭包携带 ToolContext{workspacePath, sessionId}）；未绑定 → 空工具集
3. 循环（≤ MAX_STEPS=50）：`streamText({ model, tools, messages, ... })` fullStream 逐 part：
   - text-delta / reasoning-delta → 累积 + 推 chunk（同 P0）
   - tool-call → 推 tool-update（state: ready，含 args）；kind=write 且工作空间未授权 → approval.request()：推 approval-request chunk，execute 内挂起 Promise
   - tool-result → 推 tool-update（终态 + output）
   - 流自然结束（模型不再调工具）→ 退出循环
4. 持久化：blocks 为有序序列（text / thinking / tool_call 按发生顺序穿插 + 尾部 usage）；中断时未完成工具记 error("已中断")
5. 历史回喂：tool_call 块映射为 SDK ModelMessage 的 tool-call/tool-result 格式（续聊时模型可见自己上轮工具使用）

**审批挂起**：工具 execute 为 async——write 未授权时 execute 内推审批请求并返回挂起 Promise（resolver 存 pendingApprovals）；渲染层 invoke `agent:approve(toolCallId, approved)` → resolve：true → 执行写入；false → 返回拒绝文案。中断/窗口销毁 → 作废全部 pending + 复位。

chunk 分工说明：`tool-update(state=awaiting-approval)` 负责更新卡片状态；`approval-request` 携带 `argSummary`（人读摘要）供审批横幅直显——二者各司其职，UI 需同时消费。**授权判定时机**：每次 write 的 execute 实时查 `workspace.writeApprovedAt`（不做流开始时快照）——撤销授权对流中后续写入立即生效，一次 DB 查询代价可忽略。

## 2. 数据模型与 IPC 协议

**DB v1→v2**（升级机制首次实战）：`workspace` 加 `writeApprovedAt DATETIME NULL`；`DATABASE_VERSION=2`；`script/v2/upgrade-table.sql`：`ALTER TABLE workspace ADD COLUMN writeApprovedAt DATETIME NULL`（`--/ignore` 幂等）。

**ChatStreamChunk 新变体**：

```ts
| { type: "tool-update"; toolCallId: string; toolName: string;
    args?: unknown; state: "ready" | "awaiting-approval" | "running" | "done" | "denied" | "error";
    output?: string }
| { type: "approval-request"; toolCallId: string; toolName: string; argSummary: string }
```

**新 IPC**：`agent:approve(toolCallId, approved)`、`workspace:approveWrite(id)`、`workspace:revokeWrite(id)`、`workspace:bindDirectory(id)`（Electron dialog 选目录）。

**store 扩展**：`streams[sessionId].tools`：`{ order: string[]; map: Record<toolCallId, {toolName,args,state,output}> }`（保序）；`chat:status` 快照含 tools（切回恢复完整 agent 态）。

**落库**：每工具一行内 block `{ type:"tool_call", toolCallId, toolName, args, state(终态), output }`——对齐 P0 的 ToolCallBlock。

## 3. 工具注册表与文件工具

```ts
export interface ToolDefinition<TArgs> {
  name: string; description: string;        // 描述用中文
  parameters: z.ZodType<TArgs>;
  kind: "read" | "write";
  execute: (ctx: ToolContext, args: TArgs) => Promise<string>;
}
```

路径安全统一 `resolveSafePath(workspacePath, relative)`：resolve + 前缀校验 + realpath（symlink 跟随后再校验）；越界 → `"错误: 路径超出工作空间范围"`。

| 工具 | kind | 行为 |
|---|---|---|
| read_file | read | ≤512KB；NUL 判二进制拒绝；输出带行号（`%6d| %s`） |
| write_file | write | 整文件覆盖；≤1MB；mkdir -p 父目录；成功返回 `"已写入 <path> (N bytes)"` |
| list_dir | read | 一层目录（名称+类型+大小）；目录在前；忽略 `.` 开头 |
| search_files | read | pattern(正则)+glob(简易 `*`/`?` 转换)+output_mode(content/files_with_matches)+head_limit(≤50，默认50)；排除 node_modules/.git/dist；跳过二进制；content 输出 `path:line: 内容` |

**错误语义**：工具内部错误一律以 `"错误: <原因>"` 作为 tool-result 回喂（与审批拒绝同构），不断循环。

## 4. 渲染层 UI

```
chat/components/
├── ToolCallCard.tsx     # 折叠卡：🔧 {toolName} · 状态（⏳待审批/⚡执行中/✓完成/✗拒绝/✗失败）
│                        #   展开显参数 JSON + 输出（等宽，>100 行截断）；参数摘要取首个路径值
├── ApprovalBanner.tsx   # awaiting-approval 卡片下长出：argSummary + ✓允许 / ✗拒绝
│                        #   + 「允许并记住（本工作空间）」（= approve + workspace:approveWrite）
└── AgentProgress.tsx    # 输入区上方 28px 细条：第 N 步 · {toolName} 执行中；停止复用现有按钮
```

- 已授权工作空间的 write：无 banner，直接 running
- MessageItem 分发加 tool_call → ToolCallCard；MessageList liveMessage 组装时 tools 按首现顺序穿插 blocks
- SessionSidebar 工作空间菜单追加：绑定目录… / 授权写入 / 撤销写入授权（含时间）/ 解绑目录（二次确认）
- ChatView 顶栏展示当前绑定路径（可点击更换）

## 5. 测试策略

| 对象 | 方式 |
|---|---|
| resolveSafePath | 逃逸矩阵：`../`、绝对路径、拼接、symlink 出界、空串——P1 安全核心全覆盖 |
| file-tools | 边界（512KB/1MB 精确界、NUL、glob 转换、正则与排除、mkdir） |
| approval 状态机 | 挂起→true/false→resolve 值；作废路径；未知 id |
| agent loop 编排 | MockLanguageModelV3 多步脚本：chunk 序列（状态流转）、有序 blocks 落库、50 步保险丝、拒绝回喂继续 |
| v2 迁移 | 幂等（重复执行不炸） |

## 6. 错误处理汇总

- 工具错误 / 审批拒绝 / 路径越界 → tool-result 回喂，循环继续
- 审批挂起中关窗口 → 作废 resolve 拒绝 + 复位
- 中断 → 已落库保留（P0 语义），未决审批作废
- 绑定目录被外部删除 → 工具报「工作空间目录不存在」回喂（提示重绑）

## 7. 验收标准（DoD）

1. 未绑定工作空间：纯对话，与 P0 行为一致（零回归）
2. 绑定后「读一下这个目录」→ list_dir 免审执行，内联卡 ✓
3. 「创建 hello.txt」→ write_file 审批 → 允许 → 文件真实落盘
4. 「允许并记住」→ 后续免审；重启仍免审；撤销恢复审批
5. 拒绝后模型不再尝试写入（或解释）
6. 中断：已完成工具块保留、未决审批作废
7. test/lint/typecheck 全绿；v2 旧库升级无感
8. GUI 手测清单转交人工（惯例）

## 8. 明确不做（YAGNI）

- 危险后缀黑名单、写文件 diff 预览、多工具并行调用策略（SDK 默认行为为准）
- Bash/shell 工具（P1 只有文件四件套；shell 属后续独立决策）
- 审批的超时自动拒绝（挂起即等待，用户可中断）
- MCP/SKILL.md（P2，聚合进 tool-registry）
