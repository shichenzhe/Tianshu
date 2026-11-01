# MCP 工具面预算折叠（list_tools/call_tool 两跳）设计 spec

日期：2026-11-01
状态：已批直接开工（对话内用户「继续优化 MCP」滚动授权；接续专家目录批的渐进披露路线）
关联：专家目录出 system 批（2026-11-01-expert-catalog-to-tool）；上下文瘦身调研（对话内实测）

## 0. 事实基线

- **注入链**：McpManager 连接 → listTools → 全量 `mcp__<server>__<tool>` 注册进 registry（mcp-manager.ts toDefinition：description+inputSchema JSON Schema 透传）；collectToolDefinitions 对 `mcp__` 前缀全量放行（无工作空间白名单成员）——**每个会话每轮常驻注入全部工具 schema，无预算无 defer**。
- **实测（2026-11-01，permatodo HTTP MCP）**：22 工具 = description 1898 + inputSchema 10106 ≈ 12K 字符 ≈ 6K token/每轮；schema 冗余字段（$schema/title/additionalProperties）仅 1%——剥字段无价值。
- **引擎约束**：runChatStream 经 langgraph createReactAgent 一次性静态绑定工具集（run-chat-stream.ts:314-322）——WorkBuddy/Claude Code 式「ToolSearch 激活后动态挂载真身」不可行，折叠必须发生在**注册层**。
- 观测面：context-usage（chat:usage）已将 mcp__ 单列；McpServerStatus.toolCount 透出。

## 1. 本批裁定

1. **单 server 工具面预算**：`MCP_TOOL_SURFACE_BUDGET_TOKENS = 4000`（estimateTokens 口径，1token≈2 字符，与 context-usage toolDefinitionTokens 同源）。connect 注册时对直接工具 defs 序列化估算：
   - 线内 → 现状全量直接注册（小 server 体验零变化）；
   - 超线 → **折叠为两个聚合工具**（`mcp__<server>__list_tools` + `mcp__<server>__call_tool`），直接工具不注册。
2. **聚合工具形态**（专家目录批两跳同构）：
   - `list_tools`：无参（read 免审批）；execute 返回全工具 name+description+inputSchema——schema 仅在模型真查询时进上下文（一次性工具结果）。
   - `call_tool`：args `{tool, arguments?}`（zod：string + record(string, unknown)）；execute 校验 tool 在目录内（幻觉防护，错误文案回指 list_tools）后经 callTool 转发；**kind 恒 write**（目标工具只读性运行时未知，保守走审批——readOnlyHint 缺失时直接注册本就按 write，语义等价）。
   - 转发复用 callTool 错误处理（断连/网络策略拒绝统一错误文案回喂）。
3. **状态面**：McpServerStatus 增 `deferred: boolean`（折叠透出，前端暂不消费）；toolCount 保持元数据工具数（不因折叠变 2）。
4. **注册层收口**：chat.service/引擎/审批链/别名归一零改动（聚合工具即普通 registry 项，`mcp__` 前缀照常 passthrough/前缀注销）。

## 2. 非目标（留档）

- server 数量叠加的总量预算（10 个小 server 仍可叠到 40K token——当前配置 1 个 server，主案先立单 server 线）。
- description/schema 无损剥离（实测 1%，不做）。
- 阈值用户可配置（option 面）——常量先行，有需求再上配置。
- 折叠态下安全中心 mcp 工具粒度禁用（disabledMcpToolIds 按 `mcp:server:tool` 寻名，聚合名不在清单——server 级停用照常可用）。

## 3. 风险

- 模型不查 list_tools 直接编 tool 名——execute 目录校验兜底（回指 list_tools）。
- arguments 弱类型（模型按刚返回的 schema 构造 JSON）——Claude Code deferred tools 同构形态，可靠性可接受。
- 重连/改名/停用路径的注销均按 `mcp__<server>__` 前缀——聚合工具名天然覆盖，零额外清理。
