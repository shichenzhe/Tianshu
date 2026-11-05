# docs/design 改进项逐批落地实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `docs/design/` 12 篇技术方案文档「改进空间」节中的可落地项（约 40 项）逐批实施并同步更新对应文档，大工程/需裁定项明确挂账。

**Architecture:** 按文件域正交性划分 10 个执行批，批间串行（每批一 commit）、批内 ≤3 agent 并行；每批完成后更新对应 `docs/design/*.md` 改进空间节（已落地项标注状态与批次）并提交。最大冲突热点 `chat.service.ts` 相关项集中到批 5/6 串行处理。

**Tech Stack:** Electron 44 + React 19 + NestJS + Prisma 7(SQLite) + LangChain/LangGraph + Vitest/Jest；共享包 `packages/tianshu-protocol`（纯类型）、`packages/tianshu-core`（纯逻辑，desktop alias 直引源码 / server 消费 dist）。

**Spec:** `docs/design/*.md` 12 篇（各任务引用对应篇目 §6 改进空间的具体编号条目——条目内含改动文件、函数、落地方案，是本计划的详细 spec，随计划执行）。

## Global Constraints

- **主树串行批**：本会话独占主树（起点 git clean），每批一个 commit；不使用 worktree（文档更新与代码须同批一致，worktree 沙箱拦截主树写）。若用户另有并行会话需求随时叫停。
- **schema 变更**：当前处于发布前窗口（db_version=1），直接改 `apps/tianshu-desktop/prisma/schema.prisma` v1 快照即可，不加 vN 脚本；涉及 server 同表时同步 `apps/tianshu-server/prisma/schema.prisma`（PascalCase `@@map` 同名物理表）。快照 sha256 指纹守卫自动重建旧库（开发期数据可弃）。
- **共享包纪律**：改 `packages/tianshu-core` 或 `packages/tianshu-protocol` 源码后必须重建 dist：`npm --prefix packages/tianshu-core run build`（core）与 protocol 同理；server jest 消费 dist，不重建必炸。desktop 走 alias 直引源码不受影响。
- **双份同构文件**：`chat/blocks.ts` 与 server `logic/blocks.ts` 新块型必须双改；drift manifest 基线受影响时跑 `npm run check:drift` 核对，必要时 `-- --rebase` 并在 commit message 注明人工复核结论。
- **测试纪律（TDD）**：每项先写失败测试再实现；桌面 `cd apps/tianshu-desktop && npx vitest run <相关路径>`；server `cd apps/tianshu-server && npx jest <相关>`；真库测试依赖 `.native-node` 副本（已就绪，勿手动 rebuild better-sqlite3）。
- **rtk 假信号**：存在性/校验结论一律原生命令复核（`command grep` / `ls` / node -e）；npm test 退出码可疑时重跑确认。
- **禁止启动长驻进程**（dev/expo/relay 等）；不动 mobile 的 nativewind 本地树。
- **UI 纪律**：新文案走 i18n（zh-CN + en-US 双加，t() 引用）；主题色用 CSS 变量类（bg-primary 等），禁硬编码颜色；边框 `border-border/50`。
- **跨平台**：路径处理跨 win32；平台二进制永不硬声明。
- **提交格式**：中文 conventional commit（参照 `git log` 既有风格，如 `feat(desktop): ...`——改进项所在端）；每批 commit message 列出落地的改进项编号。
- **文档同步**：每批改动落地后，更新对应 `docs/design/*.md`：改进空间节该项前加 `✅ 已落地（本批）` 并简注实现形态；正文技术方案节若行为已变需同步改写。README.md 最后统一更新。

---

### Task 1（批1A）: provider openSecret 收口 + 加密降级状态透出

**Files:**
- Modify: `apps/tianshu-desktop/electron/domains/ai/chat/chat.service.ts`（四处直读 provider 行处——provider-model.md §6 项 2 定位）
- Modify: `apps/tianshu-desktop/electron/infrastructure/master-key.ts` 或其查询面（`isMasterKeyDegraded()` 接 UI）
- Modify: `apps/tianshu-desktop/src-react/domains/ai/provider/`（设置页加密状态提示）
- Test: 桌面 vitest 相关 suite

