# 自动化与工作流固定入口执行体验 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 固定会话入口改为右侧运行看板切换历史运行，工作流执行详情提供拓扑/步骤双视图与节点大弹框检查器。

**Architecture:** 复用现有 `GraphCanvas` 增加只读运行模式与节点运行态叠加；新增运行看板、双视图容器、节点弹框三个固定入口专用组件；单运行详情 wire 补 `graphJsonSnapshot`（列表继续省略）；追问草稿经 ChatPane 既有 `initialDraft`/`onDraftUnmount` 通道按 runId 外置。

**Tech Stack:** React 19、React Router 7、React Query、@xyflow/react、shadcn/ui Dialog/Tabs、Vitest。

**Spec:** `docs/superpowers/specs/2026-11-23-run-detail-experience-design.md`

## Global Constraints

- 仅改左侧固定会话入口；`GraphRunHistoryDialog` 与编辑器行为零变化。
- 不改 Prisma schema、v1 快照 SQL、`DATABASE_VERSION`、迁移；不得触发快照重置。
- 不改调度、补跑、重试、权限、retention、删除与追问上下文语义；`graphTrace`/`graphRunNode` 仍是权威结果。
- 旧远程主机（无 `runSessions`）零新增端点请求；生产 capability 常量不变。
- 列表/分组 wire 继续省略 `graphJsonSnapshot` 与完整 trace；仅单运行详情返回。
- 新用户文案同时加入 `zh-CN`/`en-US` 的 `chat` namespace；弹框/弹出层用 `border-border/50 rounded-lg shadow-lg`；禁硬编码主题色。
- 文件名 kebab-case；函数名 camelCase；生产代码禁 `console`/`debugger`；提交末尾带 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。
- 禁 bare/shared `git stash`；禁手动 rebuild better-sqlite3；不改 tracked Nest build 配置（OpenAPI 用既有临时 no-assets 流程）。
- 执行必须在从当前 main（`8a66ec8c`）新建的隔离 worktree 进行，不得在主工作区（有未提交改动）直接实施；桌面/`packages` 测试命令在对应目录跑，`packages` 源码改动后先 `npm --prefix packages/tianshu-core run build`。

## Review Focus

1. **快照缺失/损坏的老 run**：拓扑不可渲染时必须保留步骤视图并给出轻量提示，运行结果不消失。→ Task 4「snapshot 损坏降级」测试。
2. **同节点多次 occurrence**：拓扑显示末次状态；弹框可逐次切换；非末次明确回落 trace 预览，不冒充全文。→ Task 3「nodeRunStates 末次」+ Task 5「非末次回落」测试。
3. **显式 run 不在当前分页**：看板置顶「当前选择」条目，不丢选中、不重复显示。→ Task 2「置顶当前选择」测试。
4. **切运行与草稿**：草稿按 runId 恢复且绝不跨 run 泄漏。→ Task 6「草稿按 run 恢复/隔离」测试。
5. **旧远程主机**：无 `runSessions` 能力时看板与详情零请求，普通会话树不受影响。→ Task 2「旧主机零调用」测试。
6. **失败 run 自动定位**：失败运行默认聚焦首个失败 occurrence 节点。→ Task 3「首个失败聚焦」测试。

---

### Task 1: 单运行详情 wire 补 graphJsonSnapshot

**Files:**
- Modify: `packages/tianshu-protocol/src/graph-contract.ts`（`AutomationRunDetail`）
- Modify: `apps/tianshu-desktop/electron/domains/ai/automation/automation.repo.ts:185-208`（`toRunRecord`）
- Modify: `apps/tianshu-desktop/electron/domains/ai/automation/run-session.service.ts:207-211`（`getRun`）
- Modify: `apps/tianshu-server/src/modules/automation/automation.repository.ts`（`toRunRecord`/`findRunById`）
- Modify: `apps/tianshu-server/src/modules/automation/dto/automation-run-record.dto.ts`
- Test: `apps/tianshu-desktop/tests/ai/run-session-service.test.ts`、`apps/tianshu-server/test/modules/run-session.spec.ts`、`apps/tianshu-desktop/tests/ai/server/connections.test.ts`

**Interfaces:**
- Produces: `AutomationRunDetail.graphJsonSnapshot?: string | null`；桌面 `toRunRecord(row, taskName, includeGraphTrace = true, includeSnapshot = false)`；仅 `getRun` 传第四参 `true`。

