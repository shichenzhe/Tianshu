# AI 服务商与模型管理技术方案

> 调研基线：main @ 995bf652（2026-11-05）。文中路径均相对仓库根；桌面端代码位于
> `apps/tianshu-desktop/`，服务端 `apps/tianshu-server/`，移动端 `apps/tianshu-mobile/`，
> 共享包 `packages/tianshu-protocol`、`packages/tianshu-core`。所有函数名/字段名/常量
> 均出自当前代码，未实现能力如实标注。

## 1. 总览

服务商与模型管理是 LLM 栈的配置底座：**多厂商接入**（五种协议类型统一到 LangChain
四个 ChatModel 实现）、**凭证安全**（apiKey AES-256-GCM 信封加密落库）、**模型发现**
（四协议远端模型清单拉取 + 启发式判型导入）、**连通验证**与**写面路由**（单 UI 对
本地/远程主机双通道保存）。

一条数据流贯穿全模块：预设模板（`src-react/domains/ai/provider/model/presets.ts`，
DeepSeek/Kimi/Qwen/GLM/OpenAI/Anthropic/Gemini/Ollama/ComfyUI 九项）→ 用户在
`/module/ai/providers` 页填写 `name/type/baseUrl/apiKey` → 主进程
`ProviderRepository.create()`（`apiKey` 经 `sealSecret` 加密落库）→
`ModelRepository.listRemote()` 拉上游清单勾选导入（`guessModelType` 启发式预填类型）
→ `model:test` 最小 invoke 验证 → 聊天引擎 `assembleContext` 经
`getEffectiveModelId` 三级链解析生效模型 → `createChatModel`
（`electron/domains/ai/orchestration/langchain-model-factory.ts`）按协议类型构造
ChatModel 下发请求。

页面入口：`src-react/domains/ai/provider/views/ProviderSettingsView.tsx`（左
`ProviderList` + 右 `ProviderDetail`/`ModelList`，顶行 `usePageHeader` 标题）；
路由注册于 `src-react/routes/index.tsx` 的 `/module/ai/providers`。

**IPC 通道面**（主进程构造器注册，`handleUser` 鉴权 v12 多用户隔离）：

| 通道 | 方法（repo） | 说明 |
|---|---|---|
| `provider:list` / `getById` | `list()/getById()` | 全量（`apiKey` 已解密回传本机渲染层）/ 单条 |
| `provider:create` / `update` / `delete` | `create()/update()/delete()` | 写面（密钥 seal 落库；delete 级联清 models） |
| `provider:test` | `test()` | **仅 comfyui** 可用（`GET /system_stats`），其余类型 `UNSUPPORTED_TYPE_TEST` |
| `model:listByProvider` / `listAll` | `listByProvider()/listAll()` | model 无 userId 列，经所属 provider 过滤 |
| `model:create` / `update` / `delete` | `create()/update()/delete()` | 归属经 `assertModelOwned` → provider 链路校验 |
| `model:test` | `test()` | 连通验证（§3.4） |
| `model:listOllama` | `listOllama()` | Ollama 已装模型（`/api/tags`） |
| `model:listRemote` | `listRemote()` | 四协议远端清单（结构化 success/errorCode） |

写面错误码（repo 抛、渲染层 `mapIpcError` 映射 i18n）：`PROVIDER_NOT_FOUND`、
`MODEL_MISSING`、`PROVIDER_MISSING`。前端交互细节：`enabled` 开关走乐观更新
（先 `queryClient.setQueryData` 快照，失败回滚）；测试按钮
`testingModelId` 防并发重复点击；删除二次确认走 `deletingProvider/deletingModel`
受控弹层。

## 2. 数据模型

`apps/tianshu-desktop/prisma/schema.prisma`（server 仓同构副本，无外键、
`relationMode = "prisma"`，归属在 service 层经 userId 校验）：

- **provider**（L36）：`name`、`type`（`openai-compatible | anthropic | gemini |
  ollama | comfyui`，TEXT 列无枚举约束）、`baseUrl`、`apiKey String?`（**密文列**，
  见 §3.2）、`extraHeaders String?`（JSON 字符串 `{"X-Key":"v"}`，同密文列）、
  `enabled Boolean @default(true)`、`contextWindow Int?`（服务商级默认窗口，
  2026-11-01 加列——实际建列由 `ensureProviderColumns` 启动幂等补建，不走 v1 快照
  避免指纹变化触发旧库重建）、`userId Int?`（v12 多用户隔离）。