**Interfaces:**
- Consumes: `openSecret` / `getRuntimeInfo()`（文档 §3.2 所指既有解密面）
- Produces: chat 引擎构造模型时 apiKey 恒为明文（解密后）；设置页新增「加密降级」警示条（isMasterKeyDegraded=true 时显示）

**Steps:**

- [ ] Step 1: 读 `docs/design/provider-model.md` §6 项 2 与 §3.2，grep 定位 chat.service.ts 四处直读 prisma provider 行的确切行号（搜索 `prisma.provider.findFirst`/`findUnique` 在 chat 域的调用点）
- [ ] Step 2: 写失败测试：模拟 safeStorage 可用 + provider 行 apiKey 为 `enc:v1:` 密文，断言 createChatModel 收到明文（替身注入法，参照 tianshu-retention-batch-learnings 两路替身法）
- [ ] Step 3: 四处统一改走 `getRuntimeInfo()` 或补 `openSecret` 解密；跑测试通过
- [ ] Step 4: 设置页接 `isMasterKeyDegraded()` 透出降级警示（i18n 双语 key：`settings:security.encryptDegraded`）
- [ ] Step 5: `cd apps/tianshu-desktop && npx vitest run`（chat/provider 相关子集全绿）
- [ ] Step 6: 更新 `docs/design/provider-model.md`（§6 项 2 标 ✅；§3.2 ⚠ 段改写为已收口）
- [ ] Step 7: `git add -A && git commit`（fix(desktop): provider apiKey 桌面聊天链路解密收口 + 加密降级状态透出）

### Task 2（批1B）: 监控页主机路由化 + server 事件保留期裁剪

**Files:**
- Modify: `apps/tianshu-desktop/src-react/domains/ai/monitor/api/monitor.api.ts`（routeInvoke 双通道化）
- Modify: `apps/tianshu-desktop/src-react/domains/ai/server/`（主机页用量摘要卡）
- Modify: `apps/tianshu-server/src/modules/monitor/monitor.service.ts`（90 天裁剪 + 每日 setInterval）
- Test: 前端 store 测试 + server jest monitor suite

**Interfaces:**
- Consumes: `host-route.ts` 的 `routeInvoke` 模式；`server.api.ts` 的 `requestRemote(connId,"POST",ENDPOINTS.monitor.stats,...)`；被控面 `POST monitor/stats` 端点（均已存在）
- Produces: monitor.api 导出的所有读面走双通道；server 侧 `pruneMonitorEvents(cutoffDays=90)` 每日执行

**Steps:**

- [ ] Step 1: 读 `docs/design/monitoring.md` §6 P0-1/P0-2 与 §3/§4；对照 `chat.api.ts` 等 host-route 先例
- [ ] Step 2: server 裁剪：写失败 jest（插入 91 天前事件 → prune 后消失、89 天前保留）；实现 `pruneMonitorEvents` + Nest lifecycle 每日 setInterval；跑绿
- [ ] Step 3: 桌面路由化：monitor.api.ts 全部读面改 routeInvoke（本地 invoke 原样/远程 requestRemote）；本地手测路径保持零行为变化
- [ ] Step 4: 主机页用量摘要卡：选中远程连接时展示 monitor/stats 摘要（token/调用数），UI 纪律（i18n/主题变量）
- [ ] Step 5: 桌面 vitest monitor 相关 + server jest monitor 双绿；原生命令复核退出码
- [ ] Step 6: 更新 `docs/design/monitoring.md`（P0-1/P0-2 标 ✅）
- [ ] Step 7: commit（feat: 监控页主机路由化+无头端事件保留期裁剪）

### Task 3（批1C）: workflow 三快赢（run 快照 / webhook 互斥 / notify 标注）

