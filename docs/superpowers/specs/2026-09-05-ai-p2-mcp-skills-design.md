# P2 扩展生态设计（MCP 接入 + SKILL.md 技能加载）

- 日期：2026-09-05
- 状态：三项分歧决策经需求方（teammate 转达）批准；其余按「参照 Claude Code，无借鉴则从推荐」规则自定并记录
- 前置：P1 已合并（tool-registry `registerTools` 聚合点、ToolCallCard/审批 UI 全套、mcpServer 表 P0 已建——零 DB 迁移）
- 新增运行时依赖：`@modelcontextprotocol/sdk`（官方 Tier-1，P0 调研确认）——唯一新增

## 决策记录

| # | 决策点 | 结论 |
|---|---|---|
| 1 | MCP 工具审批分级 | 按协议元数据：工具注解 `readOnlyHint === true` → kind: read 免审；无注解或可写 → kind: write 每次审批。**MCP 工具的审批不受工作空间写授权覆盖**（授权语义仅限文件写入）；拒绝回喂同构（"用户拒绝了此操作"） |
| 2 | MCP server 生命周期 | App 启动时异步连接全部 enabled server（失败标记状态不阻塞启动）；工具列表常驻内存 registry；UI 提供重连/启停 |
| 3 | SKILL.md 正文披露 | 渐进披露（Claude Code 同款）：全部 skill 的 name+description 注入 system prompt；模型按需调新增内置工具 `read_skill(skillName)` 读正文——该工具不受 workspace 绑定限制、仅读 skills 目录、kind: read 免审 |
| 4 | MCP 工具命名 | `mcp__<server>__<tool>`（Claude Code 同款，防跨 server 重名） |
| 5 | 传输 | stdio（command/args/env）+ streamable HTTP（url + headers 含 Bearer）；OAuth 二期（P0 既定） |
| 6 | 管理界面 | 独立设置页 `/module/ai/mcp`（mcpServer 表 CRUD + 连接状态徽标 + 启停/重连） |
| 7 | skill 目录 | 用户级 `app.getPath("userData")/skills/`（始终加载）+ 工作空间级 `<directoryPath>/.mirror/skills/`（绑定目录后加载）；同名时用户级优先 |

## 1. MCP 子系统

```
electron/domains/ai/agent/
├── mcp-manager.ts     # 生命周期与状态：connect(row)/reconnect(id)/setEnabled(id,bool)/
│                      #   getStatuses() → Array<{id, name, state, toolCount, error?}>
│                      #   state: connecting|connected|error|disabled
│                      # 连接成功 → 把工具经 registerTools 注册（带 mcp__ 前缀与 kind 推断）
└── (复用 tool-registry / approval / P1 全套 execute 包装)
```

- **连接**：`@modelcontextprotocol/sdk` 的 Client + StdioClientTransport / StreamableHTTPClientTransport（以 node_modules .d.ts 为准——执行时校验点）
- **execute**：`client.callTool(name, args)`，结果 content（text 部分）拼接为字符串返回；MCP 错误 → `"错误: <message>"` 回喂（P1 错误语义同构）；server 断连 → 该 server 工具标记失效（调用返回错误字符串，不崩循环）
- **注册时机**：Application 启动接线 `new McpManager()` → `void startupConnectAll()`（fire-and-forget，不阻塞 app ready）；工具到达 registry 即对下一轮 send 生效
- **注入条件**：chat.service 的 resolveAgentOptions 组装 ToolSet 时，内置工具之外合并 registry 中的 `mcp__*` 定义（无论 workspace 是否绑定——MCP 与文件工作空间无关）；`read_skill` 始终注入

**API/IPC**：`mcp:list / create / update / delete / reconnect / setEnabled / statuses`（repo CRUD + manager 通道；status 经 invoke 拉取）。前端 McpSettingsView（表 + Dialog 表单：stdio 显 command/args(JSON)/env(JSON)，http 显 url/headers(JSON)——复用 ProviderSettingsView 的表格+对话框模式与 JSON 校验）。

## 2. SKILL.md 子系统

