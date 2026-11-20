# 自动化/工作流固定运行入口与按次追问 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在会话树中为自动化任务和有运行记录的工作流提供固定入口，按执行时间切换独立运行会话，并允许从任一成败运行继续追问且不影响后续自动执行。

**Architecture:** 采用聚合入口而非物理单会话：`automationRun.sessionId` 继续关联每次运行的独立会话，`session` 只新增稳定分组字段；工作流沿用 run trace/graphRunNode，首次追问复用 `ChatPane` 的占位会话 `sessionResolver` 懒建伴随会话。桌面与 server 共用 `@tianshu/core` 的运行归属/摘要纯函数和 `@tianshu/protocol` 的 wire 类型，远程端以 `runSessions` capability 增量启用。

**Tech Stack:** Electron 44、React 19、TypeScript 5.9、React Query、Zustand、Prisma 7/SQLite、NestJS 11、Prisma 6/SQLite+PostgreSQL、Vitest、Jest、react-i18next、Tailwind CSS 4。

**Spec:** `docs/superpowers/specs/2026-11-19-run-session-aggregation-design.md`

## Global Constraints

- 每次运行保持独立上下文；追问只写所选运行的会话，scheduler/runner 不得读取历史运行或人工追问。
- 不合并运行会话，不给 `message` 增加运行字段，不恢复工作流节点消息对落会话。
- `running`/`skipped` 禁止追问，`success`/`failed` 允许；运行删除不得级联删除用户追问。
- 所有新用户可见文案同时加入 `zh-CN` 和 `en-US` 的 `chat` namespace；样式使用主题变量，弹层使用 `border-border/50 rounded-lg shadow-lg`。
- 文件名用 kebab-case，变量/函数用 camelCase；复杂纯函数必须有单测；不得用 `console`/`debugger`。
- server 不使用外键，任务/图/会话/工作空间归属均在 service/repository 查询中校验；业务错误用 `BusinessException` + `ErrorCode`。
- 修改 `packages/*` 后，server 测试前执行根 `npm --prefix packages/tianshu-core run build` 刷新 dist；不要手动 rebuild better-sqlite3。
- 桌面 Prisma 生成文件只经 `npx prisma generate --schema prisma/schema.prisma` 更新；server SQLite/PG 迁移必须成对。
- 保留工作区已有改动，提交只 `git add` 本任务明确列出的文件；提交信息末尾均带 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。
- 测试命令默认在对应 app 目录执行；packages 测试在仓库根执行。

## Review Focus

1. **同一 run 并发首次追问**：必须只产生一个会话；Task 4/8 用两个并发 `ensureRunSession` 调用断言返回同一 id，并由唯一索引兜底。
2. **历史图运行缺少工作空间或 AI 编排会话已删除**：不得静默落到无关空间；Task 4 测 `RUN_WORKSPACE_REQUIRED`，Task 6 测用户显式选择后继续。
3. **保留策略/删任务/删图与追问共存**：run 可删、消息不可丢；Task 2/7 测解除分组后普通会话仍可查。
4. **超大、损坏或缺字段的 graphTrace**：上下文必须有界且错误/最终输出优先；Task 4 用 16,000 字符上限和畸形 JSON 用例固定行为。
5. **查看历史运行时新运行完成**：不得抢走显式选择；Task 6 测 URL 有 `run` 时保持原运行，缺省 `run` 才跟随最新。
6. **旧远程主机无新端点**：不得发请求或破坏原会话树；Task 9 测无 `runSessions` capability 时固定入口查询和补建均不调用。

---

### Task 1: 共享运行归属规则与 wire 契约

**Files:**
- Modify: `packages/tianshu-protocol/src/graph-contract.ts`
- Create: `packages/tianshu-core/src/run-session.ts`
- Create: `packages/tianshu-core/src/run-session.test.ts`
- Modify: `packages/tianshu-core/src/index.ts`

**Interfaces:**
- Produces: `RunOwner = { kind: "task" | "graph"; ownerId: number }`、`runOwnerOf(run)`、`canFollowUpRun(status)`、`RunGroupRecord`、`AutomationRunDetail`、`RunSessionResult`。
- `AutomationRunRecord` 增加可选 `workspaceId?: number`；`AutomationRunDetail` 额外含 `graphTrace?: string`。
- `RunSessionResult = { runId: number; sessionId: number; created: boolean }`，供本地/远程首次追问共用。

- [ ] **Step 1: Write the failing tests**

在 `run-session.test.ts` 覆盖归属优先级、无归属和状态门禁：

```ts
expect(runOwnerOf({ taskId: 7, graphId: 3 })).toEqual({ kind: "task", ownerId: 7 });
expect(runOwnerOf({ taskId: null, graphId: 3 })).toEqual({ kind: "graph", ownerId: 3 });
expect(runOwnerOf({ taskId: null })).toBeNull();
expect(canFollowUpRun("success")).toBe(true);
expect(canFollowUpRun("failed")).toBe(true);
expect(canFollowUpRun("running")).toBe(false);
expect(canFollowUpRun("skipped")).toBe(false);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:packages -- packages/tianshu-core/src/run-session.test.ts`  
Expected: FAIL，模块 `run-session` 尚不存在。

- [ ] **Step 3: Implement the shared types and pure functions**