**Files:**
- Modify: `apps/tianshu-desktop/electron/domains/ai/orchestration/`（runForWebhook 互斥、run 落 graphJson 快照）
- Modify: `apps/tianshu-server/src/core/graph/executor-runtime.ts` 或 notify handler（trace 标注未送达渠道）
- Test: 桌面 vitest orchestration suite + server graph jest

**Interfaces:**
- Consumes: `graphTestInflight` 互斥先例；automationRun 行结构
- Produces: webhook 触发同图并发第二请求被拒（错误码如 `graph_inflight`）；run 新增 graphJson 快照（复用 graphTrace 或新列——发布前窗口可直接加列）；server notify 降级时 trace 条目含 `notifySkipped` 标注

**Steps:**

- [ ] Step 1: 读 `docs/design/workflow-graphs.md` §6 项 3/4/9
- [ ] Step 2: 失败测试×3：webhook 并发互斥、run 快照落库、notify 降级 trace 标注
- [ ] Step 3: 实现三处（互斥复用 graphTestInflight 键式或新增图级 inflight 键；快照加 `graphJsonSnapshot String?` 列于 automationRun 或落 graphRunNode 旁路——以最小改动定案并在文档注明）
- [ ] Step 4: 双端测试绿（桌面 orchestration + server graph）；若 schema 改动同步 server schema
- [ ] Step 5: 更新 `docs/design/workflow-graphs.md`（项 3/4/9 标 ✅）
- [ ] Step 6: commit（feat: 图运行快照+webhook互斥+notify降级标注）

### Task 4（批2）: 资料库桌面写侧向量化 + 递归切块

**Files:**
- Create/Move: `packages/tianshu-core/src/library-vectorize.ts`（从 server `src/core/library/library-vectorize.ts` 收编纯函数，deps 注入面保持）
- Modify: `packages/tianshu-desktop` 名下 `electron/domains/ai/library/library.repo.ts`（addFiles/uploadFileBuffer/writeFileContent 后 fire-and-forget 向量化）
- Modify: `electron/domains/ai/orchestration/vector-store.ts`（补 `deleteSourceChunks`——server 版已有，对齐）+ delete/rename 联动
- Modify: `packages/tianshu-core/src/`（chunkText 升级递归字符切分）
- Modify: 桌面 `library_search` 工具语义版 + 文件名降级（skills/chat 工具注册处）
- Test: core vitest + 桌面 vitest + server jest（library）

**Interfaces:**
- Consumes: server `vectorizeLibraryContent` 先例；`VectorStore.searchChunks/findFilesByNames`；桌面 embedding 调用链（graph-executor embedTexts 路径）
- Produces: 桌面 `library` 集合非空；`chunkText` 递归层级 `["\n\n","\n","。"," "]`；`deleteSourceChunks(collection, sourceName)`

**Steps:**

- [ ] Step 1: 读 `docs/design/library-rag.md` §6 P0-1/P1-2 与 §3 全链路
- [ ] Step 2: 收编 vectorizeLibraryContent 进 core（保持纯函数+deps 注入；server 改引 core 版重建 dist；注意 server jest partial mock interop 坑——工具实现走 deps 注入面）
- [ ] Step 3: 失败测试：core 递归切块（中文句号/空格层级回退 case）；桌面向量化挂载（替身 VectorStore 断言 upsertChunks 被调）；deleteSourceChunks
- [ ] Step 4: 实现桌面挂载（fire-and-forget + 失败静默跳过同 server 哲学）+ library_search 语义版（最新块 model → embed → searchChunks → 回联，无 embedding 模型降级文件名版）
- [ ] Step 5: 三端测试绿：core vitest、桌面 vitest（library/orchestration）、server jest（library 引用 core 版）；`npm --prefix packages/tianshu-core run build` + protocol 如涉
- [ ] Step 6: 更新 `docs/design/library-rag.md`（P0-1/P1-2 标 ✅；§4 两端异构段改写）
- [ ] Step 7: commit（feat: 资料库桌面写侧向量化收编 core+递归切块+library_search 语义版）

### Task 5（批3A）: automation 重试退避 + 补偿参数化 + 每日 rollup