- **model**（L57，**无 userId 冗余列**，归属经 provider 链路）：`providerId`、
  `modelId String`（上游模型名，如 `deepseek-chat`）、`name?`（展示名）、
  `type String @default("llm")`（`llm | embedding | tts | reranker | asr`）、
  `enabled`、采样参数三列 `temperature/topP/maxTokens`（model 级默认）、
  `contextWindow Int?`。

模型解析优先级（消费侧，`electron/domains/ai/chat/session.repo.ts`）：
`session.currentModelId` > `workspace.defaultModelId` > `firstEnabledLlmModelId()`
（首个启用 llm 模型兜底——fresh 库首用不再 `NO_MODEL`）；上下文窗口三层生效
（`chat.service.ts` L1740 `effectiveContextWindow()`）：
`model.contextWindow ?? provider.contextWindow ?? DEFAULT_CONTEXT_WINDOW = 131_072`。

## 3. 核心技术方案

### 3.1 多厂商接入层：LangChain 统一栈

**版本**（`apps/tianshu-desktop/package.json` L46-51）：`@langchain/core ^1.3.2`、
`@langchain/openai ^1.6.2`、`@langchain/anthropic ^1.5.12`、
`@langchain/google-genai ^2.3.2`、`@langchain/ollama ^1.3.0`、
`@langchain/langgraph ^1.6.0`（server 仓同套，core ^1.2.18 / langgraph ^1.5.0；
`tianshu-core` 以 peer 依赖 `@langchain/core ^1.2` + `^1.4.18` 声明）。

**模型工厂单一收口**：`createChatModel(provider, modelId, options?)`
（`electron/domains/ai/orchestration/langchain-model-factory.ts`，server 侧对应
`src/core/provider/model-factory.ts`，2026-10-15 单栈收敛后全应用唯一构造入口）：
按 `provider.type` 分派 `ChatOpenAI/ChatAnthropic/ChatGoogleGenerativeAI/ChatOllama`，
comfyui 及未知类型落 openai-compatible default 分支。各协议构造参数对照
（以本地安装版 d.ts 逐家核对，注释中标明 d.ts 行号）：

| 协议 type | ChatModel | baseUrl 参数 | topP / maxTokens 构造字段 | 额外 header 口 |
|---|---|---|---|---|
| `openai-compatible`（含 comfyui 落此） | `ChatOpenAI` | `configuration.baseURL` | `topP` / `maxTokens` | `configuration.defaultHeaders` |
| `anthropic` | `ChatAnthropic` | `anthropicApiUrl` | `topP` / `maxTokens` | `clientOptions.defaultHeaders` |
| `gemini` | `ChatGoogleGenerativeAI` | `baseUrl`（缺省省略用官方） | `topP` / **`maxOutputTokens`** | `customHeaders` |
| `ollama` | `ChatOllama` | `baseUrl` | `topP` / **`numPredict`** | `headers` |

采样/限额差异是 T3-3 R1 修复的产物（旧栈 topP/maxTokens 曾静默失效）；
`definedFields()` 统一滤 undefined/null（DB 可空列经 repo `?? undefined` 消毒，
防未来调用点直传裸 null 炸构造）。`extraHeaders` 经 `parseExtraHeaders()`
（畸形 JSON 返回空对象）注入各家 header 口。构造不发网络请求。

**依赖分区铁律**（`apps/tianshu-desktop/vite.config.ts` L109-121）：主进程
`dependencies` 仅 6 项 native/CJS 包（`@modelcontextprotocol/sdk`、`better-sqlite3`、
`mermaid`、`moment`、`node-pty`、`pg`）——electron-builder 只装运 prod 依赖，vite
rolldown `external` 白名单列其中 5 项走 Node 原生 require（CJS 互操作/原生
`__filename` 原因；mermaid 可打包故不在 external），**LLM 栈全部在 devDependencies
= 打包内联进 bundle**。新增 dependencies 项必须同步 external 互锁（CLAUDE.md 记
「现 4 包」已滞后于现状 6 项）。

### 3.2 apiKey 存储安全（信封加密）