`runOwnerOf` 只接收 `{ taskId: number | null; graphId?: number }`，任务归属优先；`canFollowUpRun` 只接受 `AutomationRunStatus`。在协议包定义上述记录类型，不把 `graphTrace` 加回列表页 `AutomationRunRecord`，只放在单 run 详情中。

- [ ] **Step 4: Run tests and package builds**

Run: `npm run test:packages -- packages/tianshu-core/src/run-session.test.ts && npm --prefix packages/tianshu-core run build`  
Expected: 测试 PASS，两个共享包 dist 构建成功。

- [ ] **Step 5: Commit**

```bash
git add packages/tianshu-protocol/src/graph-contract.ts packages/tianshu-core/src/run-session.ts packages/tianshu-core/src/run-session.test.ts packages/tianshu-core/src/index.ts
git commit -m "feat(core): 增加运行会话归属规则与契约" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 2: 桌面持久化、历史回填与删除生命周期

**Files:**
- Modify: `apps/tianshu-desktop/prisma/schema.prisma`
- Modify: `apps/tianshu-desktop/electron/infrastructure/script/v1/upgrade-table.sql`
- Modify: `apps/tianshu-desktop/electron/generated/prisma/**`（仅生成）
- Create: `apps/tianshu-desktop/electron/domains/ai/automation/run-session-owner.ts`
- Modify: `apps/tianshu-desktop/electron/commons/prisma-client.ts`
- Modify: `apps/tianshu-desktop/electron/domains/ai/automation/automation-runner.ts`
- Modify: `apps/tianshu-desktop/electron/domains/ai/automation/automation.repo.ts`
- Modify: `apps/tianshu-desktop/electron/domains/ai/automation/automation-retention.ts`
- Modify: `apps/tianshu-desktop/electron/domains/ai/orchestration/graph-executor.ts`
- Modify: `apps/tianshu-desktop/electron/domains/ai/orchestration/graph.repo.ts`
- Modify: `apps/tianshu-desktop/electron/domains/ai/chat/session.repo.ts`
- Test: `apps/tianshu-desktop/tests/ai/run-session-owner.test.ts`
- Test: `apps/tianshu-desktop/tests/ai/automation-runner.test.ts`
- Test: `apps/tianshu-desktop/tests/ai/automation-retention.test.ts`
- Test: `apps/tianshu-desktop/tests/ai/automation-repo.test.ts`

**Interfaces:**
- `session` 新增 `automationTaskId: number | null`、`runGraphId: number | null`；`automationRun` 新增 `workspaceId: number | null`，`sessionId` 唯一。
- Produces: `clearRunSessionOwners(db, runIds): Promise<void>`、`backfillRunSessionOwners(db): Promise<void>`。
- `SessionRecord` 透出 `automationTaskId`、`runGraphId` 和派生 `automationRunId`；普通会话三者均为空。

- [ ] **Step 1: Write the failing persistence tests**

至少固定以下断言：prompt runner 建会话写任务 id；graph `createRunRow` 写实际 workspace；回填只处理仍存在的 run；清理 run 归属时只清两个分组列，不删 session/message；删任务/删图复用同一清理函数；旧 run 已删的会话不被标题猜测归组。

```ts
expect(session.automationTaskId).toBe(11);
expect(run.workspaceId).toBe(23);
expect(await db.message.count({ where: { sessionId: 9 } })).toBe(2);
expect(afterClear).toMatchObject({ automationTaskId: null, runGraphId: null });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/ai/run-session-owner.test.ts tests/ai/automation-runner.test.ts tests/ai/automation-retention.test.ts tests/ai/automation-repo.test.ts`  
Expected: FAIL，新字段/清理函数尚不存在。

- [ ] **Step 3: Implement schema, writes, backfill, and lifecycle cleanup**

在 v1 快照和 Prisma schema 同步加列/索引；`createRunningRun` 写 `task.workspaceId`，`createSession(task)` 写 `automationTaskId`，`createRunRow` 写 `params.workspace.id`。`backfillRunSessionOwners` 接收 db 接口、由 `prisma-client` 在启动迁移完成后幂等调用，避免反向导入全局 Prisma。

所有 run 删除路径先收集 runIds，再在同一事务中清分组并删 run；保留 `deleteSession` 现有置空 `run.sessionId` 行为。`SessionRepository.createSessionRow` 接受并写两个可选分组字段；`toSession(row, automationRunId?)` 保持同步纯转换，列表/详情查询批量预取 run 映射后传入，禁止逐行反查造成 N+1。

- [ ] **Step 4: Generate Prisma client and run tests**

Run: `npx prisma generate --schema prisma/schema.prisma && npx vitest run tests/ai/run-session-owner.test.ts tests/ai/automation-runner.test.ts tests/ai/automation-retention.test.ts tests/ai/automation-repo.test.ts tests/project/task-session.test.ts`  
Expected: 全部 PASS，普通项目会话字段和行为不变。

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-desktop/prisma/schema.prisma apps/tianshu-desktop/electron/infrastructure/script/v1/upgrade-table.sql apps/tianshu-desktop/electron/generated/prisma apps/tianshu-desktop/electron/domains/ai/automation apps/tianshu-desktop/electron/domains/ai/orchestration/graph-executor.ts apps/tianshu-desktop/electron/domains/ai/orchestration/graph.repo.ts apps/tianshu-desktop/electron/domains/ai/chat/session.repo.ts apps/tianshu-desktop/electron/commons/prisma-client.ts apps/tianshu-desktop/tests/ai/run-session-owner.test.ts apps/tianshu-desktop/tests/ai/automation-runner.test.ts apps/tianshu-desktop/tests/ai/automation-retention.test.ts apps/tianshu-desktop/tests/ai/automation-repo.test.ts
git commit -m "feat(desktop): 持久化运行会话归属与生命周期" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 3: 桌面固定分组与单运行查询 API

**Files:**
- Create: `apps/tianshu-desktop/electron/domains/ai/automation/run-session.service.ts`
- Modify: `apps/tianshu-desktop/electron/domains/ai/automation/automation.repo.ts`
- Modify: `apps/tianshu-desktop/electron/commons/ipc-channels.ts`
- Modify: `apps/tianshu-desktop/electron/Application.ts`
- Modify: `apps/tianshu-desktop/src-react/domains/ai/automation/api/automation.api.ts`
- Test: `apps/tianshu-desktop/tests/ai/run-session-service.test.ts`

**Interfaces:**
- Produces: `RunSessionService.listRunGroups(userId): Promise<RunGroupRecord[]>`、`getRun(runId, userId): Promise<AutomationRunDetail>`。
- IPC：`automation:runGroups`、`automation:run:get`。
- Renderer：`AutomationApi.runGroups()`、`AutomationApi.runById(runId)`；本任务只接本地 `invoke`，远程在 Task 9 接入。

- [ ] **Step 1: Write the failing query tests**

固定：所有现存任务都有组；图组只含顶层 run 或有 `runGraphId` 会话的图；graph 任务运行不重复进图组；非本人 run 返回与不存在相同的 `RUN_NOT_FOUND`；`getRun` 能读取非第一页 run 且保留 `graphTrace`。

```ts
expect(groups).toContainEqual(expect.objectContaining({ kind: "task", ownerId: 1, hasRuns: false }));
expect(groups.filter((g) => g.kind === "graph")).toHaveLength(1);
await expect(service.getRun(999, otherUserId)).rejects.toThrow("RUN_NOT_FOUND");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ai/run-session-service.test.ts`  
Expected: FAIL，`RunSessionService` 尚不存在。

- [ ] **Step 3: Implement the read service and IPC**

查询任务、图、顶层 run 和分组会话后按 Task 1 规则组装；每组只取 `latestRun`，不读全部 trace。`getRun` 通过 taskId 或 graphId 校验当前用户，返回完整单 run。服务构造时注册 IPC，在 `Application.ts` 用既有 `sessionRepo` 构造一个实例，供 Task 4 扩展，不重复实例化。

- [ ] **Step 4: Run service and existing run-history tests**

Run: `npx vitest run tests/ai/run-session-service.test.ts tests/ai/automation-repo.test.ts tests/ai/run-history-panel.test.tsx`  
Expected: 全部 PASS，原分页/归属语义不变。

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-desktop/electron/domains/ai/automation/run-session.service.ts apps/tianshu-desktop/electron/domains/ai/automation/automation.repo.ts apps/tianshu-desktop/electron/commons/ipc-channels.ts apps/tianshu-desktop/electron/Application.ts apps/tianshu-desktop/src-react/domains/ai/automation/api/automation.api.ts apps/tianshu-desktop/tests/ai/run-session-service.test.ts
git commit -m "feat(desktop): 增加运行分组与单运行查询" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 4: 桌面懒建伴随会话与有界追问上下文

**Files:**
- Create: `packages/tianshu-core/src/run-session-context.ts`
- Create: `packages/tianshu-core/src/run-session-context.test.ts`
- Modify: `packages/tianshu-core/src/index.ts`
- Modify: `apps/tianshu-desktop/electron/domains/ai/automation/run-session.service.ts`
- Modify: `apps/tianshu-desktop/electron/domains/ai/chat/session.repo.ts`
- Modify: `apps/tianshu-desktop/electron/domains/ai/chat/chat.service.ts`
- Modify: `apps/tianshu-desktop/src-react/domains/ai/automation/api/automation.api.ts`
- Modify: `apps/tianshu-desktop/src-react/domains/ai/api/session.api.ts`
- Test: `apps/tianshu-desktop/tests/ai/run-followup-service.test.ts`
- Test: `apps/tianshu-desktop/tests/ai/run-followup-context.test.ts`

**Interfaces:**
- Produces: `buildRunFollowupContext(run: AutomationRunDetail, maxChars?: number): string`，默认总上限 **16,000 字符**。
- Produces: `RunSessionService.ensureRunSession(runId, userId, workspaceId?): Promise<RunSessionResult>`。
- IPC/API：`automation:run:ensureSession`、`AutomationApi.ensureRunSession(runId, workspaceId?)`。
- 历史图运行无法确定空间时抛 `RUN_WORKSPACE_REQUIRED`；其他非法状态抛 `RUN_NOT_FOLLOWABLE`。

- [ ] **Step 1: Write failing context and concurrency tests**

上下文测试包含：超过 16,000 字符时截断且保留最终输出/失败节点；坏 JSON 和缺字段不抛；prompt run 不重复拼完整消息。服务测试包含：已有 session 直接返回；两个并发补建返回同一 id；失败 prompt run 可补建；running/skipped 拒绝；历史图运行缺空间必须报 `RUN_WORKSPACE_REQUIRED`。

```ts
expect(context.length).toBeLessThanOrEqual(16000);
expect(context).toContain("final-output");
expect(context).toContain("failed-node");
const [a, b] = await Promise.all([ensure(), ensure()]);
expect(a.sessionId).toBe(b.sessionId);
expect(await prisma.session.count()).toBe(1);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:packages -- packages/tianshu-core/src/run-session-context.test.ts`（仓库根）及 `npx vitest run tests/ai/run-followup-service.test.ts tests/ai/run-followup-context.test.ts`（桌面目录）。  
Expected: FAIL，构建器与补建方法尚不存在。

- [ ] **Step 3: Implement bounded context and idempotent session creation**

共享构建器只读单 run，确定性保留元信息、错误、最终输出和受限 graph 节点摘要。`ensureRunSession` 按 Task 1 状态门禁和 Task 3 归属校验执行；空间顺序为任务空间 → run.workspaceId → graph.aiSessionId 的空间 → 显式 workspaceId。复用 `SessionRepository.createSession` 写项目/分组/标题，再以事务占住 `run.sessionId`；唯一冲突重读胜者。

`ChatService.assembleContext` 发现 sessionId 被 run 引用时合并该固定摘要，仅在用户聊天发送链生效，不改 automation runner/graph executor。

- [ ] **Step 4: Build shared package and run tests**

Run: 根 `npm --prefix packages/tianshu-core run build`，桌面 `npx vitest run tests/ai/run-followup-service.test.ts tests/ai/run-followup-context.test.ts tests/ai/run-session-service.test.ts tests/ai/automation-runner.test.ts`。  
Expected: 全部 PASS，runner 测试证明后续执行 prompt 未变化。

- [ ] **Step 5: Commit**

```bash
git add packages/tianshu-core/src/run-session-context.ts packages/tianshu-core/src/run-session-context.test.ts packages/tianshu-core/src/index.ts apps/tianshu-desktop/electron/domains/ai/automation/run-session.service.ts apps/tianshu-desktop/electron/domains/ai/chat/session.repo.ts apps/tianshu-desktop/electron/domains/ai/chat/chat.service.ts apps/tianshu-desktop/src-react/domains/ai/automation/api/automation.api.ts apps/tianshu-desktop/src-react/domains/ai/api/session.api.ts apps/tianshu-desktop/tests/ai/run-followup-service.test.ts apps/tianshu-desktop/tests/ai/run-followup-context.test.ts
git commit -m "feat(desktop): 支持按运行懒建伴随会话与追问" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 5: 会话树固定入口与统一深链

**Files:**
- Create: `apps/tianshu-desktop/src-react/domains/ai/automation/lib/run-session-route.ts`
- Create: `apps/tianshu-desktop/src-react/domains/ai/automation/lib/run-group-view.ts`
- Create: `apps/tianshu-desktop/src-react/domains/ai/layout/components/RunSessionGroup.tsx`
- Modify: `apps/tianshu-desktop/src-react/domains/ai/layout/components/SessionTreePanel.tsx`
- Modify: `apps/tianshu-desktop/src-react/domains/ai/layout/components/GlobalSearchDialog.tsx`
- Modify: `apps/tianshu-desktop/src-react/domains/ai/automation/components/RunHistoryPanel.tsx`
- Modify: `apps/tianshu-desktop/src-react/domains/ai/automation/views/RunHistoryView.tsx`
- Modify: `apps/tianshu-desktop/src-react/domains/ai/data-source/host.store.ts`
- Modify: `apps/tianshu-desktop/src-react/i18n/locales/zh-CN/chat.json`
- Modify: `apps/tianshu-desktop/src-react/i18n/locales/en-US/chat.json`
- Test: `apps/tianshu-desktop/tests/ai/run-session-route.test.ts`
- Test: `apps/tianshu-desktop/tests/ai/session-tree-panel.test.tsx`
- Test: `apps/tianshu-desktop/tests/ai/run-history-panel.test.tsx`

**Interfaces:**
- Produces: `runSessionPath(owner: RunOwner, runId?: number): string`。
- Produces: `canonicalRunSessionPath(session: SessionRecord): string | null`，依赖 Task 2 的 `automationRunId` 和两个分组列。
- `HostCaps` 新增 `runSessions: boolean`：本地恒 true；本任务远程恒 false，Task 9 才按 capability 开启。

- [ ] **Step 1: Write failing route and sidebar tests**

固定 URL、去重和旧入口：任务/图路径与 spec 完全一致；有关联会话转固定路径，普通会话返回 null；固定组只显示一次且隐藏被归组会话；固定行没有普通重命名/归档按钮；运行历史点击跳 `automation` 或 `graphRun` + `run`，不再只跳 session。

```ts
expect(runSessionPath({ kind: "task", ownerId: 4 }, 9)).toBe("/module/ai?automation=4&run=9");
expect(runSessionPath({ kind: "graph", ownerId: 3 })).toBe("/module/ai?graphRun=3");
expect(screen.getAllByText("daily-report")).toHaveLength(1);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/ai/run-session-route.test.ts tests/ai/session-tree-panel.test.tsx tests/ai/run-history-panel.test.tsx`  
Expected: FAIL，固定组和新路径尚未实现。

- [ ] **Step 3: Implement fixed entries and canonical navigation**

`RunSessionGroup` 负责标题/图标/最近状态/折叠和受限菜单；菜单明确提供「打开任务/工作流」「立即运行」（仅任务）和「查看运行历史」，不提供普通会话写操作。父组件仅在 `caps.runSessions` 时查询 `["automation", "runGroups"]`。`run-group-view.ts` 负责排序与从普通列表排除归组会话；无运行任务显示空态入口，图组由后端数据决定。

全局搜索和两类运行历史统一调用 canonical helper。保持普通空间/项目组、批量管理、归档逻辑不变；远程无能力时不发 `runGroups` 请求。

- [ ] **Step 4: Run sidebar, search, and history tests**

Run: `npx vitest run tests/ai/run-session-route.test.ts tests/ai/session-tree-panel.test.tsx tests/ai/run-history-panel.test.tsx tests/ai/session-search-keybinding.test.tsx tests/layout/global-sidebar.test.tsx`  
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-desktop/src-react/domains/ai/automation/lib/run-session-route.ts apps/tianshu-desktop/src-react/domains/ai/automation/lib/run-group-view.ts apps/tianshu-desktop/src-react/domains/ai/layout/components/RunSessionGroup.tsx apps/tianshu-desktop/src-react/domains/ai/layout/components/SessionTreePanel.tsx apps/tianshu-desktop/src-react/domains/ai/layout/components/GlobalSearchDialog.tsx apps/tianshu-desktop/src-react/domains/ai/automation/components/RunHistoryPanel.tsx apps/tianshu-desktop/src-react/domains/ai/automation/views/RunHistoryView.tsx apps/tianshu-desktop/src-react/domains/ai/data-source/host.store.ts apps/tianshu-desktop/src-react/i18n/locales/zh-CN/chat.json apps/tianshu-desktop/src-react/i18n/locales/en-US/chat.json apps/tianshu-desktop/tests/ai/run-session-route.test.ts apps/tianshu-desktop/tests/ai/session-tree-panel.test.tsx apps/tianshu-desktop/tests/ai/run-history-panel.test.tsx
git commit -m "feat(desktop): 会话树聚合自动化与工作流运行" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 6: 运行选择器、结果视图与首次追问 UI

**Files:**
- Create: `apps/tianshu-desktop/src-react/domains/ai/automation/components/RunSelector.tsx`
- Create: `apps/tianshu-desktop/src-react/domains/ai/automation/components/RunWorkspaceDialog.tsx`
- Create: `apps/tianshu-desktop/src-react/domains/ai/automation/views/RunSessionView.tsx`
- Create: `apps/tianshu-desktop/src-react/domains/ai/chat/hooks/use-session-pane-data.ts`
- Modify: `apps/tianshu-desktop/src-react/domains/ai/chat/views/ChatView.tsx`
- Modify: `apps/tianshu-desktop/src-react/i18n/locales/zh-CN/chat.json`
- Modify: `apps/tianshu-desktop/src-react/i18n/locales/en-US/chat.json`
- Test: `apps/tianshu-desktop/tests/ai/run-session-view.test.tsx`
- Test: `apps/tianshu-desktop/tests/ai/chat-view-project-session.test.tsx`

**Interfaces:**
- Consumes: Task 3 `runById`、Task 4 `ensureRunSession`、Task 5 路由 helper。
- `RunSessionView` 复用 `ChatPane` 现有 `sessionResolver`/负 id 占位会话：首次发送时 ensure → `SessionApi.getById` → 返回 `SessionResolverResult`，不另写输入组件。
- `use-session-pane-data` 向普通 ChatView 与 RunSessionView 提供 models/workspaces/workspace/hasModel，避免复制模型可用性规则。

- [ ] **Step 1: Write failing run-view tests**

覆盖：缺省 run 跟随最新；显式 run 在新运行完成后不变；时间选择器切 URL；prompt run 显示原会话；graph run 显示 `GraphRunTraceView`；首次发送只 ensure 一次；`RUN_WORKSPACE_REQUIRED` 打开空间选择；running/skipped 输入禁用；旧 `?session=` 规范化为固定 URL。

```ts
expect(location.search).toContain("automation=4&run=9");
expect(ensureRunSession).toHaveBeenCalledTimes(1);
expect(screen.queryByRole("textbox")).toBeNull(); // skipped
expect(screen.getByText("final-output")).toBeInTheDocument();
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/ai/run-session-view.test.tsx`  
Expected: FAIL，`RunSessionView` 尚不存在。

- [ ] **Step 3: Implement the routed run conversation**

将 `ChatView` 变为轻路由壳：automation/graphRun 参数进 `RunSessionView`，普通会话走原视图；原视图与 run 视图共用 `use-session-pane-data`。旧 session 若 `canonicalRunSessionPath` 非空则 `navigate(..., { replace: true })`。

`RunSelector` 用现有 runs 分页，当前项显示时间/状态，弹层含触发类型/耗时/attempt。`RunSessionView` 单拉完整 run；graph 用现有 trace 组件，prompt/伴随会话用原 `ChatPane key={session.id}`。无会话时构造负 id 占位 `SessionRecord` 并传 `sessionResolver`；工作空间缺失只通过 `RunWorkspaceDialog` 获取用户显式选择。发送中的真实 sessionId 流键保持不变。

- [ ] **Step 4: Run new and regression UI tests**

Run: `npx vitest run tests/ai/run-session-view.test.tsx tests/ai/chat-view-project-session.test.tsx tests/ai/chat-view-edit-optimistic.test.tsx tests/ai/chat-pane-session-resolver.test.tsx tests/ai/graph-run-trace-view.test.tsx`  
Expected: 全部 PASS，普通会话和既有占位会话发送无回归。

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-desktop/src-react/domains/ai/automation/components/RunSelector.tsx apps/tianshu-desktop/src-react/domains/ai/automation/components/RunWorkspaceDialog.tsx apps/tianshu-desktop/src-react/domains/ai/automation/views/RunSessionView.tsx apps/tianshu-desktop/src-react/domains/ai/chat/hooks/use-session-pane-data.ts apps/tianshu-desktop/src-react/domains/ai/chat/views/ChatView.tsx apps/tianshu-desktop/src-react/i18n/locales/zh-CN/chat.json apps/tianshu-desktop/src-react/i18n/locales/en-US/chat.json apps/tianshu-desktop/tests/ai/run-session-view.test.tsx apps/tianshu-desktop/tests/ai/chat-view-project-session.test.tsx
git commit -m "feat(desktop): 支持按执行时间查看并追问运行" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 7: Server 持久化、执行写入与运行查询端点

**Files:**
- Modify: `apps/tianshu-server/prisma/schema.prisma`
- Create: `apps/tianshu-server/prisma/migrations/5_run_session_aggregation/migration.sql`
- Modify: `apps/tianshu-server/prisma/pg/schema.prisma`（派生）
- Create: `apps/tianshu-server/prisma/pg/migrations/5_run_session_aggregation/migration.sql`
- Modify: `apps/tianshu-server/src/modules/automation/automation-runner.ts`
- Modify: `apps/tianshu-server/src/modules/automation/automation.repository.ts`
- Modify: `apps/tianshu-server/src/modules/automation/automation-retention.ts`
- Modify: `apps/tianshu-server/src/modules/graph/graph.repository.ts`
- Modify: `apps/tianshu-server/src/modules/automation/automation.service.ts`
- Modify: `apps/tianshu-server/src/modules/automation/automation.controller.ts`
- Create: `apps/tianshu-server/src/modules/automation/dto/run-session.dto.ts`
- Modify: `apps/tianshu-server/src/modules/session/session.repository.ts`
- Test: `apps/tianshu-server/test/modules/run-session.spec.ts`
- Test: `apps/tianshu-server/test/modules/automation-scheduler.spec.ts`
- Test: `apps/tianshu-server/test/modules/event-stream.spec.ts`

**Interfaces:**
- 与桌面同名列/索引：`sessionRecord.automationTaskId`、`runGraphId`，`automationRun.workspaceId`、`sessionId` 唯一。
- POST `automation/runGroups`、`automation/runById`；出参分别使用 Task 1 `RunGroupRecord[]`、`AutomationRunDetail`。
- `SessionCreateParams` 接受两个可选分组字段，session wire 透出它们及 `automationRunId`。

- [ ] **Step 1: Write failing server schema/query tests**

覆盖 Task 2 的 runner 写入、回填/删除语义和 Task 3 的分组/归属查询；SQLite 测试验证唯一索引，PG 由配对迁移守卫和同构 SQL 覆盖。既有 server 测试若使用完整 session/run 对象，只补可空字段，不断言旧 graph session 恒 null。

```ts
expect(run.workspaceId).toBe(workspace.id);
expect(session.automationTaskId).toBe(task.id);
await expect(service.runById({ runId: otherUsersRun.id })).rejects.toMatchObject({ code: expect.any(String) });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/modules/run-session.spec.ts test/modules/automation-scheduler.spec.ts --runInBand`  
Expected: FAIL，新列/端点尚不存在。

- [ ] **Step 3: Implement paired migrations, execution writes, and endpoints**

SQLite/PG 迁移加相同列与索引并回填仍有 run 的 prompt 会话；`createRun` 增加 `workspaceId` 入参并由调用方传实际空间。删任务/图和 retention 先清会话分组、保留消息。controller 按现有 POST 风格和 Swagger DTO 暴露两组只读端点，service 使用 `COMPANION_USER_ID` 做归属过滤。

- [ ] **Step 4: Generate clients/OpenAPI and run tests**

Run: `npm run prisma:generate && npm run prisma:generate:pg && npm run sdk:generate && npx jest test/modules/run-session.spec.ts test/modules/automation-scheduler.spec.ts test/modules/event-stream.spec.ts test/modules/session-send.spec.ts --runInBand`  
Expected: 全部 PASS，OpenAPI/migration 新鲜度守卫通过。

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-server/prisma apps/tianshu-server/src/modules/automation apps/tianshu-server/src/modules/graph/graph.repository.ts apps/tianshu-server/src/modules/session/session.repository.ts apps/tianshu-server/openapi.json apps/tianshu-server/sdk/api-types.d.ts apps/tianshu-server/test/modules/run-session.spec.ts apps/tianshu-server/test/modules/automation-scheduler.spec.ts apps/tianshu-server/test/modules/event-stream.spec.ts
git commit -m "feat(server): 增加运行会话归属与查询端点" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 8: Server 幂等伴随会话与追问上下文

**Files:**
- Create: `apps/tianshu-server/src/modules/automation/run-session.service.ts`
- Modify: `apps/tianshu-server/src/modules/automation/automation.module.ts`
- Modify: `apps/tianshu-server/src/modules/automation/automation.service.ts`
- Modify: `apps/tianshu-server/src/modules/automation/automation.controller.ts`
- Modify: `apps/tianshu-server/src/modules/automation/dto/run-session.dto.ts`
- Modify: `apps/tianshu-server/src/modules/session/session.module.ts`
- Modify: `apps/tianshu-server/src/core/chat-runner.service.ts`
- Test: `apps/tianshu-server/test/modules/run-followup.spec.ts`
- Test: `apps/tianshu-server/test/core/chat-runner.spec.ts`

**Interfaces:**
- POST `automation/ensureRunSession`，入参 `{ runId: number; workspaceId?: number }`，出参 `RunSessionResult`。
- `SessionModule` 导出既有 `SessionRepository`；`AutomationModule` 导入它，不复制会话创建规则。
- server 复用 Task 4 `@tianshu/core` 的 `buildRunFollowupContext`，不新增第二份 trace 摘要算法。

- [ ] **Step 1: Write failing server follow-up tests**

与桌面保持同一门禁和错误语义：并发只建一个会话、已有会话直接复用、非法状态拒绝、历史图缺空间要求显式选择；ChatRunner 只对 run 关联会话注入摘要，普通会话 system prompt 不变，automation runner 不调用该注入。

```ts
const [a, b] = await Promise.all([service.ensureRunSession(dto), service.ensureRunSession(dto)]);
expect(a.sessionId).toBe(b.sessionId);
expect(assembled.system).toContain("final-output");
expect(ordinary.system).not.toContain("final-output");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/modules/run-followup.spec.ts test/core/chat-runner.spec.ts --runInBand`  
Expected: FAIL，ensure 端点和上下文接线尚不存在。

- [ ] **Step 3: Implement server follow-up creation and context injection**

`run-session.service.ts` 复用 `SessionRepository.create` 和 Prisma 事务，按任务/run/AI 编排会话/显式输入解析空间；唯一冲突重读。controller/service 只作归属与薄转发，错误统一 `BusinessException`。`ChatRunnerService.assembleContext` 查询 run 关联并合并 Task 4 的有界摘要；自动执行链不改。

- [ ] **Step 4: Rebuild shared dist, OpenAPI, and run isolated suites**

Run: 根 `npm --prefix packages/tianshu-core run build`；server `npm run sdk:generate && npx jest test/modules/run-followup.spec.ts test/core/chat-runner.spec.ts test/modules/run-session.spec.ts --runInBand`。  
Expected: 全部 PASS；不利用本机全量 Jest 的既有环境失败作成功依据。

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-server/src/modules/automation apps/tianshu-server/src/modules/session/session.module.ts apps/tianshu-server/src/core/chat-runner.service.ts apps/tianshu-server/openapi.json apps/tianshu-server/sdk/api-types.d.ts apps/tianshu-server/test/modules/run-followup.spec.ts apps/tianshu-server/test/core/chat-runner.spec.ts
git commit -m "feat(server): 支持运行伴随会话与有界追问上下文" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 9: 远程数据源、capability 与事件刷新

**Files:**
- Modify: `packages/tianshu-protocol/src/server-event.ts`
- Modify: `apps/tianshu-desktop/src-react/domains/ai/server/api/graph.api.ts`
- Modify: `apps/tianshu-desktop/src-react/domains/ai/data-source/remote-catalog.ts`
- Modify: `apps/tianshu-desktop/src-react/domains/ai/data-source/remote-session.ts`
- Modify: `apps/tianshu-desktop/src-react/domains/ai/server/api/server.api.ts`
- Modify: `apps/tianshu-desktop/src-react/domains/ai/data-source/host.store.ts`
- Modify: `apps/tianshu-desktop/src-react/domains/ai/automation/api/automation.api.ts`
- Modify: `apps/tianshu-desktop/src-react/lib/query-invalidate-events.ts`
- Modify: `apps/tianshu-desktop/electron/domains/ai/orchestration/graph-executor.ts`
- Test: `apps/tianshu-desktop/tests/ai/automation-route.test.ts`
- Test: `apps/tianshu-desktop/tests/ai/run-session-view.test.tsx`
- Test: `apps/tianshu-desktop/tests/ai/session-tree-panel.test.tsx`
- Create: `apps/tianshu-desktop/tests/ai/query-invalidate-events.test.ts`

**Interfaces:**
- `CAPABILITIES` 新增 `"runSessions"`；`capsOfCapabilities` 仅在数组包含它时设 `runSessions=true`，本地仍恒 true。
- Remote adapters：`remoteAutomationRunGroups(connId)`、`remoteAutomationRunById(runId, connId)`、`remoteAutomationEnsureRunSession(runId, workspaceId, connId)`。
- 三个 renderer API 改为 `routeInvoke`；旧主机不会进入这些调用。

- [ ] **Step 1: Write failing capability and adapter tests**

固定：无 capability 时 runGroups 查询 disabled 且 ensure 不调用；有 capability 时走对应 remote 端点并保留 graphTrace/workspaceId；远程 session 映射保留两个分组列和 automationRunId；本地仍走原 IPC；automation.changed、graph.run.updated、session.updated 会失效 runGroups、run 详情和 sessions，但显式 run URL 不变。

```ts
expect(capsOfCapabilities(["graph"]).runSessions).toBe(false);
expect(capsOfCapabilities(["graph", "runSessions"]).runSessions).toBe(true);
expect(remoteAutomationRunGroups).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/ai/automation-route.test.ts tests/ai/run-session-view.test.tsx tests/ai/session-tree-panel.test.tsx`  
Expected: FAIL，远程适配和 capability 门控尚不存在。

- [ ] **Step 3: Implement remote routing and cache invalidation**

在 `graph.api.ts` 增加对应 HTTP 方法，`remote-catalog.ts` 做 wire→desktop 形状转换，`remote-session.ts`/`server.api.ts` 同步映射新增会话字段，`AutomationApi` 用 `routeInvoke`。全局事件桥在 automation.changed、graph.run.updated、session.updated 时失效 `["automation", "runGroups"]`、`["automation", "run"]` 和 `["sessions"]`；本地 graph executor 收尾也 `emitAutomationChanged(params.task?.id ?? 0)`，不把当前显式 run 改成 latest。

- [ ] **Step 4: Build protocol/core and run route/UI tests**

Run: 根 `npm --prefix packages/tianshu-core run build`；桌面 `npx vitest run tests/ai/automation-route.test.ts tests/ai/run-session-view.test.tsx tests/ai/session-tree-panel.test.tsx tests/ai/query-invalidate-events.test.ts tests/ai/server/connections.test.ts`。  
Expected: 全部 PASS，旧能力主机无新增请求，本地/远程运行完成均触发刷新。

- [ ] **Step 5: Commit**

```bash
git add packages/tianshu-protocol/src/server-event.ts apps/tianshu-desktop/src-react/domains/ai/server/api/graph.api.ts apps/tianshu-desktop/src-react/domains/ai/server/api/server.api.ts apps/tianshu-desktop/src-react/domains/ai/data-source/remote-catalog.ts apps/tianshu-desktop/src-react/domains/ai/data-source/remote-session.ts apps/tianshu-desktop/src-react/domains/ai/data-source/host.store.ts apps/tianshu-desktop/src-react/domains/ai/automation/api/automation.api.ts apps/tianshu-desktop/src-react/lib/query-invalidate-events.ts apps/tianshu-desktop/electron/domains/ai/orchestration/graph-executor.ts apps/tianshu-desktop/tests/ai/automation-route.test.ts apps/tianshu-desktop/tests/ai/run-session-view.test.tsx apps/tianshu-desktop/tests/ai/session-tree-panel.test.tsx apps/tianshu-desktop/tests/ai/query-invalidate-events.test.ts
git commit -m "feat(desktop): 接通远程运行会话与能力降级" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 10: 端到端验收、文档与全量验证

**Files:**
- Create: `apps/tianshu-desktop/tests/ai/run-session-e2e.test.tsx`
- Modify: `docs/design/automation-scheduled-tasks.md`
- Modify: `docs/design/workflow-graphs.md`
- Modify: `docs/user-manual.md`

**Interfaces:**
- 验收链：三次独立运行 → 单固定入口 → 历史运行追问 → 第四次运行不携带追问。
- 文档只描述已实现行为，保留 graph 去会话化和运行历史的审计定位。

- [ ] **Step 1: Write the failing end-to-end integration test**

用真实 run/session reducer 与 mocked transport 串起四次运行：前三次各有独立 sessionId；树中一个条目；第一次追问写回第一次 session；第四次 runner 输入只含原始 prompt，不含第一次追问文本。另测 retention 后追问消息仍存在且转普通会话。

- [ ] **Step 2: Run the integration test to verify current gaps**

Run: `npx vitest run tests/ai/run-session-e2e.test.tsx`  
Expected: 若前九任务完整则直接 PASS；若 FAIL，只修 spec 内缺口，不放宽断言。

- [ ] **Step 3: Update durable documentation**

在自动化设计文档记录固定聚合入口、两个 session 分组列、run.workspaceId、伴随会话与保留策略；在工作流文档明确 trace 仍是权威结果、追问不等于重跑；用户手册增加时间切换和追问操作。

- [ ] **Step 4: Run full verification**

Run（仓库根）：

```bash
npm run test:packages
npm run typecheck
npm run lint
npm run test
npm run check:drift
npm run test:e2e:server
npm run test:e2e:graph
```

Run（`apps/tianshu-server`，隔离相关套件）：`npx jest test/modules/run-session.spec.ts test/modules/run-followup.spec.ts test/core/chat-runner.spec.ts test/modules/automation-scheduler.spec.ts test/modules/session-send.spec.ts test/modules/graph-api.spec.ts --runInBand`。  
Expected: 命令退出码 0。若遇到已知基线失败，必须用隔离跑和 `git stash` 对照证明非本特性回归，并在交付中如实列出，不能宣称全绿。

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-desktop/tests/ai/run-session-e2e.test.tsx docs/design/automation-scheduled-tasks.md docs/design/workflow-graphs.md docs/user-manual.md
git commit -m "docs: 补充固定运行入口与按次追问说明" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