**Files:**
- Modify: `apps/tianshu-desktop/electron/domains/ai/automation/`（调度器重试/补偿/rollup）+ server `src/modules/automation/` 对称
- Modify: `packages/tianshu-core/src/automation-*` 纯函数（若有 decideTick/补偿语义在 core——以代码实况为准，纯函数优先下沉）
- Test: 桌面 vitest automation suite + server jest automation

**Interfaces:**
- Consumes: `classifyError` 错误分类；`decideTick` 六态纯函数
- Produces: 重试退避 60/180/540s（可测的 `nextRetryDelay(attempt)` 纯函数）；`missedPolicy` 补跑上限参数（缺省 1）；scheduleText 明示补跑语义；每日 rollup（优先 automationStat 新 bucket 类型免 schema 迁移——查证表结构后定案）

**Steps:**

- [ ] Step 1: 读 `docs/design/automation-scheduled-tasks.md` §6 项 1/4/6 与 §3 调度器
- [ ] Step 2: 失败测试：退避序列、网络类错误重试/配置类不重试、catchUpOnce 补跑上限、rollup 聚合正确性
- [ ] Step 3: 实现四项（双端对称：桌面与 server 同构改动；rollup 若需列则发布前窗口直接加）
- [ ] Step 4: 双端测试绿
- [ ] Step 5: 更新 `docs/design/automation-scheduled-tasks.md`（项 1/4/6 标 ✅）
- [ ] Step 6: commit（feat: 自动化重试指数退避+错过补跑参数化+统计每日 rollup）

### Task 6（批3B）: multi-host 快赢（queryKey 主机化 + protocolVersion + Direct 警示徽标）

**Files:**
- Modify: `apps/tianshu-desktop/src-react/domains/ai/data-source/switch-host.ts` + 各 api queryKey 构造（约十处）
- Modify: `packages/tianshu-protocol/src/`（RemoteInstanceInfo 加 protocolVersion 可选列 + 常量）
- Modify: server `/info` 端点与被控面（上报 protocolVersion）；连接详情/主机页对过低版本给升级提示；`http://` 非局域网地址警示徽标
- Test: 前端相关测试 + protocol build

**Interfaces:**
- Consumes: `queryClient.clear()` 现机制；relay plaintext 警示徽标视觉先例
- Produces: queryKey 前缀含 activeHost；`PROTOCOL_VERSION` 常量单源 protocol；Direct 连接 `isPlainHttpRemote` 判定与徽标组件

**Steps:**

- [ ] Step 1: 读 `docs/design/multi-host-server-relay.md` §5 项 1/7/9
- [ ] Step 2: 失败测试：同 key 不同主机不共享缓存、protocolVersion 缺失兼容（老被控端 undefined 不告警）、http 非局域网判定
- [ ] Step 3: 实现三处（switch-host 移除全清改前缀隔离——注意回切缓存命中验证；版本协商；徽标）
- [ ] Step 4: 桌面 vitest 相关绿；protocol/core build
- [ ] Step 5: 更新 `docs/design/multi-host-server-relay.md`（项 1/7/9 标 ✅；§2 分层描述同步）
- [ ] Step 6: commit（feat: queryKey 主机隔离+协议版本协商+直连明文警示）

### Task 7（批4A）: TOFU 指纹核对 UI（首连确认卡 + 连接详情常显）

**Files:**
- Modify: `apps/tianshu-desktop/electron/domains/server/relay-transport.ts`（TOFU 分支不再自动回填，上报待确认态）
- Modify: `packages/tianshu-protocol/src/`（连接状态类型加 pendingConfirm/confirmedAt 字段）
- Modify: `apps/tianshu-desktop/src-react/domains/ai/server/`（主机页确认卡 + 连接详情指纹常显 + 核对确认动作）
- Test: 桌面 vitest（transport 状态机）+ 前端组件测试

