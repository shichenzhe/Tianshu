# 天枢共享 core 重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以 mirror 为 source of truth 抽 `@tianshu/protocol` 与 `@tianshu/core` 两包，tianshu-server 重构为包消费者，消灭 chat 纯逻辑/协议类型的双仓双份。

**Architecture:** 包物理住 mirror 仓 `packages/`；mirror 经 alias 消费（不进 dependencies，rolldown 内联）；tianshu-server 经 npm `file:` 消费（nest build 全内联）。剩余双份（工具集/model 工厂）入 drift 巡检。

**Tech Stack:** TypeScript 包（tsc 构建）· vite/vitest alias · npm file: · NestJS tsc · Vitest/Jest 双侧回归。

**Spec:** `docs/superpowers/specs/2026-10-17-shared-core-refactor-design.md`（本计划从 spec 立论，执行者须同时阅读）

## Global Constraints

- **铁律不触碰**：mirror `package.json` dependencies/external 白名单零增删；包名 alias 走 `@tianshu/protocol`、`@tianshu/core`，登记四处（vite.config.ts 顶层 resolve、`plugins[].main.vite.resolve.alias`、vitest.config.ts、tsconfig.json paths）——vite-plugin-electron 的 main 构建是独立实例，顶层 alias 不传递，**四处缺一即 typecheck/构建失败**。
- **mirror 侧 re-export 兼容层**：原类型位置（`src-react/domains/ai/api/chat.api.ts`、`electron/domains/ai/chat/blocks.ts` 等）改 `export * from`/`export type {} from`，**不改既有 import 链**；服务端 import 链一步到位直指包。
- **wire 口径归一**：协议包 `ServerEvent.payload.updatedAt` 为 ISO string（mirror wire 口径为准）；服务端 publish 前序列化（`toISOString()`），Date 只存在于服务端进程内。
- mirror 风格：双引号分号 printWidth 80、文件名 kebab-case；tianshu-server 风格：单引号 trailingComma all。
- 双仓路径：mirror=`/Users/hjx/workspace/mirror`，server=`/Users/hjx/workspace/tianshu-server`；commit 各自在所属仓。
- 每任务开工前哨兵：`git -C <仓> log --oneline -3` 无本会话外新提交、`git status` 无他人未提交改动（上一计划并发事故的规程，见旧 ledger）。
- 测试基线：mirror `npx vitest run`（全量）+ `npm run typecheck` + `npm run lint`；server `npm test`。改动前先跑基线留档。

---

### Task 1: 协议包建立与 mirror 接入

**Files:**
- Create: `packages/tianshu-protocol/package.json`、`tsconfig.json`、`src/index.ts`（含 server-event.ts/blocks 契约/relay 帧三模块聚合导出）
- Create: `packages/tianshu-protocol/src/server-event.ts`（自 `electron/domains/server/protocol.ts` 的类型定义收编，updatedAt: string）、`src/relay-frames.ts`（自 `electron/domains/server-face/relay-protocol.ts` 收编）、`src/chat-contract.ts`（ChatStreamChunk/ChatSendParams/MessageBlock 等——自 `src-react/domains/ai/api/chat.api.ts` 与 `electron/domains/ai/chat/blocks.ts` 的**纯类型**收编）
- Modify: `vite.config.ts`（顶层 resolve.alias + main.vite resolve.alias 各加两条）、`vitest.config.ts`、`tsconfig.json`（paths）
- Modify: `electron/domains/server/protocol.ts`、`electron/domains/server-face/relay-protocol.ts`、`electron/domains/server-face/face-events.ts`、`src-react/domains/ai/api/chat.api.ts`、`electron/domains/ai/chat/blocks.ts` → 改为自协议包 re-export（原导出名不变）
- Test: `tests/ai/server/protocol-package.test.ts`（新：断言 re-export 链完整性——从 `@tianshu/protocol` 与从老路径 import 得到同一批类型标识（typeof 抽查）+ CAPABILITIES/端点常量值不变）

**Interfaces:**
- Produces: `@tianshu/protocol` 导出 `ServerEvent`、`CAPABILITIES`、`RelayFrame`（req/res/event/open/close 联合）、`ENDPOINTS`（session/provider 路径常量表，值=spec §3.1）、`ChatStreamChunk`、`ChatSendParams`、`MessageBlock` 及其子类型（TextBlock 等）、`ChatModelParams`（若 chat.api 中与 chunk 同文件则一并收编；**函数与运行时不收**，只收类型与常量）
- 包 package.json：`{ "name": "@tianshu/protocol", "version": "0.1.0", "type": "module", "main": "dist/index.js", "types": "dist/index.d.ts", "scripts": { "build": "tsc -p tsconfig.json" }, "files": ["dist"] }`；peerDependencies 无（零依赖）；tsc `outDir: dist`、`declaration: true`、`strict: true`。

