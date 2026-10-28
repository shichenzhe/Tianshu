# 设计：统一 LLM 栈到 LangChain（撤销双栈边界）

- 日期：2026-10-15
- 状态：待审阅
- 关联：撤销 `2026-10-03-langgraph-orchestration-design.md` §0「LLM 栈边界」中的双栈分工条款（其余条款不变）

## 1. 背景与动机

当前主进程并存两套 LLM 栈，按域分工（spec §0 划定）：

| | Vercel AI SDK | LangChain |
|---|---|---|
| 域 | chat / agent / provider | orchestration（编排） |
| 入口 | `provider/provider-factory.ts` | `orchestration/langchain-model-factory.ts` |
| 能力 | streamText+stepCountIs agent 循环、generateText、zod+jsonSchema 工具 | StateGraph 图编译、createReactAgent 执行 |

双栈代价：同一 `ProviderType` 四协议 switch 双写、新增协议双改；附属依赖两套并存。本次统一到 LangChain，同时净减安装包 ~26MB（AI SDK external 链全量进 asar ~30MB，LangChain 内联 tree-shake 后 ~4MB）。

## 2. 目标与非目标

**目标**：删除 `ai`、`@ai-sdk/anthropic`、`@ai-sdk/google`、`@ai-sdk/openai-compatible`、`ai-sdk-ollama` 五个依赖，全部模型调用收敛到 LangChain。

**非目标（不变量）**：

- 前端流式体验零改动：`onChunk` 回调与 `blocks.ts` 协议（TextBlock / ThinkingBlock / UsageBlock / ToolCallBlock / ImageBlock）保持稳定，仅后端事件源替换
- 工具安全门语义不变：命令门/文件门/批量删除/审批/审计继续经 `runToolCall` 收口
- MCP SDK（`@modelcontextprotocol/sdk`）external 化与用法不动
- chat.service 除「换循环引擎 + 抽事件映射层 + 抽 runToolCall」外不做其他重构

## 3. 现状盘点（设计依据）

- `chat.service.ts`（2850 行）：`streamText(streamOptions)` 单点调用（L1020 附近），流事件经 20+ 处 `onChunk` 回调下发；未使用 AI SDK 的 UIMessage/toUIMessageStream 生态——迁移只需换事件源
- `generateText` 调用点 4 处：`provider/connectivity.ts`（连通探测）、`chat/handover-summary.ts`、`personalization/memory-compiler.ts`、`chat.service.ts` 内部
- `langchain-tool-adapter.ts`（66 行）：zod ToolDefinition → DynamicStructuredTool、MCP JSON Schema → DynamicTool，执行统一走 `runToolCall`——已具备全应用工具装配器形态
- 循环依赖：`langchain-tool-adapter` import `chat.service` 的 `runToolCall`；迁移后 chat.service 需反向使用 adapter，必须先解环
- 多模态：ImageBlock 存相对数据根路径（见 `tianshu-chat-multimodal-image-path` 链路），经 ModelMessage 图片传模型

## 4. 目标架构

### 4.1 模型工厂合一

`langchain-model-factory.createChatModel` 成为全应用唯一模型构造入口；`parseExtraHeaders` 挪至独立公共模块；删除 `provider-factory.ts`（`ProviderType`/`ProviderRuntimeInfo` 类型迁入工厂文件或公共类型模块）。

### 4.2 工具层

- zod `ToolDefinition` 定义层（agent 域 15+ 文件）**零改动**
- `toLangChainTools` 升级为全应用唯一工具装配器
- `runToolCall`（含审批挂钩 `AgentStreamOptions`）从 chat.service 抽至独立模块（如 `agent/tool-gate.ts`），消除 chat.service ↔ tool-adapter 环

### 4.3 agent 循环（T3 主体）

