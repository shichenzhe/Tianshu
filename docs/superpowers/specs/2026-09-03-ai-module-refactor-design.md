# AI 模块重构设计（P0：Provider 配置层 + Chat 核心）

- 日期：2026-09-03
- 状态：已与需求方逐段确认
- 范围：本文档为 AI 能力全景蓝图 + P0 详细设计；P1（Agent 能力）、P2（MCP + Skill）各自后续独立成 spec

## 1. 背景与目标

现有 AI 模块是示范级实现：`modelConfig` 单表 7 字段、仅 OpenAI 兼容协议、`ai:chat` 单轮非流式调用、结果弹 toast。本次重构目标：

1. 模型配置支持主流参数与上游接口格式（OpenAI 兼容 / Anthropic / Gemini / Ollama）
2. 参考 GitHub 成熟 AI Agent 产品（cherry-studio、LobeHub、Codex、gemini-cli、AnythingLLM、Cline 等，调研日期 2026-09-03），提供 AI chat 基础能力：chat、工作空间、会话记录，并为 MCP 接入、skill 接入预留架构

## 2. 已确认的决策记录

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 产品定位 | **混合**：provider 配置层示范级（可裁剪的 CRUD 范式），chat/agent 层产品级；docs/guide.md 更新为按子域裁剪说明 |
| 2 | 上游协议 | OpenAI 兼容 + Anthropic + Gemini 原生 + Ollama 原生管理（模型发现） |
| 3 | 智能深度 | Agent loop + 工具审批/中断机制（P1 实施，P0 数据模型预留） |
| 4 | 工作空间 | 本地目录型：绑定文件夹 + 文件工具（读/写/列/搜索），写操作走审批；回滚机制二期 |
| 5 | MCP | stdio + streamable HTTP（Bearer Token）；OAuth 二期 |
| 6 | Skill | 助手预设（会话开场）+ SKILL.md 开放标准（能力扩展），两者正交 |
| 7 | 引擎 | Vercel AI SDK（`ai` v5）统一引擎，不自写多协议适配 |
| 8 | 数据迁移 | **新项目，不做旧数据迁移**：直接替换 v1 升级脚本表定义，`DATABASE_VERSION` 保持 1，开发期旧库删除重建 |

## 3. 范围分解与分期

```
P0（本设计）── 地基 + Chat 客户端
   ├─ Provider 配置层重构（四协议、模型管理、连通性测试）
   ├─ Chat 核心（工作空间/会话/消息持久化、流式 UI、多轮对话）
   └─ 助手预设

P1（下一份 spec）── Agent 能力
   ├─ Agent loop（工具调用循环 + 审批/中断状态机）
   ├─ 内置文件工具（读/写/列/搜索，限于工作空间目录）
   └─ 工作空间目录绑定（激活 workspace.directoryPath）
   ※ 无需新表：工具调用记录存消息 blocks JSON

P2（再下一份 spec）── 扩展生态
   ├─ MCP 接入（stdio + streamable HTTP，消费工具注册表）
   └─ SKILL.md 加载（用户级 + workspace 级目录扫描）
   ※ mcpServer 表已在 v1 建好；skill 走文件系统无表
```

远期（不在当前路线）：远程 MCP OAuth、文件变更回滚（checkpoint）、FTS5 全文搜索、知识库 RAG、Ollama 拉取模型管理。

## 4. 数据模型

风格与现有 schema 一致：不声明 Prisma relation（`relationMode = "prisma"`，关联由应用层维护）。