2026-11-02 安全审查三批 C2-C4 落地，桌面与 server 同构：

- **加密原语**：`packages/tianshu-core/src/crypto-envelope.ts`——`enc:v1:` 前缀的
  AES-256-GCM 信封，AAD 绑定字段名（`provider.apiKey` / `provider.extraHeaders`），
  单源双端复用；`isEncryptedField/encryptField/decryptField/masterKeyFromHex`。
- **主密钥（桌面）**：`electron/domains/security/master-key.ts` `getMasterKey()`——
  随机 32B，经 Electron `safeStorage`（macOS Keychain / Windows DPAPI / Linux
  libsecret）加密后以 `ss:v1:` 形态落 option 表 `security.masterKey`；降级链：
  safeStorage 不可用（Linux 无 keychain）→ `hex:v1:` 明文落表（仍有信封，挡「拿到
  库文件」不挡「拿到同机用户上下文」，`isMasterKeyDegraded()` 可查）；持久化失败
  宁可明文（临时密钥密封重启即不可解 = 凭证永久丢失）；存量 hex 形态读到且
  safeStorage 已恢复时读时升级包裹写回。
- **读写封装**：`electron/domains/security/secret-field.ts` `sealSecret/openSecret`
  ——写侧有主密钥即加密（null/空串/已密文透传），读侧透明解密（旧明文原样返回 =
  零迁移懒升级，写侧回写完成迁移；解密失败返回 null 呈现为凭证缺失而非业务中断）。
  server 侧 `src/commons/security/secret-field.ts` 同款，主密钥来自 env
  `TIANSHU_MASTER_KEY`（64 位 hex，未设置保持明文 + 启动告警）。
- **repo 接入**：`provider.repo.ts` `create/update` 写前 `sealSecret`，
  `toRecord/getRuntimeInfo` 读侧 `openSecret`；`mcp.repo.ts`（env 密钥袋/headers）
  同款。
- **传输脱敏**：`REDACTED_SECRET = "__REDACTED__"`（`packages/tianshu-protocol/
  src/chat-contract.ts` L171）——server `provider/query` 响应把 apiKey/extraHeaders
  有值时替换为掩码（`provider.service.ts` `redactProvider` + `redactExtraHeaders`
  fail-closed：非纯对象整体掩码）；控制端只读展示，save 回传掩码由 repository 按
  未传处理（`provider.repository.ts` L72-75 掩码回写防御），防脱敏值覆盖真实密钥。
- **协议三态语义**：`packages/tianshu-protocol/src/provider-save-contract.ts`
  `ProviderSaveItem/ModelSaveItem`——`undefined = 未传保留现值`、`null = 显式清除`、
  掩码 = 按未传。
- ✅ **引擎读侧收口（批1A，2026-11-05）**：桌面全部引擎直读点统一经
  `openProviderSecrets()`（`electron/domains/ai/provider/provider-runtime.ts`
  新增，与 repo `getRuntimeInfo` 同款单源）解密 apiKey/extraHeaders——覆盖
  `chat.service.ts` 两处裸读（`assembleContext`/`polishText` 装配解密后行，
  `streamAndPersist`/`memberModelText`/`generateTitleIfFirstExchange` 三消费点
  均吃组装后的明文）、`handover-summary.ts` `resolveHandoverModel`、
  graph-executor `loadModelRuntime`/`loadProviderRuntime`（comfyui 直取）与
  `automation-runner.ts` 执行链；旧明文行原样透传（懒迁移），解密失败按凭证
  缺失降级不阻断。契约测试 `tests/ai/provider-secret-decrypt.test.ts`
  （密文行 → `createChatModel` 收明文，替身注入固定主密钥）。加密降级状态
  同批接 UI：`security:masterKeyStatus` 通道（`getMasterKeyStatus()` 先加载
  再读 `isMasterKeyDegraded()`，防冷进程假阴性）+ 服务商设置页警示条
  （`settings:security.encryptDegraded` 双语）。历史注记：C3 批提交信息曾称
  「chat 引擎与 UI 全走此两口」与当时代码不符——批1A 实测收口（对照：server
  `chat-runner.service.ts` L761/L931 一直已解密）。

### 3.3 模型能力元数据