- [ ] **Step 1: 写失败测试**

桌面 `run-session-service.test.ts` 新增两条：`getRun 返回 graphJsonSnapshot`（mock 行含 `graphJsonSnapshot: '{"nodes":[]}'`，断言 `detail.graphJsonSnapshot` 为该串）；`runs 分页不含快照`（对 runs 页查询的 `toRunRecord` 结果断言 `graphJsonSnapshot` 为 undefined）。server `run-session.spec.ts` 新增：`runById 返回 graphJsonSnapshot`（库行含快照，断言详情含原串）；既有 `latestRun 不含 graphJsonSnapshot` 断言保持。`connections.test.ts` 远程 runById 用例的 mock 响应体加 `graphJsonSnapshot` 字段，断言适配器原样透传。

- [ ] **Step 2: 跑 RED**

Run（`apps/tianshu-server`）：`npx jest test/modules/run-session.spec.ts --runInBand -t "graphJsonSnapshot"`
Run（`apps/tianshu-desktop`）：`npx vitest run tests/ai/run-session-service.test.ts tests/ai/server/connections.test.ts`
Expected: 新断言 FAIL（字段 undefined），既有用例不受影响。

- [ ] **Step 3: 实现**

protocol `AutomationRunDetail` 加 `graphJsonSnapshot?: string | null`。桌面 `toRunRecord` 加第四参 `includeSnapshot = false`，true 时输出 `graphJsonSnapshot: row.graphJsonSnapshot ?? undefined`（`RunRow` 已含该列）；`getRun` 调 `toRunRecord(owned.row, name, true, true)`，其余调用点不动。server `toRunRecord` 加同名末参 `includeSnapshot = false`，true 时输出 `graphJsonSnapshot: row.graphJsonSnapshot ?? null`；仅 `findRunById` 传 true——列表/分组路径（RUN_SUMMARY_SELECT 行）永不产出该键，既有 `latestRun 不含 graphJsonSnapshot` 属性断言保持成立；`automation-run-record.dto.ts` 加 `@ApiPropertyOptional` nullable string 字段。

- [ ] **Step 4: 跑 GREEN + 守卫**

Run（桌面）：`npx vitest run tests/ai/run-session-service.test.ts tests/ai/server/connections.test.ts tests/ai/server/protocol-package.test.ts` → PASS。
Run（server）：先 `npm --prefix packages/tianshu-core run build`，再 `npx jest test/modules/run-session.spec.ts test/sdk-contract.spec.ts --runInBand` → PASS。
OpenAPI/SDK：`node scripts/export-openapi.mjs && npx openapi-typescript openapi.json -o sdk/api-types.d.ts && node scripts/check-openapi-fresh.mjs`（worktree Nest assets 阻塞时用既有临时 no-assets 配置流程，不改 tracked 配置）。
`npm run check:drift`：若仅 automation-repository 因本次差异告警，逐 hunk 复核后单条 rebase 并在报告中记录理由；三个 agent alert 保持不动。

- [ ] **Step 5: Commit**

```bash
git add packages/tianshu-protocol/src/graph-contract.ts apps/tianshu-desktop/electron/domains/ai/automation/automation.repo.ts apps/tianshu-desktop/electron/domains/ai/automation/run-session.service.ts apps/tianshu-server/src/modules/automation/automation.repository.ts apps/tianshu-server/src/modules/automation/dto/automation-run-record.dto.ts apps/tianshu-server/openapi.json apps/tianshu-server/sdk/api-types.d.ts packages/tianshu-core/scripts/drift-manifest.json apps/tianshu-desktop/tests/ai/run-session-service.test.ts apps/tianshu-desktop/tests/ai/server/connections.test.ts apps/tianshu-server/test/modules/run-session.spec.ts
git commit -m "feat: 单运行详情透出图结构快照"
```

---

### Task 2: 右侧运行看板 RunBoard