```
electron/domains/ai/agent/
├── skill-loader.ts    # loadSkills(userDir, workspaceDir?) → SkillInfo[]
│                      # SkillInfo { name, description, dir, source: "user"|"workspace", bodyPath }
│                      # 扫描 <dir>/<skill-name>/SKILL.md；简易 frontmatter 解析
│                      #   （--- 包裹的 name:/description: 两字段，正则提取，无需 YAML 库）
└── read-skill.ts      # 内置工具 read_skill：parameters {name}；按 SkillInfo.bodyPath 读正文
                       #   （≤256KB，超限截断提示）；kind: "read"；不依赖 ToolContext.workspacePath
```

- **加载时机**：每次 `chat:send`/`regenerate` 组装时即时扫描（目录小、fs 快、免重启增删 skill 生效；扫描失败静默空列表）
- **system 注入**：assistant.systemPrompt 存在时以 `\n\n` 追加，否则单独作为 system；模板：

```
你可以使用以下技能（调用 read_skill 工具并传入技能名可获取完整使用指引）：
- <name>: <description>
```

（无 skill 时不注入任何内容，零 token 开销）

- **同名冲突**：用户级优先（决策 #7），workspace 级同名被忽略

## 3. UI 汇总

- `/module/ai/mcp` 设置页（Sidebar 或 ProviderSettingsView 顶部导航入口）
- MCP 工具调用复用 P1 ToolCallCard（`mcp__server__tool` 名自然显示）与审批 banner（argSummary = 工具名 + args 摘要，通用逻辑已有 summarizeArgs）
- skills 无管理 UI（文件系统即配置——放目录即生效，guide.md 说明）

## 4. 测试策略

| 对象 | 方式 |
|---|---|
| skill-loader | frontmatter 边界（无 frontmatter/缺 description/同名两级/非法目录跳过/正文超限） |
| read_skill | 目录隔离（只能读已注册 SkillInfo 的 bodyPath，路径穿越拒绝）、正文读取与截断 |
| mcp-manager 状态机 | 注入 fake Client（mock connect/callTool/listTools）：connected→注册计数、连接失败→error 状态、断连→工具失效返回错误串 |
| kind 推断 | readOnlyHint true/false/缺失 三分支 |
| system 注入组装 | 纯函数：有/无 assistant systemPrompt、有/无 skills、同名去重 |
| 命名 | mcp__ 前缀生成与 registry 查找一致 |

不做真实 MCP server 的自动化测试（外部进程）——手测清单覆盖。

## 5. 错误处理汇总

- server 连不上 → 状态 error（UI 可见），其余 server 不受影响；不阻塞 app/会话
- 工具调用时 server 已断 → "错误: MCP 服务不可用" 回喂
- SKILL.md 解析失败（单条）→ 跳过该 skill（日志 warn），不影响其余
- read_skill 未知名 → "错误: 技能不存在"
- args/env/headers JSON 非法 → 表单校验拦截（复用 ProviderDialog 模式）

## 6. 验收标准（DoD）

1. 配置一个 stdio server（如 `npx -y @modelcontextprotocol/server-filesystem /tmp/demo`）→ 状态 connected → 其工具出现在模型可用集
2. 会话中让模型用该 MCP 工具 → 内联工具卡显示 `mcp__…` → readOnlyHint 工具免审直执行
3. 无 readOnlyHint 的 MCP 工具 → 审批卡出现；「允许并记住」**不出现**（MCP 不吃工作空间授权）；拒绝后模型继续
4. 停用 server（UI 开关）→ 工具即刻从下一轮消失；重连后恢复
5. `userData/skills/greeting/SKILL.md`（name: greeting）→ 新会话 system 含其描述；模型说「用 greeting 技能打个招呼」→ 调 read_skill → 按正文行事
6. workspace 级 `.mirror/skills/` 在绑定目录的会话生效；与用户级同名时用户级生效
7. 未配置任何 MCP/skill 时纯对话流式与 P1 一致（新增预期行为：read_skill 工具常驻注入、技能清单为空时不注入任何提示文本）
8. test/lint/typecheck 全绿；GUI 手测清单转交人工

## 7. 明确不做（YAGNI）

- MCP OAuth、SSE 旧传输、MCP resources/prompts（仅 tools）、MCP 工具的审批记住
- skill 的 allowed-tools 字段、skill 市场与管理 UI、skill 参数化模板
- MCP server 按会话/工作空间选择（全局生效）