- [ ] **Step 1: 哨兵+基线**：mirror 基线三件套跑通留档（当前全绿才开工；有红先报告）
- [ ] **Step 2: 写失败测试** `tests/ai/server/protocol-package.test.ts`：`import { CAPABILITIES, ENDPOINTS, type ServerEvent, type RelayFrame } from "@tianshu/protocol"`（模块不存在必失败）+ 老路径 re-export 等价断言（`import { CAPABILITIES as C2 } from "../../src-react/domains/ai/api/chat.api"` 视收编情况调整——按实际老导出位写）
- [ ] **Step 3: 跑测试确认失败**（alias 未登记时报 cannot resolve；先建包再登记 alias 后测）
- [ ] **Step 4: 建包+四处 alias+五个 re-export 改造**。blocks.ts 注意：类型与实现同文件——只把 `export interface/type` 块搬协议包，blocks.ts 剩余实现 `import type { MessageBlock, ... } from "@tianshu/protocol"` 并 re-export 保持老 import 链兼容；`parseBlocks/serializeBlocks/blocksToModelMessages` 留在原文件（T3 随核心包搬）
- [ ] **Step 5: 全量回归**：`npx vitest run && npm run typecheck && npm run lint` 全绿
- [ ] **Step 6: Commit（mirror）**：`feat(protocol): @tianshu/protocol 协议包建立+mirror re-export 接入（四处 alias）`

### Task 2: tianshu-server 接入协议包

**Files:**
- Modify: `package.json`（dependencies + `"@tianshu/protocol": "file:../mirror/packages/tianshu-protocol"`；scripts 加 `"sync:core": "npm i ../mirror/packages/tianshu-protocol ../mirror/packages/tianshu-core"`）
- Delete: `src/protocol/server-event.ts`（内容收编进协议包）
- Modify: 引用 `src/protocol/server-event` 的全部文件（grep 定位：event.controller、session 模块、relay 等）→ `import { ServerEvent, CAPABILITIES } from "@tianshu/protocol"`
- Modify: `src/core/chat/chat-stream-chunk.ts` → 改为 re-export `@tianshu/protocol` 的 ChatStreamChunk（若其含服务端特有子类型则保留差异注释，T5 处理）
- Modify: 序列化点：publish `session.updated` 处 `updatedAt: Date` → wire 口径 `toISOString()`（grep ServerEvent publish 点核查）

**Interfaces:**
- Consumes: T1 协议包（npm i file: 安装其 dist——T1 已带 build 产物；本任务先 `cd packages/tianshu-protocol && npm run build` 确保最新）
- Produces: server 侧单份协议消费；Jest `moduleNameMapper` 不需加（node_modules 解析 dist 的 main/types 即可，ts-jest 吃 .js + .d.ts）

- [ ] **Step 1: 哨兵+server 基线**（`npm test` 全绿留档）
- [ ] **Step 2: 安装+构建**：`cd ../mirror/packages/tianshu-protocol && npm run build`，server `npm i ../mirror/packages/tianshu-protocol`
- [ ] **Step 3: 删 src/protocol/ 改 import**（全量 grep `src/protocol` 无残留；`updatedAt` wire 归一含单测：SSE controller 测试断言 JSON 输出为 ISO 字符串）
- [ ] **Step 4: 回归**：server `npm test` 全绿（含 T1 收编后 server-event 语义未变的既有测试）
- [ ] **Step 5: Commit（server）**：`refactor(protocol): 接入 @tianshu/protocol——删本地副本+wire 口径归一`

### Task 3: 核心逻辑包建立（9 纯逻辑文件）

**Files:**
- Create: `packages/tianshu-core/package.json`（同 T1 形态；`peerDependencies: { "@langchain/core": "^1.2", "zod": "*" }`）、`tsconfig.json`、`src/index.ts`
- Move: mirror `electron/domains/ai/chat/` 的 `blocks.ts`(实现部分)/`history-truncate.ts`/`tool-output-trim.ts`/`param-merge.ts`/`error-classify.ts`/`context-usage.ts`/`time-context.ts`/`scenario-prompt.ts`/`expert-catalog.ts` → `packages/tianshu-core/src/`（物理移动）
- Modify: 原位置改 re-export 文件（`export * from "@tianshu/core"`——chat.service 等既有 import 零改动）
- Test: 既有 `tests/ai/chat/blocks.test.ts` 等纯逻辑测试**不迁移**（mirror 侧照跑，验证搬家后行为不变）