**Files:**
- Create: `apps/tianshu-desktop/src-react/domains/ai/automation/components/run-board.tsx`
- Modify: `apps/tianshu-desktop/src-react/domains/ai/automation/components/RunSelector.tsx`（删默认下拉组件，保留 `runPageQueryKey`/`queryRunPage`/`RunStatusBadge` 导出）
- Modify: `apps/tianshu-desktop/src-react/domains/ai/automation/views/RunSessionView.tsx`（布局改主列+右板，页头只留 `SessionSearchBox`）
- Modify: `apps/tianshu-desktop/src-react/i18n/locales/{zh-CN,en-US}/chat.json`
- Test: `apps/tianshu-desktop/tests/ai/run-board.test.tsx`（新）、`apps/tianshu-desktop/tests/ai/run-session-view.test.tsx`

**Interfaces:**
- Consumes: `queryRunPage(owner, page): Promise<{ items: AutomationRunRecord[]; total: number }>`（Task 内新增聚合包装）；`runSessionPath(owner, runId?)`；`RunStatusBadge`；`localizeRunError`。
- Produces: `runBoardQueryKey(owner: RunOwner, pages: number)`、`queryRunPages(owner: RunOwner, pages: number): Promise<{ items: AutomationRunRecord[]; total: number }>`（按页序 concat，total 取末页）；`RunBoard({ owner, selectedRunId, currentRun, onSelect }: { owner: RunOwner; selectedRunId?: number; currentRun?: AutomationRunRecord; onSelect: (runId: number) => void })`。

- [ ] **Step 1: 写失败测试**（`run-board.test.tsx`）

用例：① 渲染首页条目（时间倒序、`RunStatusBadge`、`triggerTypeKey`、`formatDuration`、attempt）并高亮 `selectedRunId` 命中项（`aria-current="true"`）；② 点击条目回调 `onSelect(run.id)`；③ `selectedRunId=9` 不在首页时顶部出现置顶「当前选择」条目（用 `currentRun` 数据），点击同样回调；9 出现在条目列表时不重复渲染；④ 失败条目显示 `localizeRunError` 截断摘要；⑤ 「加载更早记录」点击后 `queryRunPage` 以 page=2 再取并追加，`total` 用尽时按钮禁用；⑥ 收起/展开切换隐藏/恢复列表且选中态保留；⑦ `owner` 变化重置页数。`run-session-view.test.tsx` 改造：页头不再出现下拉触发器；任务与图入口均渲染 RunBoard；旧主机（无 runSessions）断言 0 次 runGroups/runById/ensure 调用且不渲染看板。

- [ ] **Step 2: 跑 RED**

Run（`apps/tianshu-desktop`）：`npx vitest run tests/ai/run-board.test.tsx tests/ai/run-session-view.test.tsx`
Expected: 新用例 FAIL（组件/布局缺失）。

- [ ] **Step 3: 实现**

`run-board.tsx`：容器 `w-72 shrink-0 border-l border-border/50 flex flex-col`；头部标题 + `t("chat:runSession.board.total", { count: total })` + 收起按钮（`PanelRightClose`/`PanelRightOpen`）；列表 `flex-1 overflow-y-auto`；条目按钮含时间/状态徽标/触发/耗时/attempt 与失败摘要（`line-clamp-2 text-xs text-destructive`）；底部「加载更早记录」按钮（`pages < totalPages` 才可用）。`pages` state 随 `owner.kind/ownerId` 重置。RunSessionView 布局改 `flex h-full`：主列 `min-w-0 flex-1`（原内容）+ `runSessionsEnabled && <RunBoard …/>`；`usePageHeader` trailing 仅 `SessionSearchBox`。i18n 两语言加 `runSession.board.title/total/loadMore/collapse/expand/pinned`。

- [ ] **Step 4: 跑 GREEN**