**Interfaces:**
- Consumes: `fingerprintOf`（16hex）；`connections` 行注册表
- Produces: 首连 TOFU → 状态 `pendingConfirm`（通信可用但 UI 呈 mitm-suspect 同款警示 + 指纹核对卡）；用户确认 → 回填指纹 + confirmedAt；之后指纹变化仍走 mitm-suspect

**Steps:**

- [ ] Step 1: 读 `docs/design/security.md` §6 P0-1 与 `multi-host-server-relay.md` §5 项 5
- [ ] Step 2: 失败测试：TOFU 首连不自动回填、确认后回填持久化、指纹变化报警不回归
- [ ] Step 3: 实现（UI 纪律：i18n/主题变量/Popover 边框 border-border/50；迁移：既有已回填连接视为已确认——confirmedAt 取 createdAt，避免升级后全员弹窗）
- [ ] Step 4: 桌面 vitest 绿；protocol build
- [ ] Step 5: 更新 `docs/design/security.md`（P0-1 标 ✅、遗留表 #3 状态改已闭环）与 `multi-host-server-relay.md`（项 5 标 ✅）
- [ ] Step 6: commit（feat: relay TOFU 指纹用户确认仪式+连接详情指纹常显）

### Task 8（批4B）: server 操作日志启用 + TLS 告警 + MCP 进 monitor 聚合

**Files:**
- Modify: `apps/tianshu-server/src/modules/operationlog/operation-log.interceptor.ts`（DISABLE_LOG 改配置 `operationLog.enabled` 缺省 true）+ config 读取面
- Modify: `apps/tianshu-server/src/` listen-host 或 main.ts（非 loopback 且 relay 无 TLS 且无反代标识 → 启动告警）
- Modify: `packages/tianshu-core/src/monitor-stats.ts`（`mcp__` 前缀切分组 + 按 server 聚合视图字段）+ 桌面前端监控页 server 维度视图
- Test: server jest（operationlog/monitor）+ core vitest + 桌面前端

**Interfaces:**
- Consumes: `MonitorStats` 聚合结构；commandPreview 脱敏口径
- Produces: operation_log 表真实写入（config 可关）；`listenNonLocalWithoutTls` 启动告警日志；`MonitorStats.mcpByServer`（成功率/延迟/次数）

**Steps:**

- [ ] Step 1: 读 `docs/design/security.md` §6 P0-2/P2-1 与 `skills-tools-mcp.md` §6 项 8、`monitoring.md` §7 边界
- [ ] Step 2: 失败测试：配置驱动开关（true 写入/false 不写）；非 loopback 无 TLS 告警；mcp__ 分组聚合正确
- [ ] Step 3: 实现三处（脱敏口径对齐桌面审计链；监控页 server 维度卡片——UI 纪律）
- [ ] Step 4: server jest + core vitest + 桌面 vitest 绿；core build
- [ ] Step 5: 更新三篇文档对应项标 ✅（security P0-2/P2-1、skills 项 8、monitoring §7 operationlog 状态）
- [ ] Step 6: commit（feat: server 操作日志启用+非TLS监听告警+MCP 调用监控聚合）

### Task 9（批5）: provider/chat 运行时强化（能力矩阵/目录回填/成本/重试/fallback/测速/comfyui）

**Files:**
- Modify: `apps/tianshu-desktop/prisma/schema.prisma`（model 加 `capabilities String?`/`priceInPerMtokens Float?`/`priceOutPerMtokens Float?`/`fallbackModelId Int?`）+ server schema 同步（model 表若 server 有）
- Create: `packages/tianshu-core/src/model-catalog.ts`（内置静态目录：常见模型 id → contextWindow/价格/能力，本地 JSON 数据零外部依赖）
- Modify: `packages/tianshu-core/src/`（run-chat-stream 瞬态错误重试一次；effectiveContextWindow 优先消费目录值）
- Modify: `apps/tianshu-desktop/electron/domains/ai/provider/`（connectivity.ts 增 benchModel；工厂 comfyui 显式分支）
- Modify: `packages/tianshu-core/src/monitor-stats.ts`（成本折算 cost 口径）+ 监控页成本列
- Modify: 前端 ModelList 测速展示/模型表单 fallback 与价格编辑
- Test: core vitest + 桌面 vitest + server jest（provider/monitor）