- **窗口元数据**：`contextWindow` 两级显式（model > provider）+ 代码兜底 131072。
  前端 `ProviderDialog.tsx` L58-122 编辑服务商级窗口（空 = 清 null）；`ModelDialog.tsx`
  L37/L77 新建模型预填 `DEFAULT_CONTEXT_WINDOW = 131072`；`lib/model-summary.ts`
  `buildModelSummary()` 摘要仅显示非默认项（context/output/temperature/topP，
  1024 进制 K/M 缩写）；`components/token-limit-field.tsx` 校验
  `maxTokens < contextWindow`（mobile `logic/provider-config.ts` `buildModelSave`
  同款 `maxTokensLtContext` 错误）。
- **模型类型**：`type` 五值（llm/embedding/tts/reranker/asr），决定验证端点
  （§3.4）与可用场景（记忆子系统回退模型只认 llm，`listAllEnabledAnyUser()`）。
  类型判定在导入时由启发式预填（§3.4），出库时 `toRecord()` 收窄回 `ModelType`
  （DB TEXT 列无枚举约束）。embedding 型消费面在资料库 RAG（向量节点经
  `data-source` 域的连接与 `embedTexts`），tts/reranker/asr 为 openai 兼容专项
  端点探测预留。
- **enabled 语义**：provider 与 model 双层开关。生效模型解析的兜底链
  `firstEnabledLlmModelId()` 要求 `provider.enabled = true` **且** `model.enabled =
  true 且 type = "llm"`（model 与 provider 无 Prisma relation，两步查：先取启用
  provider id 集再筛模型）；`polishText` 同款两步查。聊天主链路（会话已显式选模）
  不校验 enabled——停用模型的历史会话仍可继续对话。
- **无 vision/function-calling 能力标志列**：多模态支持与否不落库——非视觉模型收
  图片靠上游 400 错误事后经 `classifyError` 判 `IMAGE_UNSUPPORTED`
  （`packages/tianshu-core/src/error-classify.ts`）；无每模型价格元数据，用量监控
  （`llmCallEvent`/`toolCallEvent` 表，`/module/ai/monitor`）只有 token 数无成本
  折算。

### 3.4 模型验证与「测速」

`electron/domains/ai/provider/connectivity.ts`（353 行）：

- **llm 验证**：`testLlmConnection()` —— `createChatModel(...).invoke("hi", { signal:
  AbortSignal.timeout(10_000) })` 最小补全（M7：非流式补全必须带超时，半开连接不得
  IPC 永久挂起）；结果 `{ success, errorCode, message }`，错误经 `classifyError` 归类
  （401/403→AUTH_FAILED、429→RATE_LIMITED、404→MODEL_NOT_FOUND…），渲染层
  `ai:errors.<code>` 出文案。IPC 入口 `model:test`（`model.repo.ts` `test()`）。
- **非 llm 端点探测**：`testEndpointConnection()` 按 OpenAI 兼容专项端点最小请求
  （`buildProbeRequest()` 按类型构造）：

  | modelType | 端点 path | 最小请求体 |
  |---|---|---|
  | embedding | `embeddings` | `{model, input:["ping"]}`（2xx 强校验返回向量非空——向量节点在用） |
  | tts | `audio/speech` | `{model, input:"hi", voice:"alloy"}`（可达即成功，音频体不下载） |
  | reranker | `rerank` | `{model, query:"ping", documents:["pong"]}` |
  | asr | `audio/transcriptions` | multipart（`makeSilentWav()` 手工构造 52 字节静音 wav + `model` 字段） |

  **400/422 参数拒也判可达成功**（证明路由存在且鉴权通过——参数细节非验证目标）；
  成功体不消费（`response.body.cancel()` 归还 undici 连接池，未读 body 会钉住连接
  直至超时）。探测超时 `PROBE_TIMEOUT_MS = 10_000`。
- **comfyui**：`testComfyConnection()` 走 `GET /system_stats`（无模型概念）；
  `provider:test` IPC 仅 comfyui 可用（其余类型 `UNSUPPORTED_TYPE_TEST`）。