Run：同 Step 2 命令 → 全部 PASS；`npx vitest run tests/ai/run-session-route.test.ts` 回归 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-desktop/src-react/domains/ai/automation/components/run-board.tsx apps/tianshu-desktop/src-react/domains/ai/automation/components/RunSelector.tsx apps/tianshu-desktop/src-react/domains/ai/automation/views/RunSessionView.tsx apps/tianshu-desktop/src-react/i18n/locales/zh-CN/chat.json apps/tianshu-desktop/src-react/i18n/locales/en-US/chat.json apps/tianshu-desktop/tests/ai/run-board.test.tsx apps/tianshu-desktop/tests/ai/run-session-view.test.tsx
git commit -m "feat: 固定入口右侧运行看板"
```

---

### Task 3: GraphCanvas 只读运行模式与运行拓扑包装

**Files:**
- Modify: `apps/tianshu-desktop/src-react/domains/ai/orchestration/components/GraphCanvas.tsx`（`readOnly?: boolean`）
- Modify: `apps/tianshu-desktop/src-react/domains/ai/orchestration/components/nodes/NodeCard.tsx`（`runState?: { status: "success" | "failed" | "skipped"; durationMs: number }`）
- Create: `apps/tianshu-desktop/src-react/domains/ai/automation/components/run-graph-canvas.tsx`
- Test: `apps/tianshu-desktop/tests/ai/run-graph-canvas.test.tsx`（新）、`apps/tianshu-desktop/tests/ai/graph-canvas-readonly.test.tsx`（新）

**Interfaces:**
- Consumes: `toCanvas(graph, layouts)`、`layoutOf(json)`、`END_NODE_ID`（orchestration/lib/graph-canvas-model）；`GraphJson`（orchestration/api/graph.schema）。
- Produces: `nodeRunStates(trace: TraceEntry[]): Map<string, { status: "success" | "failed" | "skipped"; durationMs: number; lastOccurrence: number; occurrences: number }>`（同节点后一 occurrence 覆盖前一，`lastOccurrence` 为 trace 下标）；`firstFailedNodeId(trace: TraceEntry[]): string | null`（首个 failed occurrence 的节点 id）；`RunGraphCanvas({ graphJson, trace, selectedNodeId, onSelectNode }: { graphJson: string; trace: TraceEntry[]; selectedNodeId: string | null; onSelectNode: (id: string | null) => void })`。

- [ ] **Step 1: 写失败测试**

`run-graph-canvas.test.tsx`（纯函数为主）：`nodeRunStates` 同节点两次 trace（先 success 后 failed）→ status=failed、durationMs 取末次、occurrences=2、lastOccurrence=1（同 nodeId 后一 occurrence 覆盖前一）；`firstFailedNodeId` 返回首个 failed 的节点 id，无失败返回 null。组件级：合法快照 `graphJson` 传入后以只读模式渲染（mock `@xyflow/react` 的 `ReactFlow`，断言 `nodesEditable=false`、`edgesConnectable=false`、无 `onConnect` 回调传递）；非法 JSON → 渲染降级提示且不抛错。`graph-canvas-readonly.test.tsx`：`readOnly` 传给 GraphCanvas 后节点 `draggable:false`、`deleteKeyCode:null`、不渲染 `AddNodeMenu`、`onMove/onConnect/onAddNode/onRemoveNode` 不被调用（模拟 change 不外抛）。

- [ ] **Step 2: 跑 RED**

Run（`apps/tianshu-desktop`）：`npx vitest run tests/ai/run-graph-canvas.test.tsx tests/ai/graph-canvas-readonly.test.tsx`
Expected: FAIL（属性/函数不存在）。

- [ ] **Step 3: 实现**

`GraphCanvas` 加 `readOnly?: boolean`：true 时节点 `draggable:false`、`deleteKeyCode={null}`、`nodesConnectable={false}`、`edgesConnectable={false}`、隐藏 `AddNodeMenu`，`handleNodesChange` 不再收集 position、`handleConnect/handleNodesDelete/handleEdgesDelete` 直接返回；保留缩放/MiniMap/点击选择/`focusNodeId` 定位。`NodeCard` 加可选 `runState`：状态描边（success `border-primary`、failed `border-destructive`、skipped `border-border`）+ 右上角小徽标（状态字 + `formatDuration`）。`run-graph-canvas.tsx`：`JSON.parse` 快照 → 结构校验（有 `nodes`/`edges` 数组）→ `layoutOf` → 传 `nodeStates` 给画布；点击节点 `onSelectNode(node.id)`、空白 `onSelectNode(null)`；快照非法渲染 `t("chat:runSession.detail.snapshotMissing")` 提示。

- [ ] **Step 4: 跑 GREEN**

Run：同 Step 2 → PASS；`npx vitest run tests/ai/graph-executor.test.ts tests/ai/orchestration-route.test.ts` 回归 PASS（编辑器零变化）。

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-desktop/src-react/domains/ai/orchestration/components/GraphCanvas.tsx apps/tianshu-desktop/src-react/domains/ai/orchestration/components/nodes/NodeCard.tsx apps/tianshu-desktop/src-react/domains/ai/automation/components/run-graph-canvas.tsx apps/tianshu-desktop/tests/ai/run-graph-canvas.test.tsx apps/tianshu-desktop/tests/ai/graph-canvas-readonly.test.tsx
git commit -m "feat: 图画布只读运行模式与运行状态叠加"
```