**Interfaces:**
- Consumes: `@tianshu/protocol`（包内 import 用相对路径 `../tianshu-protocol/src`? **否**——用包名 `@tianshu/protocol`，包 tsconfig `paths` 或 `references` 映射到 sibling 目录 `../tianshu-protocol/src`，构建输出互不污染）
- Produces: `@tianshu/core` 导出全部纯逻辑函数（`parseBlocks/serializeBlocks/blocksToModelMessages/estimateTokens/truncateHistory/trimHistoryToolOutputs/mergeParams/classifyError/computeUsageBreakdown/withTimeBlock/buildScenarioSystem/expert-catalog 导出`）

- [ ] **Step 1: 哨兵+基线**
- [ ] **Step 2: 物理搬移 9 文件**（内容零改动；包内相互 import 改 `./` 相对；对协议包的 import 用包名；`context-usage.ts` 在 server 侧曾做过类型收敛——以 mirror 版为准收编，server 差异 T5 评估）
- [ ] **Step 3: 原位 re-export + mirror 四处 alias 不变（已含 `@tianshu/core`? 本任务补登）**——T1 只登了 protocol，本任务把 `@tianshu/core` 加进同样四处
- [ ] **Step 4: 全量回归**：mirror vitest（含 chat 纯逻辑既有用例）+ typecheck + lint 全绿
- [ ] **Step 5: Commit（mirror）**：`feat(core): @tianshu/core 纯逻辑包建立（9 文件物理搬移+原位 re-export）`

### Task 4: runChatStream 剥出入包

**Files:**
- Create: `packages/tianshu-core/src/run-chat-stream.ts`（自 `electron/domains/ai/chat/chat.service.ts` 剥出 `runChatStream`+`consumeAgentStream`+`appendDelta` 等其私有依赖闭包；以 mirror 实现为准，**服务端 T6 改造版仅参考**）
- Modify: `electron/domains/ai/chat/chat.service.ts`（删被剥函数，改 `import { runChatStream } from "@tianshu/core"`；`ChatStreamOptions/ChatStreamResult` 类型随函数入包并从协议包/chat-contract 引用）
- Modify: `packages/tianshu-core/src/index.ts` 导出
- Test: 既有 `tests/ai/chat/agent-loop.test.ts`（注入 fake model 直测 runChatStream）不迁移照跑

**Interfaces:**
- Produces: `runChatStream(options: ChatStreamOptions): Promise<ChatStreamResult>`（签名不变）；`ChatStreamOptions` 定义入核心包（`onChunk` 回调类型引协议包 ChatStreamChunk；`loadImage` 等注入点保持）
- 注意闭包边界：若 `consumeAgentStream`/`agent-chunk-emitter.ts` 与 chat.service 类成员有耦合（`finalStates`/`toolDefinitions` 传递），一并剥出或以参数注入——以编译通过+既有测试绿为准绳，不扩大重构面

- [ ] **Step 1: 哨兵+基线**；**Step 2: 剥出（先 typecheck 驱动收敛闭包）**；**Step 3: agent-loop 等测试全绿**；**Step 4: 全量回归**；**Step 5: Commit（mirror）**：`feat(core): runChatStream 剥出入包（mirror 实现为准）`

### Task 5: tianshu-server 替换核心包

**Files:**
- Delete: `src/core/chat/` 全部（9 文件副本+run-chat-stream+chat-stream-chunk re-export 一并删；`src/core/provider/model-factory` 与 `src/core/tools/` **保留**——双份维持，入 T7 巡检）
- Modify: `src/core/chat/chat-runner.service.ts`（若在此目录则移至 `src/modules/session/` 或 `src/core/`）与全部 `import ... from "src/core/chat/..."` 引用点 → `@tianshu/core`
- Modify: `package.json` + `"@tianshu/core": "file:..."`（sync:core 脚本 T2 已备）

**Interfaces:**
- Consumes: T3/T4 的包（build 后安装）；server 侧 `context-usage` 的类型收敛差异（SkillSummary 等）——若包内类型不兼容，在 server 侧写薄适配层（`src/core/` 下新适配文件），**不改包**（mirror 为准原则）
- Produces: server 无 `src/core/chat/`；chat 语义测试（fake model 流式序列）经包路径全绿