```prisma
model provider {
  id           Int      @id @default(autoincrement())
  name         String              // 显示名
  type         String              // openai-compatible | anthropic | gemini | ollama
  baseUrl      String
  apiKey       String?             // ollama 无需
  extraHeaders String?             // 自定义请求头 JSON
  enabled      Boolean  @default(true)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  models       model[]
}

model model {
  id            Int     @id @default(autoincrement())
  providerId    Int
  modelId       String              // API 调用名，如 gpt-5、glm-4.7
  name          String?             // 显示名，缺省用 modelId
  enabled       Boolean @default(true)
  temperature   Float?
  topP          Float?
  maxTokens     Int?
  contextWindow Int?                // 上下文窗口（tokens），用于历史截断
  @@index([providerId])
}

model assistant {
  id           Int      @id @default(autoincrement())
  name         String
  icon         String?             // emoji
  systemPrompt String
  temperature  Float?
  topP         Float?
  maxTokens    Int?
  builtin      Boolean  @default(false) // 内置助手不可删
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
}

model workspace {
  id             Int      @id @default(autoincrement())
  name           String
  icon           String?
  directoryPath  String?             // P1 激活，先建列
  defaultModelId Int?                // 本工作区默认模型
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
}

model session {
  id             Int      @id @default(autoincrement())
  workspaceId    Int
  assistantId    Int?                // 可空、可变：会话"当前"助手，切换只影响后续消息
  currentModelId Int?                // 可空、可变：会话"当前"模型（上次选择）
  title          String   @default("新会话")
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  lastMessageAt  DateTime?
}

model message {
  id          Int      @id @default(autoincrement())
  sessionId   Int
  role        String              // user | assistant | system
  blocks      String              // JSON 数组，见 blocks 规范
  modelId     Int?                // 生成此消息所用模型快照
  assistantId Int?                // 生成此消息所用助手快照（UI 展示/排障）
  error       String?             // 失败原因；错误消息保留便于重试
  createdAt   DateTime
  @@index([sessionId])
}

model mcpServer {                  // P2 消费，先建表
  id        Int      @id @default(autoincrement())
  name      String
  transport String              // stdio | http
  command   String?             // stdio：可执行命令
  args      String?             // stdio：参数 JSON 数组
  env       String?             // stdio：环境变量 JSON 对象
  url       String?             // http：端点 URL
  headers   String?             // http：请求头 JSON 对象（含 Bearer Token）
  enabled   Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

删除：`modelConfig` 表及其全部代码（`electron/domains/ai/model-config.repo.ts`、`ai.service.ts` 旧实现、前端 `ModelConfigDialog.tsx` 等，由新子域替代）。

落地方式：直接修改 `script/v1/upgrade-table.sql`（`modelConfig` 定义替换为上述新表，`CREATE TABLE IF NOT EXISTS` 幂等）+ 同步 `prisma/schema.prisma`；`DATABASE_VERSION` 保持 1；开发期已有旧库直接删除重建。

### 4.1 blocks JSON 规范（对齐 UIMessage 形态）

```jsonc
[
  { "type": "text", "text": "..." },
  { "type": "thinking", "text": "..." },
  { "type": "usage", "input": 123, "output": 456 },
  // P1 起出现：
  { "type": "tool_call", "toolCallId": "...", "toolName": "...", "args": {}, "state": "output", "output": "..." }
]
```

### 4.2 模型选择与参数覆盖

- **模型选择三级**：workspace 默认模型 → 会话记住上次选择 → 输入框常驻选择器随时切换。废除全局单一 `isActive` 概念；`option` 表存全局默认模型（新建 workspace 时继承）。
- **参数三级覆盖**（codex 模式）：`model 默认 < assistant 覆盖 < 单次请求覆盖`，发送时逐级合并。
- **助手语义**：助手与模型正交（助手管 systemPrompt + 参数，模型管 provider/model）；会话中途切换助手只影响后续消息；每条消息落 `modelId`/`assistantId` 快照。
- **重新生成**：原位替换 assistant 消息（不做消息分支树）。
- **历史搜索**：P0 用 `LIKE` 查询；FTS5 中文分词体验差且 trigram 有编译依赖，消息量到瓶颈再优化。
- **历史截断**：按 `model.contextWindow` 估算保留最近消息（P0 近似：1 token ≈ 2 字符）。
- **会话标题**：首条用户消息截前 20 字符（不做 AI 起标题）。

## 5. 主进程架构

```
electron/domains/ai/
├── provider/                    # 示范级子域（清晰 CRUD 范式）
│   ├── provider.repo.ts         # provider CRUD + IPC
│   ├── model.repo.ts            # model CRUD + IPC
│   ├── provider-factory.ts      # type → AI SDK LanguageModel
│   └── connectivity.ts          # 连通性测试 + Ollama 模型发现
└── chat/                        # 产品级子域
    ├── chat.service.ts          # 发送编排
    ├── session.repo.ts          # workspace/session/message CRUD + IPC
    └── assistant.repo.ts        # 助手 CRUD + IPC + 内置助手种子