- **远端模型清单**：`listRemoteModels()` 四协议分派——openai-compatible `GET
  {base}/models`（Bearer）、anthropic `GET {base}/v1/models`（`x-api-key` +
  `anthropic-version: 2023-06-01`）、gemini `GET {base}/v1beta/models?key=`（name 剥
  `models/` 前缀，baseUrl 约定含 /v1beta 先剥防重复）、ollama 复用
  `listOllamaModels()`（`GET /api/tags`，5s 超时）；comfyui 无列表概念早退
  `UNSUPPORTED_TYPE_LIST`。非 2xx 抛携 `statusCode` 的 Error 由 repo 层归类——
  **拉取兼任连通测试的结论载体**。连通失败是预期结果非异常（`ListRemoteResult`
  结构化 success/errorCode）。
- **导入**：`RemoteModelImportDialog.tsx` 勾选导入（已导入置灰排末尾），
  `guessModelType()`（`lib/model-type-guess.ts`）关键词启发式预填类型
  （embed/rerank/whisper|asr|transcri/tts|voice|speech，未命中回退 llm）。
- **如实标注**：**没有真正的测速**——无 TTFB/生成速度/时延统计，`test` 只是单次
  最小请求的连通性验证（对比 Cherry Studio 的延迟与 tokens/s 测量，§5）。

### 3.5 providerSave 写面路由化（HD 单 UI 多主机）

- **双通道路由**：`src-react/domains/ai/data-source/host-route.ts` `routeInvoke()`——
  本地走 `invoke(local.ch, ...)` 原通道零行为变化；远程走调用方适配器闭包。
  `api/provider.api.ts` 与 `api/model.api.ts` 的 list/create/update/delete/test/
  listRemote 全部路由化（`provider:list` ↔ `remoteProviderList` 等）。
- **远程适配**：`data-source/remote-catalog.ts`——`remoteProviderCreate/Update/
  Delete`、`remoteModelCreate/Update/Delete/Test/ListRemote`。难点两处：
  (a) server `provider/save` 为 **upsert 数组语义**（带 id 更新/不带新建）且 save
  DTO 必填 `type/baseUrl`——远程更新先拉 `providerBundle` 现值经 `mergeDefined()`
  差量补全为全量（undefined 键不覆盖、null 清空如实透传）；(b) save 端点不指明
  新建行——新建前后两次 bundle **diff 取新行**（多一次拉取，低频可容）。
- **server 端实现**：`apps/tianshu-server/src/modules/provider/`
  （controller/service/repository）五端点全 POST：`provider/query | save | delete |
  test | fetchModels`，`@Public()` 豁免 JWT 但静态 token 守卫（`TIANSHU_TOKEN`）仍
  生效；`userId` 写死 `COMPANION_USER_ID`（单伴生用户语义）。repository 的 save 全批
  交互式事务（任一项校验失败整批回滚）；delete 为 `providerIds` 级联清 models +
  `modelIds` 单删（幂等，非本人 id 静默跳过）。**server `provider/test` 是轻探上游
  `/models`（不计费）**，与桌面 `model:test` 的本地对话测试口径不同（协议
  `ProviderTestResult` 注释明示此差异）。
- **移动端遥控**：`apps/tianshu-mobile/src/app/providers.tsx` +
  `src/logic/provider-config.ts`——`buildProviderSave/buildModelSave`（表单校验，
  编辑态显式 null 清除语义）、`prepareRemoteModels/importRemoteModels`（批量导入
  结果分 succeeded/failed）、`inferModelType`（与桌面 `guessModelType` 同构启发式，
  双份未收编 core）。

### 3.6 模型引用全景（model 表的消费方）

| 消费方 | 字段/路径 | 解析方式 |
|---|---|---|
| 聊天会话 | `session.currentModelId` | `getEffectiveModelId()` 三级链（§2）；`send` 时 `params.modelId` 写回会话（记住上次选择） |
| 工作空间默认 | `workspace.defaultModelId` | 三级链第二级；新建会话缺省模型来源 |
| 兜底池 | — | `firstEnabledLlmModelId()`：fresh 库首用不再 NO_MODEL |
| 采样参数基线 | `model.temperature/topP/maxTokens` | `mergeParams([model, assistant, overrides])` 三级覆盖（`packages/tianshu-core/src/param-merge.ts`），后层优先、全空字段不下发 SDK |
| 图编排节点 | 节点配置 modelId | `graph-executor.ts` `loadModelRuntime()`（L1479，按 modelId 缓存 promise 的 `ModelRuntime`） |
| 自动化任务 | `automationTask.modelId`（schema L215） | `automation-runner.ts` 定时/事件触发执行 |
| 专家团成员 | 成员 JSON 内模型引用 | `memberModelText()` 单轮补全装配 |
| 用量监控 | `llmCallEvent.modelId` | monitor 页按模型聚合 token 用量 |
| 记忆子系统 | — | `listAllEnabledAnyUser()` 全体用户启用 llm 池解析回退编译模型 |