chat 域改用 `createReactAgent`（与 orchestration 同范式），流式事件源为 `streamEvents`；新增独立映射层文件（如 `chat/agent-chunk-emitter.ts`）负责 `streamEvents` → `onChunk` 事件对应：

| streamEvents 事件 | onChunk / 块类型 |
|---|---|
| AIMessageChunk 文本增量 | TextBlock |
| 模型 reasoning 增量（provider 有则透传） | ThinkingBlock |
| on_tool_start / on_tool_end | ToolCallBlock（含审批挂起态） |
| 运行结束 usage 汇总 | UsageBlock |

精确映射在实施计划中逐一核对现 onChunk 调用点后落定。

### 4.4 简单调用与多模态

- `generateText` ×4 → `chatModel.invoke` 等价替换（含 connectivity 的 injectModel 测试注入口径）
- 多模态图片 → `HumanMessage` 多模态 content blocks；四家 provider 兼容性经 T2 spike 实测

### 4.5 依赖终态

- 删除 5 个 AI SDK 依赖；`vite.config.ts` external 白名单同步收缩（保留 `moment` / `better-sqlite3` / `node-pty` / `@modelcontextprotocol/sdk`）
- `@langchain/*` 六包维持内联（不加 external）

## 5. 分期实施

| 期 | 内容 | 风险 | 验收 |
|---|---|---|---|
| T1 | 4 处 generateText 迁 invoke；模型工厂合一（删 provider-factory）；runToolCall 解环抽出 | 低 | 全量 vitest + typecheck 通过 |
| T2 | 多模态 spike：ChatOllama / ChatGoogle 图片 content block 实测（OpenAI/Anthropic 成熟无风险） | 中 | 产出结论备忘；若不支持→A2 降级 |
| T3 | chat.service 循环重写（createReactAgent + chunk-emitter 映射层）；删 5 依赖 + external 收缩；spec §0 条款改写 | 高（chat 热路径） | 流式回归用例 + asar 实证 |

依赖顺序：T1 → T2 与 T3 可并行启动，T3 合并前必须有 T2 结论。

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| LangChain streamEvents 粒度与现有打字机体验不一致（token 碎片/合并差异） | T3 首步先写「事件对照 spike」用例，拿现有 onChunk 事件序列做 golden 基线对比 |
| ChatOllama / ChatGoogle 多模态消息格式差异 | T2 spike 前置；不支持则该两家禁用图片输入并提示（假设 A2，已确认） |
| LangChain JS 大版本 API 演进快 | 锁定 `@langchain/*` 现版本 minor；升级另走评审 |
| chat.service 循环重写引入行为回归 | 迁移前为现 agent-loop/工具审批链路补齐回归用例；分批迁移工具调用路径 |
| createReactAgent 的 recursion_limit 语义与 stepCountIs 不一致 | 实施计划中核对停止条件映射（stepCountIs(n) ↔ recursion_limit 数值换算） |
| 多模态 spike 实测（2026-10-15） | ollama：未测（本机无服务）；gemini：未测（无 API key）；T3 按 A2 降级实施（不支持图片的家禁用图片输入并提示），后续有环境可补测 |

## 7. 验收标准

1. `git grep -E "@ai-sdk|ai-sdk-ollama|from \"ai\"|from 'ai'"` 在 electron/ 与 src-react/ 零命中
2. 全量测试 + typecheck 通过；流式体验（打字机、工具进度、审批挂起）人工回归通过
3. asar 内 node_modules 无 ai/@ai-sdk/ai-sdk-ollama/ollama 链（`npx @electron/asar list` 实证，预期 -26MB）
4. `2026-10-03-langgraph-orchestration-design.md` §0 双栈条款已改写为单栈口径

## 8. 假设记录（已与需求方确认）

- A1 前端协议零改动
- A2 spike 失败时 ollama/gemini 图片输入降级禁用，不阻塞整体
- A3 不保留 AI SDK 兼容层，类型层一并切换
- A4 三期共用本 spec + 一份实施计划