```

### 5.1 provider-factory（协议适配唯一收口）

```ts
switch (provider.type) {
  case "openai-compatible": return createOpenAICompatible({ baseURL, apiKey, headers }).chat(modelId);
  case "anthropic":         return createAnthropic({ baseURL, apiKey, headers })(modelId);
  case "gemini":            return createGoogleGenerativeAI({ apiKey })(modelId);
  case "ollama":            return createOllama({ baseURL })(modelId);
}
```

Ollama 模型发现：REST `/api/tags` 拉取已装模型，UI 手动刷新 + 一键导入为 `model` 行（不轮询）。

### 5.2 chat.service 发送编排

```
1. 读会话上下文：session.assistantId → assistant 预设；会话当前模型
   （或 workspace 默认 / option 全局默认）→ provider + model
2. 三级参数合并
3. 历史截断（contextWindow 估算）
4. streamText({ model, system, messages, temperature, topP, maxTokens, abortSignal })
5. chunk 经 IPC 事件 chat:stream:{sessionId} 推送渲染层
   （text-delta / reasoning-delta / finish / error，对齐 UIMessageChunk 形态）
6. 流结束/中断/出错时一次性持久化 message 行（含快照列、usage 块；出错记 error 字段）
```

- **停止**：`chat:stop(sessionId)` → `AbortController.abort()`，已生成部分照常落库。一个会话同时至多一个进行中的流（重复发送直接拒绝），因此流标识统一用 sessionId，不引入独立 streamId。
- **持久化时机**：流结束时一次写入（避免每 delta 写库的 SQLite 写放大；崩溃最多丢最后一条未完成消息，P0 可接受，中期可加周期 checkpoint）。
- **用户消息**：发送时立即落库（先写 user message，再起流）。

### 5.3 IPC 通道

| 类别 | 通道 |
|------|------|
| invoke | `provider:list/getById/create/update/delete`、`provider:test`、`model:list/...CRUD`、`workspace:...`、`session:...`、`message:listBySession/search`、`assistant:...`、`chat:send`、`chat:stop` |
| 事件（主→渲染） | `chat:stream:{sessionId}`（chunk 流）、`chat:done:{sessionId}`、`chat:error:{sessionId}` |

### 5.4 错误处理

AI SDK `APICallError` 按 `statusCode` 映射错误码：`AUTH_FAILED`(401/403)、`RATE_LIMITED`(429)、`MODEL_NOT_FOUND`(404)、`TIMEOUT`、`NETWORK`、`UNKNOWN`。错误码过 IPC，渲染层映射 i18n 文案（`chat:errors.*`），不透传原始英文报错。

## 6. 渲染进程架构

### 6.1 路由

```
/module/ai                → ChatView（三栏主界面）
/module/ai/providers      → ProviderSettingsView（服务商/模型管理）
/module/ai/assistants     → AssistantSettingsView（助手预设管理）
```

### 6.2 组件结构

```
src-react/domains/ai/
├── chat/
│   ├── views/ChatView.tsx         # 布局壳：会话栏 + 消息区 + 输入区
│   ├── components/
│   │   ├── SessionSidebar.tsx     # 工作空间分组 + 会话列表（新建/重命名/删除）
│   │   ├── MessageList.tsx        # 消息流（P0 不做虚拟滚动）
│   │   ├── MessageItem.tsx        # blocks 分发渲染
│   │   ├── ChatInput.tsx          # 输入框 + 发送/停止 + 快捷键
│   │   ├── ModelPicker.tsx        # provider→model 两级选择器
│   │   └── AssistantPicker.tsx    # 会话内切换助手
│   └── store/chat.store.ts        # Zustand：流式缓冲 + 当前会话/所选模型
└── provider/
    ├── views/ProviderSettingsView.tsx
    └── components/ProviderDialog.tsx / ModelDialog.tsx / OllamaImportDialog.tsx