**Interfaces:**
- Consumes: `classifyError`（RATE_LIMITED/NETWORK/TIMEOUT 判定）；`createChatModel`
- Produces: `lookupModelCatalog(modelId) → {contextWindow?, priceIn?, priceOut?, vision?, tools?} | undefined`；重试语义：瞬态错误退避 1 次重试（同模型），fallback 列有值再切备选重试 1 次，全部失败才报错；`benchModel() → {firstChunkMs, tokensPerSec} | {error}`；`MonitorStats.totalCost` 与 per-model cost

**Steps:**

- [ ] Step 1: 读 `docs/design/provider-model.md` §6 项 1/3/4/5/6/7 与 `chat-core.md` §6 项 1/2/5（截断提示归批6）、`monitoring.md` §6 P1-3
- [ ] Step 2: 失败测试：目录匹配（含别名形态 ollama 前缀）；瞬态重试（mock 首次 429 第二次成功）与配置类错误不重试；fallback 切换；成本折算（有价折算/无价 unknown）；benchModel 计时替身
- [ ] Step 3: 按依赖序实现：schema 列 → core 目录+重试+折算 → provider 工厂/测速 → 前端展示；schema 变更后同步 server 并重建共享包 dist
- [ ] Step 4: 全端测试绿（core/desktop/server 各自套件）
- [ ] Step 5: 更新三篇文档对应项标 ✅
- [ ] Step 6: commit（feat: 模型能力矩阵+目录回填+瞬态重试与fallback+测速+成本折算）

### Task 10（批6）: chat 编排域（截断提示 + 专家团成员埋点 + memberReport 块）

**Files:**
- Modify: `apps/tianshu-desktop/electron/domains/ai/agent/dispatch-member-tool.ts`（recordLlmCall/recordToolCall 补埋点）
- Modify: `packages/tianshu-protocol/src/`（chunk/blocks 契约加 memberReport 型——增量可选）
- Modify: `packages/tianshu-desktop` 与 server 的双份 `chat/blocks.ts`/`logic/blocks.ts`（新块型双改）
- Modify: `electron/domains/ai/chat/chat.service.ts`（成员产出落块；截断发生时 usage/提示面透出）
- Modify: 前端 chat 渲染（成员折叠卡，AgentProgress/ToolCallCard 先例）+ 移动端 blocks 逻辑 + 用量面板「成员调度」分类（context-usage-button.tsx）
- Test: core vitest + 桌面 vitest + server jest + 移动端 vitest（如涉）

**Interfaces:**
- Consumes: `recordLlmCall/recordToolCall`（monitor-events）；`getUsageBreakdown`（chat:usage）
- Produces: 成员调用进 llmCallEvent（meta 含成员名/轮次）；dispatch 进 toolCallEvent；`MemberReportBlock {type:"memberReport", memberName, content, ...}`；截断发生处 usage 面板透出「已裁早期上下文」提示

**Steps:**

- [ ] Step 1: 读 `docs/design/experts.md` §6 P1×2 与 `chat-core.md` §6 项 5；参照既有块型双改先例（tianshu-chat-multimodal-image-path 教训）
- [ ] Step 2: 失败测试：埋点断言（替身 recorder）；memberReport 序列化/渲染；截断提示触发
- [ ] Step 3: 实现三块（协议增量兼容：老端遇未知块型忽略；移动端 MarkdownLite/渲染逻辑同步）
- [ ] Step 4: 全端测试绿；protocol/core build；drift 核对
- [ ] Step 5: 更新两篇文档对应项标 ✅
- [ ] Step 6: commit（feat: 专家团成员可观测性（埋点+memberReport块）+截断丢失提示）

### Task 11（批7）: skills 声明 + 审批参数级 + toolPermission 治理