- [ ] **Step 1: 哨兵+基线**；**Step 2: build+sync:core**；**Step 3: 删副本+改 import+（必要时）薄适配层**；**Step 4: server `npm test` 全绿**；**Step 5: Commit（server）**：`refactor(core): 接入 @tianshu/core——删 src/core/chat 副本`

### Task 6: 语义对齐（server 侧两处+workspace 裁决落地）

**Files:**
- Modify: `src/modules/session/session.repository.ts`（query 排序 `updatedAt` → `lastMessageAt`；keyword `contains` (insensitive) → 与 mirror includes 同语义——SQLite LIKE ASCII 不敏感，mirror 为大小写敏感：改用 Prisma 查询后内存 includes 过滤或 SQL `GLOB`，**以行为对齐 mirror 为准绳**写对应用例）
- Modify: workspace 缺省——先查 mirror `session.repo.ts` createSession 对 workspaceId 缺省的真实行为（不传时挂 null？报错？），server 对齐之；若 server 外键需要非空则初始化默认 workspace（seed），create 不自建
- Test: `test/modules/session.spec.ts` 补三组语义对齐用例（排序/keyword 敏感性/缺省 workspace）

- [ ] **Step 1: 哨兵**；**Step 2: 查 mirror 实现定 workspace 裁决（ledger 记录）**；**Step 3: 写失败用例（按 mirror 语义）**；**Step 4: 实现+server 全绿**；**Step 5: Commit（server）**：`fix(session): 语义对齐 mirror——排序/keyword/缺省 workspace`

### Task 7: 漂移巡检

**Files:**
- Create: `packages/tianshu-core/scripts/check-drift.mjs`（node 脚本）+ `drift-manifest.json`（仍双份文件对清单：server `src/core/tools/*` ↔ mirror `electron/domains/ai/agent/*` 按文件名对；`model-factory` ↔ mirror `provider/` 工厂；schema 业务表段落）
- Modify: mirror `package.json` scripts + `"check:drift": "node packages/tianshu-core/scripts/check-drift.mjs"`（**scripts 条目不算 dependencies，铁律不破**）
- 逻辑：逐对读取、归一化（去注释/空行/import 行路径差异/prettier 引号差异——归一化只做「去 import 行+去注释+去空白」级别）后 diff；不一致打印差异摘要并 exit 1（漂移即警，不自动同步——同步决策归人）

**Interfaces:**
- Produces: `npm run check:drift`——当前应 **exit 0**（现状即基线）或输出已知差异清单（若工具集两端已实质分叉，manifest 中登记 `baselineDiff: true` 并输出差异计数，仍 exit 0——首次运行固化基线）

- [ ] **Step 1: 哨兵**；**Step 2: 写脚本+manifest**；**Step 3: 跑通并固化基线（输出存档到 ledger）**；**Step 4: Commit（mirror）**：`feat(core): 双仓漂移巡检脚本+基线 manifest`

### Task 8: 收尾——README/E2E/终审

**Files:**
- Modify: mirror `README`/CLAUDE.md（packages 说明+check:drift 一行）；server `README.md`（删「移植来源」表中已收编 9+协议行改为指向 `@tianshu/*` 包；开发流 sync:core 说明）
- Run: `npm run test:e2e:server`（mirror，直连链路真模型；relay 链路环境可用则一并）
- 终审：controller 派 final reviewer（diff 范围 = 两仓本计划全部提交），修复轮按 SDD 规程

- [ ] **Step 1: 文档更新**；**Step 2: E2E 冒烟（E2E_MODEL_* 未配置则 SKIP 并如实记录）**；**Step 3: final review 派发与修复轮**；**Step 4: 双仓收尾 Commit**

---

## Self-Review 结论

- Spec 覆盖：§2 结构（T1-T5）、§3 差异表（T3/T4/T5 逐行对应）、§4 语义对齐（T6）、§5 巡检（T7）、§6 阶段一致、§7 假设全部由任务承载（re-export 层 T1/T3、wire 归一 T2、铁律多处 Global Constraints）。
- 类型一致性：`ServerEvent`/`ChatStreamChunk`/`runChatStream` 签名在 T1/T2/T4/T5 间引用一致；包名 `@tianshu/protocol|core` 全文统一。
- 占位符扫描：T4 闭包边界、T6 workspace 裁决留有「查实现后定」的显式查证步骤（非占位符，是带准绳的决策步骤）。