## 4. 三端布局

| 端 | 位置 | 角色 |
|---|---|---|
| 桌面（主进程） | `electron/domains/ai/provider/`：`provider.repo.ts`（IPC 六通道 provider:list/getById/create/update/delete/test + 加密封装 + `getRuntimeInfo` 供引擎）、`model.repo.ts`（IPC 八通道 model:listByProvider/listAll/create/update/delete/test/listOllama/listRemote）、`connectivity.ts`（验证与清单拉取）、`provider-runtime.ts`（`ProviderRuntimeInfo` 形状 + `parseExtraHeaders`） | 配置真相源 + 引擎运行时信息出口 |
| 桌面（渲染进程） | `src-react/domains/ai/provider/`：`views/ProviderSettingsView.tsx` + `components/`（ProviderList/ProviderDetail/ProviderDialog/ModelList/ModelDialog/RemoteModelImportDialog/token-limit-field）+ `lib/`（model-summary/model-type-guess）+ `model/presets.ts` | 配置页 UX；React Query 缓存 + 乐观更新（enabled 切换先 setQueryData 快照回滚） |
| 无头服务端 | `src/modules/provider/`（controller/service/repository + dto/）+ `src/core/provider/model-factory.ts` | 被控配置面：provider 五端点（query/save/delete/test/fetchModels）；工厂与桌面同构（ProviderType 四型无 comfyui） |
| 移动端 | `src/app/providers.tsx` + `src/logic/provider-config.ts`、`model-bundle.ts` | 远程遥控配置（providerSave 通道消费 + 三态语义表单） |
| 共享包 | `packages/tianshu-protocol/src/provider-save-contract.ts`（upsert 契约）+ `chat-contract.ts`（`REDACTED_SECRET`）；`packages/tianshu-core/src/crypto-envelope.ts`（加密原语）+ `error-classify.ts`（验证错误分类） | 契约与原语单源 |

**wire 形状**：`src-react/domains/ai/api/provider.api.ts` 的 `ProviderRecord`
（row 超集 + `contextWindow?` + ISO 时间串）、`model.api.ts` 的 `ModelRecord`
（可空列收窄回 `undefined`，`type` 出库收窄回 `ModelType`）与
`ListRemoteResult{success,errorCode?,message,models}`——类型同时供主进程 repo
import type（单一形状来源，双向不漂移）。

**测试覆盖**（Vitest，`apps/tianshu-desktop/tests/ai/`）：连通与清单拉取
`connectivity.test.ts`（15.0K）、工厂字段分派 `langchain-model-factory.test.ts`、
repo 层 `model-repo.test.ts`、UI `provider-list/provider-view-master-detail/
model-list/model-dialog/remote-model-import/model-type-guess/model-summary` 各
替身测试；加密面 `tests/security/master-key.test.ts` +
`tests/ai/crypto-envelope.test.ts`，引擎解密收口契约
`tests/ai/provider-secret-decrypt.test.ts`（批1A，密文行 → createChatModel
收明文）——server 仓另有 jest 的 provider/repository 套件。

## 5. 业界主流做法对比