```

### 6.3 数据流分工

- **React Query**：workspace/session/message 列表等持久化数据——`useQuery`/`useMutation` + invalidate，以库为准。
- **Zustand**：仅流式期间临时缓冲——chunk 累积进 store，`chat:done` 后 invalidate message query 并清空缓冲（避免 Query 缓存被高频 chunk 写穿）。
- **流式渲染节流**：text-delta 以 30ms batch 合并再 setState。

### 6.4 消息渲染与安全

- `react-markdown` + `shiki`（动态 import 按需加载语言）。
- blocks 分发：`text` → Markdown；`thinking` → 可折叠面板；`usage` → 灰色小字 footer；`tool_call` → P0 不出现，P1 激活。
- **不启用 raw HTML**（防 XSS）。

### 6.5 i18n 与空状态

- 新增 `chat` namespace；provider 管理扩展 `ai` namespace。
- 无 provider 时 ChatView 显示引导卡片 → 跳 `/module/ai/providers`。
- 内置助手种子 2~3 个（通用助手 / 翻译 / 代码审查，`builtin=true` 不可删）。

## 7. 测试策略

| 测试对象 | 方式 |
|---|---|
| 参数三级合并 | 纯函数直测：空值、覆盖优先级 |
| 历史截断 | 纯函数直测：超窗截断、边界 |
| blocks 序列化/反序列化 | 往返一致性 + 畸形 JSON 容错 |
| 错误分类映射 | statusCode → 错误码全分支 |
| chat.service 编排 | `MockLanguageModelV2` 注入：持久化调用、事件推送顺序、abort 后部分内容落库 |
| provider-factory | 四种 type 构造不 throw、参数正确传递 |

不做 E2E，以第 9 节手测验收清单代替。

## 8. 依赖变更

- 新增（运行时）：`ai`、`@ai-sdk/openai-compatible`、`@ai-sdk/anthropic`、`@ai-sdk/google`、`@ai-sdk/ollama`、`zod`、`react-markdown`、`shiki`
- 移除：`openai`（直连代码删除）

## 9. 验收标准（DoD）

1. 四种协议（含本地 Ollama）各完成一次流式对话
2. 应用重启后工作空间/会话/消息完整恢复
3. 停止按钮中断后，已生成内容落库可见
4. 上游 401/429 等错误显示为 i18n 中文文案
5. 会话内可随时切换助手与模型，历史消息展示快照信息
6. `npm run test` / `lint` / `typecheck` / `build` 全绿
7. docs/guide.md《移除 AI 模块》更新为按子域（provider/chat）裁剪说明

## 10. 风险与对策

| 风险 | 对策 |
|------|------|
| `ai` 包 ESM 在主进程的打包兼容 | 主进程经 vite bundle 内联，P0 第一个里程碑即验证打包链路 |
| 国产小众端点协议偏差 | `extraHeaders` + openai-compatible 兼容选项兜底；遇到再按端点加绕过配置，不预建 |
| SQLite 写放大 | 流结束一次写库；实测有问题再加周期 checkpoint |

## 11. P1/P2 预留接口（本设计已埋点）

- `message.blocks` 的 `tool_call` 块类型（P1 agent loop 写入）
- `workspace.directoryPath` 列（P1 文件工具的工作目录边界）
- `mcpServer` 表（P2 MCP 配置存储）
- IPC 通道命名按子域前缀分组，P1/P2 新增 `agent:*`、`mcp:*` 不与 P0 冲突