---

### Task 4: 步骤日志与双视图容器

**Files:**
- Create: `apps/tianshu-desktop/src-react/domains/ai/automation/components/run-step-log.tsx`
- Create: `apps/tianshu-desktop/src-react/domains/ai/automation/components/graph-run-detail.tsx`
- Modify: `apps/tianshu-desktop/src-react/i18n/locales/{zh-CN,en-US}/chat.json`
- Test: `apps/tianshu-desktop/tests/ai/graph-run-detail.test.tsx`（新）

**Interfaces:**
- Consumes: Task 3 的 `RunGraphCanvas`/`nodeRunStates`/`firstFailedNodeId`；`parseTrace`/`TraceEntry`（orchestration/components/GraphRunTraceView）；`RunStatusBadge`；`formatDateTime/formatDuration/triggerTypeKey`。
- Produces: `RunStepLog({ trace, selectedOccurrence, onSelectOccurrence }: { trace: TraceEntry[]; selectedOccurrence: number | null; onSelectOccurrence: (index: number) => void })`；`GraphRunDetail({ run, trace, selectedOccurrence, onSelectOccurrence }: { run: AutomationRunDetail; trace: TraceEntry[]; selectedOccurrence: number | null; onSelectOccurrence: (index: number) => void })`（视图切换与快照降级内聚，弹框由 Task 5/6 注入渲染）。

- [ ] **Step 1: 写失败测试**（`graph-run-detail.test.tsx`）

用例：① 头部显示状态徽标/开始时间/触发/耗时/attempt；② 默认拓扑视图（快照合法时渲染 RunGraphCanvas 占位 mock），切到「步骤」渲染 RunStepLog；③ 步骤行逐 occurrence 渲染（同节点两条各自成行，带失败 error.code 预览），点击行回调 occurrence 下标；④ 快照非法 JSON → 显示降级提示且自动落在步骤视图，结果摘要区仍可见；⑤ `run.status === "failed"` 且未选择时，`firstFailedNodeId` 作为画布 `focusNodeId`/选中传入；⑥ 视图切换保持 `selectedOccurrence` 不丢。

- [ ] **Step 2: 跑 RED**

Run（`apps/tianshu-desktop`）：`npx vitest run tests/ai/graph-run-detail.test.tsx`
Expected: FAIL（组件缺失）。

- [ ] **Step 3: 实现**

`run-step-log.tsx`：`ol` 紧凑行（序号 + 状态点 + 节点名 + 耗时 + 失败 code），点击整行回调。`graph-run-detail.tsx`：头部行（`RunStatusBadge` + meta + `t("chat:runSession.detail.viewTopology")`/`viewSteps` 切换按钮组）；结果摘要 `<pre>`（沿用现 `GraphRunResult` 的 error/finalOutput 逻辑，迁移进来）；视图区：topology → `RunGraphCanvas`（快照取 `run.graphJsonSnapshot`），steps → `RunStepLog`；快照解析失败时锁定步骤视图并显示提示；`run.status==="failed" && selectedOccurrence===null` 时以 `firstFailedNodeId` 作画布选中。i18n 加 `runSession.detail.viewTopology/viewSteps/snapshotMissing`。

- [ ] **Step 4: 跑 GREEN**