| 方案 | 核心机制 | 与天枢的差异 |
|---|---|---|
| **OpenRouter** | 统一网关 300+ 模型单一 OpenAI 兼容端点；:nitro 路由按价格/延迟/正常率自动选 provider；模型元数据目录（context length、价格、modality、tool-call 支持全量公开 API） | 天枢是**本地直连各厂商**（无网关中间层，密钥与数据不经第三方）；无自动 provider 路由/多活；模型元数据（窗口/能力/价格）无目录来源，靠手填 + 128K 兜底 |
| **LiteLLM proxy** | 100+ provider 统一成 OpenAI 形态；预算/限流/支出追踪、fallback 与重试策略（router 配置）、虚拟 key 团队分发 | 天枢无预算控制、无支出追踪（llmCallEvent 只有 token 无价格折算）、无 fallback/重试路由；团队多用户只有 userId 隔离，无 per-user 配额 |
| **Cherry Studio / ChatBox**（桌面客户端） | provider 管理 UX：预置服务商名录一键添加、模型拉取勾选、**延迟与速度实测**（TTFB/tokens/s 排序）、按模型单独配参 | 天枢预设九项 + 四协议拉取导入对齐主流；缺实测测速（仅连通验证）；Cherry 的「模型能力标签（视觉/推理/工具）」在库无对应列 |
| **Ollama 本地模型管理** | `/api/tags` 列模型、`/api/show` 拉单模型元数据（context length 可从 Modelfile 得到）、模型下拉即用 | 天枢已接 `/api/tags`（`listOllamaModels`）；未消费 `/api/show`——本地模型的 contextWindow 仍需手填（这是窗口元数据最易得的自动来源，未利用） |
| **能力协商与 fallback 路由**（OpenAI automatic_fallback / LiteLLM router / Bedrock cross-region） | 健康探测 + 按能力（vision/tools/窗口）筛候选 + 瞬态错误自动切换备用 | 天枢无任何 fallback：单模型单通道，429/网络错误直达用户（错误分类只做文案映射）；能力协商不存在（vision 靠事后 400 发现） |

逐项展开：

- **对 OpenRouter 的取舍**：天枢选择本地直连而非统一网关，收益是密钥与对话数据不
  经第三方、内网/中转站（openai-compatible + 自定义 baseUrl/extraHeaders）可接入
  ——这是企业内网场景的正确取舍；代价是失去网关侧的模型元数据目录、:nitro 多活
  路由与统一计费。**可借鉴而不引入网关的**：其公开 models API 的元数据结构
  （context_length、pricing、modality、supported_parameters）正是 §6 项 5 能力矩阵
  缺失的填充来源——拉取一次做本地缓存即可，不改变直连架构。
- **对 LiteLLM 的取舍**：LiteLLM proxy 是服务端代理模式（统一 OpenAI 形态 + 预算/
  限流/虚拟 key），天枢的等价物是 tianshu-server 的 `provider/query/save` 控制面 +
  relay 多租户（AK 签发/吊销），但**预算与支出维度完全缺席**——llmCallEvent 已按
  modelId/sessionId 记 token，缺价格表即无法折算成本，加 `pricePerMTokens` 两列
  （in/out）即可补齐监控页成本视图，是投入产出比最高的借鉴项。
- **对 Cherry Studio/ChatBox 的取舍**：三家的 provider 管理 UX 高度同构（预设名录
  一键添加 → 拉模型 → 勾选导入 → 逐模型配参），天枢已对齐；差距集中在**测速**
  （TTFB/tokens/s 实测排序）与**能力标签**（视觉/推理/工具开关）。测速最小实现：
  复用 `testLlmConnection` 的 invoke 换 `stream()`，计时首 chunk 与 N token 完成
  点，10 秒上限内即可。
- **对 Ollama 的取舍**：`/api/tags` 列表已接；`/api/show` 的 Modelfile 元数据
  （含 context length）未消费——本地模型的 contextWindow 本可零手填自动回填，
  这是窗口元数据最易得的确定性来源（§6 项 1c）。
- **对 fallback 路由的取舍**：桌面单机场景做多活路由收益有限（同一上游挂了备用
  也常挂），但**跨厂商备选**（429 时切备用模型）与**会话内模型失效提示**（当前
  模型连续 AUTH_FAILED/MODEL_NOT_FOUND 时引导切换）是真实需求；`classifyError`
  的七值分类已把「瞬态 vs 永久」判别做好，缺的只是路由决策层与配置面。

## 6. 改进空间

1. **contextWindow 元数据缺失致截断失效（同 chat-core 文档项 1）**：model.contextWindow
   历史上全 NULL 且无兜底，历史截断与自动压缩整体失效（实测单轮 input 失控至数百万
   token）。2026-11-01 批已补 provider 级列 + `DEFAULT_CONTEXT_WINDOW = 131_072`
   三层兜底（`effectiveContextWindow`），**但**：(a) 兜底值是静态假设，8K 小模型被
   撑爆（上游 400）、200K/1M 模型被过早截断，DB 仍以 NULL 为主；(b) 无模型目录
   （OpenRouter models API / models.dev / LiteLLM catalog）自动回填窗口与价格；
   (c) Ollama `/api/show` 的 Modelfile 元数据未消费——本地模型窗口本可零手填。