**Files:**
- Modify: `apps/tianshu-desktop/electron/domains/ai/skills/skill-loader.ts`（frontmatter 解析可选 `tools` 字段）
- Modify: `electron/domains/ai/agent/tool-groups.ts` + chat.service 装配（技能挂载→工具组开关）
- Modify: `packages/tianshu-protocol/src/skill-contract`（SkillInfo 加可选列）
- Modify: schema（toolPermission 加 `pattern String?`、`lastUsedAt DateTime?`）+ `runToolCall` 记忆命中从全等改模式匹配（bash 命令前缀/write 路径 glob——cmdAllow prefix 规则复用）+ 记忆直执行分支 lastUsedAt 回写
- Modify: `packages/tianshu-core` 相关纯函数收编（模式匹配判定单源）；MCP 折叠预算按 contextWindow 自适应（MCP_TOOL_SURFACE_BUDGET 动态线）
- Modify: 前端审批横幅「始终允许」带参数前缀选项；安全中心 90 天未用清理提示
- Test: core vitest + 桌面 vitest（tool-gate/skill）+ server jest 对称

**Interfaces:**
- Consumes: `cmdAllow` prefix 规则结构；`WORKFLOW_CREATOR_SKILL_NAME` 挂载信号先例
- Produces: `matchPermissionPattern(pattern, toolName, args) → boolean`（core 单源）；SKILL.md `tools:` 字段；`lastUsedAt` fire-and-forget 回写；折叠预算 `surfaceBudgetFor(contextWindow)`

**Steps:**

- [ ] Step 1: 读 `docs/design/skills-tools-mcp.md` §6 项 1/3/5/6 与 `security.md` §6 P1-3
- [ ] Step 2: 失败测试：frontmatter tools 解析与挂载注入；pattern 匹配（`bash:git *` 命中 `git push` 不命中 `rm`）；lastUsedAt 回写；预算自适应边界
- [ ] Step 3: 实现四块（权限契约 permission-contract 双端同步；保守缺省：无 pattern 列行为与旧全等一致）
- [ ] Step 4: 全端测试绿；共享包 build
- [ ] Step 5: 更新两篇文档对应项标 ✅
- [ ] Step 6: commit（feat: 技能级工具声明+审批参数级记忆+权限治理与折叠自适应）

### Task 12（批8）: project 域（记忆沉淀 + 审计 + 死链治理 + 挂载清理）

**Files:**
- Modify: `apps/tianshu-desktop/electron/domains/project/`（repo/service：交接与会话结束回写 `memory.md`、getPromptContext 读入、审计三类事件、delete/rename 反查解绑、失效挂载清理通道）
- Modify: `electron/domains/security/audit/audit-log.service.ts` 消费方（project.removed/bindingChanged/assetDeleted）
- Modify: 前端 project 组件（清理入口、死链提示）
- Test: 桌面 vitest project suite

**Interfaces:**
- Consumes: `append({eventType, decision, ...})` 审计模式；`assetWorkspaceId`/`@` 引用/`assetPath` 机制；`setBindings` 全量替换通道
- Produces: 项目资产空间 `memory.md`（AI 沉淀）+ systemPrompt（人写）双层上下文；三类审计事件入账；附件打开前存在性校验置失效态

**Steps:**

- [ ] Step 1: 读 `docs/design/project.md` §6 P0/P2/P3/P6 与 §3 相关段
- [ ] Step 2: 失败测试：交接回写触发与内容形态；memory.md 读入拼装进 buildProjectSystemBase；三类审计事件；delete 反查解绑/失效态
- [ ] Step 3: 实现四块（回写走既有 handover 管线挂点；失败静默不阻塞交接主流程）
- [ ] Step 4: 桌面 vitest 绿
- [ ] Step 5: 更新 `docs/design/project.md` 对应项标 ✅
- [ ] Step 6: commit（feat: 项目记忆沉淀+项目域审计+附件死链治理+失效挂载清理）

### Task 13（批9）: memory 域（userId 隔离 + 预算治理 + 条目溯源 + 记住这个）