Run：同 Step 2 → PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-desktop/src-react/domains/ai/automation/components/run-step-log.tsx apps/tianshu-desktop/src-react/domains/ai/automation/components/graph-run-detail.tsx apps/tianshu-desktop/src-react/i18n/locales/zh-CN/chat.json apps/tianshu-desktop/src-react/i18n/locales/en-US/chat.json apps/tianshu-desktop/tests/ai/graph-run-detail.test.tsx
git commit -m "feat: 工作流执行详情拓扑与步骤双视图"
```

---

### Task 5: 节点详情大弹框

**Files:**
- Create: `apps/tianshu-desktop/src-react/domains/ai/automation/components/node-run-dialog.tsx`
- Modify: `apps/tianshu-desktop/src-react/i18n/locales/{zh-CN,en-US}/chat.json`
- Test: `apps/tianshu-desktop/tests/ai/node-run-dialog.test.tsx`（新）

**Interfaces:**
- Consumes: `TraceEntry`；`GraphApi.runNodes(runId): Promise<GraphRunNodeRow[]>`（queryKey `["orchestration","runNodes",runId]`，`staleTime: Infinity`，`enabled: open`）；`MessageImage`；`formatDateTime/formatDuration`；`Dialog`/`Tabs`（components/ui）。
- Produces: `NodeRunDialog({ run, trace, occurrence, onClose, onNavigate }: { run: AutomationRunDetail; trace: TraceEntry[]; occurrence: number | null; onClose: () => void; onNavigate: (index: number) => void })`；内部导出纯函数 `isLastOccurrence(trace, index): boolean`（该 nodeId 在 trace 中最后一次出现的下标是否等于 index）。

- [ ] **Step 1: 写失败测试**（`node-run-dialog.test.tsx`）

用例：① `occurrence=0` 打开渲染摘要 Tab（状态/时间/耗时/tokens）与失败错误 Tab 默认激活（failed entry）；② 非 failed 默认摘要 Tab；③ 输入/输出 Tab：mock `GraphApi.runNodes` 命中 `nodeId` 且 `isLastOccurrence` → 渲染 `full.input`/`full.output` 全文与「复制」按钮（`navigator.clipboard.writeText` 被调用）；④ 同节点 occurrence=0 非末次 → 显示 trace `outputPreview` 与 occurrence 提示文案（`runSession.detail.occurrenceNote`），不渲染 full 全文；⑤ `outputImage` → 渲染 MessageImage；⑥ 工具 Tab 列出 `toolCalls`（失败标红）；⑦ 底部「上一节点/下一节点/下一失败节点」：index±1 与下一 failed 跳转、边界禁用；⑧ `occurrence=null` 不渲染。

- [ ] **Step 2: 跑 RED**

Run（`apps/tianshu-desktop`）：`npx vitest run tests/ai/node-run-dialog.test.tsx`
Expected: FAIL（组件缺失）。

- [ ] **Step 3: 实现**

`node-run-dialog.tsx`：`DialogContent className="max-w-3xl border border-border/50 rounded-lg shadow-lg"`；`Tabs` 五页（空内容页禁用）；复制按钮逐区块（`void navigator.clipboard.writeText(text)` + toast `t("chat:runSession.node.copySuccess")`）；非末次 occurrence 显示提示行；导航三按钮按 trace 顺序计算目标下标（nextFailed 向后找首个 failed，无则禁用）。i18n 加 `runSession.node.tabs.summary/input/output/tools/error`、`runSession.node.copy/copySuccess/prev/next/nextFailed`、`runSession.detail.occurrenceNote`。

- [ ] **Step 4: 跑 GREEN**

Run：同 Step 2 → PASS；`npx vitest run tests/ai/run-history-panel.test.tsx` 回归 PASS（历史弹窗零变化）。

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-desktop/src-react/domains/ai/automation/components/node-run-dialog.tsx apps/tianshu-desktop/src-react/i18n/locales/zh-CN/chat.json apps/tianshu-desktop/src-react/i18n/locales/en-US/chat.json apps/tianshu-desktop/tests/ai/node-run-dialog.test.tsx
git commit -m "feat: 节点运行详情弹框与导航"
```

---

### Task 6: RunSessionView 集成、按 run 草稿与文档

**Files:**
- Modify: `apps/tianshu-desktop/src-react/domains/ai/automation/views/RunSessionView.tsx`（图分支换 `GraphRunDetail`+`NodeRunDialog`；`ChatPane` 接草稿通道；删旧 `GraphRunResult`）
- Create: `apps/tianshu-desktop/src-react/domains/ai/automation/lib/run-draft-store.ts`
- Modify: `apps/tianshu-desktop/src-react/domains/ai/automation/components/RunSelector.tsx`（删除残留的 Popover 导入与无用 i18n key 引用）
- Modify: `docs/user-manual.md`
- Test: `apps/tianshu-desktop/tests/ai/run-draft-store.test.ts`（新）、`apps/tianshu-desktop/tests/ai/run-session-view.test.tsx`、`apps/tianshu-desktop/tests/ai/run-session-e2e.test.tsx`