2. ✅ **已落地（批1A，2026-11-05）**：apiKey 加密链路引擎读侧收口——新增
   `openProviderSecrets()`（`provider-runtime.ts`）单源解密，chat 引擎两处裸读
   （`assembleContext`/`polishText`，覆盖 `streamAndPersist`/`memberModelText`/
   `generateTitleIfFirstExchange` 消费点）、交接摘要 `resolveHandoverModel`、图编排
   `loadModelRuntime`/`loadProviderRuntime`、自动化执行链全部接入（契约测试
   `tests/ai/provider-secret-decrypt.test.ts`）。加密降级状态已接 UI：
   `security:masterKeyStatus` 通道 + 服务商设置页警示条
   （`settings:security.encryptDegraded`）；`isMasterKeyDegraded()` 冷进程漏报
   一并修——`getMasterKeyStatus()` 先加载再读标记。残余弱化面：server 侧
   `TIANSHU_MASTER_KEY` 未设（明文 + 启动告警）仍无 UI 透出（server 无设置页，
   属运维面非产品面）。
3. **无 fallback/多活路由**：单模型故障即会话不可用。可在模型层加「备用模型」列
   （或 workspace 级 fallback 链），`classifyError` 判瞬态（RATE_LIMITED/NETWORK/
   TIMEOUT）时自动切备选重试一次——错误分类基础设施已备，只差路由决策层。
4. **无真实测速**：`model:test` 仅单次 invoke 连通验证。可加轻量基准（流式首 token
  延迟 + N token 生成速度），在 ModelList 排序展示——Cherry Studio 已验证该 UX
  价值；现有 `durationMs` 落库（message 表）可先做事后统计近似。具体落点：
  `connectivity.ts` 增 `benchModel()`（`createChatModel(...).stream("hi")` 计
  首 chunk 与固定 prompt 完成时长，10s 上限），`ModelRecord` 加非持久化字段承载
  结果，`ModelList.tsx` 列头排序——零 schema 变更。
5. **能力矩阵薄**：无 vision/function-calling 标志列与价格列。最小改法：model 表加
   `capabilities`（JSON：vision/tools）+ `pricePerMTokens`（in/out），导入时按目录
   预填、用量监控页即可折算成本；vision 缺标志导致用户只能试错发现
   IMAGE_UNSUPPORTED。
6. **comfyui 语义松**：桌面 `ProviderType` 含 comfyui 但模型工厂落 openai default
   分支（无对话能力），provider:test 仅 comfyui 可用而 model:test 对 comfyui 走
   `/system_stats`——类型系统与运行时行为不对齐，宜在工厂显式拒绝或独立分支。
7. **小项**：presets.ts 注释「精选 8 家」实际数组 9 项（含 ComfyUI）；桌面
   `guessModelType` 与移动 `inferModelType` 双份启发式未收编 `@tianshu/core`；
   CLAUDE.md「依赖分区铁律现 4 包」滞后于现状 6 项（external 5 项）；
   `provider:test` 通道的「仅 comfyui 可用」语义与名称不符（其余类型走
   `model:test` 才有验证），移动端/远控台对 provider 级验证只能借 fetchModels
   间接判定，接口语义可再梳理。

## 7. 附：与聊天链路的接缝

provider/model 是纯配置域，运行时唯一出口是被 `assembleContext`
（`electron/domains/ai/chat/chat.service.ts` L2084）消费：模型行 + 服务商行 +
三级参数合并 → `createChatModel` 构造 → `runChatStream`（详见
`docs/design/chat-core.md` §3.2/§3.4——截断预算的 `contextWindow` 与采样参数均
源于本域落库值）。两个域的耦合点仅三处：`getEffectiveModelId` 解析链、
`effectiveContextWindow` 三层兜底、`classifyError` 错误文案——这也是把窗口元数据
修复放在 provider 域、而截断行为修复在 core 包的原因（同一次 2026-11-01 批次
两端同落）。