**Files:**
- Modify: `apps/tianshu-desktop/electron/domains/ai/personalization/`（option key 按 `personalization.<userId>.memoryProfile` 拆行命名空间——读写两侧 fromAppOptions 加 userId 维度；scheduler 兜底模型选型随隔离调整）
- Modify: chat.service.ts assembleContext（超预算按段优先级裁剪：customInstructions > memory > 工作背景/个人背景 > 当前关注 > 近期动态）
- Modify: 记忆整理 prompt（条目失效规则 + msgId 携带 `[YYYY-MM-DD|#msgId]`）+ fetchRecentConversation 素材行携带
- Modify: 前端（消息级/输入框「存入记忆」入口调 applyInstruction；设置页逐条删除与来源会话跳转；usage 面板「记忆占用」透出）
- Test: 桌面 vitest personalization/chat 相关

**Interfaces:**
- Consumes: `applyInstruction` 管线；`getUsageBreakdown` 同口径估算；批 2 落地的桌面 embedding 链（若做 P1 语义检索——本批**不含** P1/P5 检索化，明确留给后续批）
- Produces: `memoryProfileKeyFor(userId)` 单源函数；`trimProfileToBudget(profile, budgetTokens)` 纯函数（可下沉 core）；条目行带 msgId 溯源

**Steps:**

- [ ] Step 1: 读 `docs/design/memory-personalization.md` §6 P2/P4/P6/P7 与 §3
- [ ] Step 2: 失败测试：双用户隔离（A 画像不进 B 对话）；预算裁剪序；msgId 携带与解析；逐条删除
- [ ] Step 3: 实现四块（**数据迁移**：既有全局 `personalization.memoryProfile` 行首次读取时搬入当前用户命名空间并留旧 key 兼容读取——升级不断忆；scheduler 兜底模型改为「任一用户启用模型」需谨慎——保持现行为并注释）
- [ ] Step 4: 桌面 vitest 绿
- [ ] Step 5: 更新 `docs/design/memory-personalization.md` 对应项标 ✅（P1/P5 标注「待后续批：依赖检索化立项」）
- [ ] Step 6: commit（feat: 记忆 userId 隔离+注入预算治理+条目溯源与逐条管理+记住这个入口）

### Task 14（终验）: 全局测试 + 文档状态核对 + README 更新

**Files:**
- 全仓测试：`npm run test`（根，桌面+packages）、`npm run test -w apps/tianshu-server`、`npm run test -w apps/tianshu-mobile`（若涉移动端改动）
- `npm run check:drift`（若基线变动则 rebase 并复核）
- Modify: `docs/design/README.md`（索引表与 P0 汇总表更新为已落地状态；新增挂账清单章节）

**Steps:**

- [ ] Step 1: 跑全仓测试三端（原生命令复核退出码；server 侧先确认共享包 dist 已重建）
- [ ] Step 2: 逐篇核对 12 篇文档改进空间节标注与代码实况一致（抽查每批关键符号存在性）
- [ ] Step 3: 更新 README.md：已落地/挂账两张清单
- [ ] Step 4: 汇总报告给用户（含挂账大工程清单：workflow checkpointer/HITL、sqlite-vec、E2E 双棘轮、OS 沙箱、chat.service 拆分、多主机并发会话、relay 多副本、会话分叉树、块 id 协议、专家知识库绑定、跨主机记忆三方案、时区/powerMonitor、webhook 任务级触发、GraphRAG/多模态/OTel 长线——各自注明建议立项方式）

## Self-Review 结论

- 覆盖核对：12 篇文档每篇 ≥2 项落地（memory 4/安全 4/工作流 3/定时 3/项目 4/资料库 2/专家 2/监控 4/聊天 3/服务商 6/技能 4/多主机 4），其余项进挂账清单 ✓
- 冲突核对：chat.service.ts 集中于批 5/6/9 串行；monitor-stats.ts 集中批 4B/5 串行；tool-gate 集中批 7；批内三线文件域正交 ✓
- 依赖核对：批 9 依赖批 2 桌面 embedding 链仅在其不做 P1 检索化时不构成硬依赖（已明确本批不含检索化）✓