**Interfaces:**
- Consumes: Task 2 `RunBoard`；Task 4 `GraphRunDetail`；Task 5 `NodeRunDialog`；ChatPane 既有 `initialDraft?: string`、`onDraftUnmount?: (draft: string) => void`（ChatPane.tsx:92-95，零改动复用）。
- Produces: `getRunDraft(runId: number): string`、`setRunDraft(runId: number, text: string): void`（模块级 Map，FIFO 上限 50 条，`setRunDraft(id, "")` 删除条目）。

- [ ] **Step 1: 写失败测试**

`run-draft-store.test.ts`：set/get 往返；空串删除；第 51 条写入淘汰最旧。`run-session-view.test.tsx` 新增：图运行详情渲染 `GraphRunDetail`（mock 层断言传入 `run`/`trace`）；点击步骤行后弹框出现、`onClose` 后消失且视图状态保留；输入草稿→切到 run 2→切回 run 1，草稿恢复且 run 2 的面板从未出现 run 1 草稿。`run-session-e2e.test.tsx` 增补：三次运行后看板出现三条目、当前项高亮（沿用现有渲染断言口径）。

- [ ] **Step 2: 跑 RED**

Run（`apps/tianshu-desktop`）：`npx vitest run tests/ai/run-draft-store.test.ts tests/ai/run-session-view.test.tsx tests/ai/run-session-e2e.test.tsx`
Expected: 新增断言 FAIL。

- [ ] **Step 3: 实现**

`run-draft-store.ts` 按 Interfaces 实现。`RunSessionView`：`RunConversation` 的 graph 分支用 `GraphRunDetail`（`selectedOccurrence`/`onSelectOccurrence` 提升到 RunConversation state，`occurrence !== null` 时渲染 `NodeRunDialog`）；删除 `GraphRunResult`；`ChatPane` 加 `initialDraft={getRunDraft(run.id)}` 与 `onDraftUnmount={(d) => setRunDraft(run.id, d)}`（ChatPane 本体零改动）；`RunSelector.tsx` 移除默认组件与 Popover 依赖，`run-session.selectRun` 等 仅被其使用的 key 从两语言 JSON 删除。`docs/user-manual.md` 固定入口章节补三句：右侧看板切换、拓扑/步骤双视图、节点弹框查看全文；trace 仍是权威结果。

- [ ] **Step 4: 跑 GREEN + 全量受影响矩阵**

Run（`apps/tianshu-desktop`）：
`npx vitest run tests/ai/run-draft-store.test.ts tests/ai/run-session-view.test.tsx tests/ai/run-session-e2e.test.tsx tests/ai/run-board.test.tsx tests/ai/run-graph-canvas.test.tsx tests/ai/graph-canvas-readonly.test.tsx tests/ai/graph-run-detail.test.tsx tests/ai/node-run-dialog.test.tsx tests/ai/run-session-service.test.ts tests/ai/run-session-route.test.ts tests/ai/run-followup-service.test.ts tests/ai/query-invalidate-events.test.ts tests/ai/session-tree-panel.test.tsx tests/ai/automation-route.test.ts tests/ai/run-history-panel.test.tsx`
→ 全部 PASS。
Run（根）：`npm run typecheck && npm run lint && npm run test:packages`。
Run（server，Task 1 改动复核）：`npx jest test/modules/run-session.spec.ts test/sdk-contract.spec.ts --runInBand` → PASS。
`npm run check:drift`：仅允许 Task 1 已复核过的两条 mirror 基线，三个 agent alert 保持。

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-desktop/src-react/domains/ai/automation/views/RunSessionView.tsx apps/tianshu-desktop/src-react/domains/ai/automation/lib/run-draft-store.ts apps/tianshu-desktop/src-react/domains/ai/automation/components/RunSelector.tsx docs/user-manual.md apps/tianshu-desktop/tests/ai/run-draft-store.test.ts apps/tianshu-desktop/tests/ai/run-session-view.test.tsx apps/tianshu-desktop/tests/ai/run-session-e2e.test.tsx
git commit -m "feat: 固定入口集成执行详情双视图与按次草稿"
```
