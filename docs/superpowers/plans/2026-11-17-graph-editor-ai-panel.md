# 编排编辑器 AI 编排面板 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在流程编排编辑器右栏新增「AI 编排」标签页：对话式生成/修改图（全量 JSON 或结构化变更单），校验通过后自动落画布并给出可撤销回执。

**Architecture:** 渲染层单趟 LLM 调用实现 AI 改图（不碰主进程聊天引擎）：`ChatPane` 加两个可选扩展点（每条发送前缀构建器 + 消息级插槽），新 `GraphAiPanel` 仿 `FileChatPanel` 组合 `ChatPane`，消息下挂 `GraphEditCard` 完成解析→校验→自动应用→回执闭环。绑定走 `graphDefinition.aiSessionId` 可空列（1:1，资源侧拥有）。

**Tech Stack:** React 19 + TypeScript + zod + vitest（jsdom 组件测试）+ react-i18next；Prisma + SQLite（v1 快照加列）。

**Spec:** `docs/superpowers/specs/2026-11-17-graph-editor-ai-panel-design.md`（本计划从 spec 取证，执行者需同读）

## Global Constraints

- 用户可见文案一律 i18n：`useTranslation(["chat"])`，key 挂 `chat:orchestration.editor.ai.*`，camelCase，**禁止顶层 key 与嵌套 key 重名**；zh-CN 与 en-US 同步添加。
- 样式禁硬编码颜色：主题变量（`text-primary`、`bg-primary-subtle`、`border-border/50` 等）；弹出层圆角 `rounded-lg`、阴影 `shadow-lg`。
- 文件名 kebab-case；Prettier：双引号、分号、tabWidth=2、printWidth=80、无尾随逗号；生产代码禁 `console`/`debugger`。
- 测试位置：`apps/tianshu-desktop/tests/ai/*.test.ts(x)`，vitest，alias `@` → `src-react`；平铺 `describe/it` 风格。
- 引用共享包类型经 `@/domains/ai/orchestration/api/graph.schema`（re-export `@tianshu/core/graph-schema`）。
- 提交信息风格照仓库惯例：`feat(desktop): …`（中文），末尾带 Co-Authored-By 行。

## Review Focus

1. **AI 全量回传丢坐标**：模型常省略未改节点的 `position`——应用后用户手工布局被打乱。→ `mergeSurvivingPositions` 单测（Task 1）。
2. **assistant 消息 blocks 混杂**：`MessageRecord.blocks` 是 JSON 数组文本，含 thinking/工具/文本块——卡片取文本必须只拼 text 块。→ `extractTextOfMessage` 单测（Task 6）。
3. **生成中切 tab/收起面板断流**：`useChatSend` 卸载即断流——两 tab 常驻挂载 CSS 显隐。无自动测试，Task 8 人工验证点。
4. **modelId 幻觉**：AI 臆造模型 id 导致运行时才炸——指令必须注入模型目录且 test 断言目录在文本中（Task 2）。
5. **会话被外部删除**：面板善后清 `aiSessionId` 绑定，再发即新建。集成行为，Task 5 代码评审点 + 最终人工冒烟。

---

### Task 1: graph-ai-ops —— 变更单 schema 与应用器

**Files:**
- Create: `apps/tianshu-desktop/src-react/domains/ai/orchestration/lib/graph-ai-ops.ts`
- Test: `apps/tianshu-desktop/tests/ai/graph-ai-ops.test.ts`

**Interfaces:**
- Consumes: `GraphJson`/`GraphNode`/`GraphEdge`（`@/domains/ai/orchestration/api/graph.schema`）；`renameNode(graph, oldId, nextId)`（`lib/graph-editor-model.ts:476`）。
- Produces（后续任务按此引用）:
  ```ts
  export const graphChangeSetSchema: z.ZodType<GraphChangeSet>;
  export interface GraphChangeSet { ops: GraphOp[] }
  export type GraphOp =
    | { op: "addNode"; node: GraphNode }
    | { op: "updateNode"; id: string; patch: Record<string, unknown> }
    | { op: "removeNode"; id: string }
    | { op: "renameNode"; from: string; to: string }
    | { op: "addEdge"; edge: GraphEdge }
    | { op: "removeEdge"; from: string; to: string; conditionValue?: string };
  export function applyGraphOps(graph: GraphJson, ops: GraphOp[]): GraphJson;
  export function mergeSurvivingPositions(current: GraphJson, next: GraphJson): GraphJson;
  ```

- [ ] **Step 1: 写失败测试**

`tests/ai/graph-ai-ops.test.ts`，用 `emptyGraph()` 起步，断言：
- `applyGraphOps` addNode 追加节点、addEdge 追加边（`from/to` 存在时）；
- removeNode 级联删除 from/to 引用它的边；
- renameNode 同步边引用（复用 `renameNode`）；
- updateNode 宽松补丁（`{...node, ...patch}`，patch 不得改 `id`/`kind`）；
- 对不存在节点的 updateNode/removeNode/renameNode 抛 `Error`（消息含节点 id）；
- 自环/重复边 addEdge 抛 `Error`；
- `mergeSurvivingPositions`：next 中 id 相同且自身无 `position` 的节点继承 current 坐标；next 自带 position 的不覆盖；`endPosition` 同理继承。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/tianshu-desktop && npx vitest run tests/ai/graph-ai-ops.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `graph-ai-ops.ts`**

`graphChangeSetSchema` 用 zod discriminated union（`op` 为判别字段）；`GraphNode`/`GraphEdge` 校验直接复用 `graphNodeSchema`/`graphEdgeSchema`（`graph.schema`）。`applyGraphOps` 按 ops 顺序折叠，每步校验前置条件（节点存在性/边合法性），非法即抛 `Error`（供 Task 6 卡片捕获进失败态）。坐标合并按接口注释实现。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ai/graph-ai-ops.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-desktop/src-react/domains/ai/orchestration/lib/graph-ai-ops.ts apps/tianshu-desktop/tests/ai/graph-ai-ops.test.ts
git commit -m "feat(desktop): 图 AI 变更单 schema 与应用器（含坐标合并）"
```

---

### Task 2: graph-ai-context —— 指令/快照构建与回复解析

**Files:**
- Create: `apps/tianshu-desktop/src-react/domains/ai/orchestration/lib/graph-ai-context.ts`
- Test: `apps/tianshu-desktop/tests/ai/graph-ai-context.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `graphChangeSetSchema`/`GraphChangeSet`；`graphJsonSchema`/`GraphJson`；`serializeGraph`（`lib/graph-editor-model.ts:371`）。
- Produces:
  ```ts
  export interface GraphAiModelRef { id: number; name: string }
  export function buildGraphAiInstruction(
    t: TFunc,
    models: GraphAiModelRef[],
  ): string;
  export function buildGraphContextPrefix(
    t: TFunc,
    p: {
      graphName: string;
      description?: string;
      graphJson: string;
      models: GraphAiModelRef[];
      selectedNodeIds?: string[];
    },
  ): string;
  export type GraphEditExtraction =
    | { kind: "ops"; changeSet: GraphChangeSet }
    | { kind: "full"; json: GraphJson }
    | null;
  export function extractGraphEdit(text: string): GraphEditExtraction;
  ```
  `TFunc = (key: string, opts?: Record<string, unknown>) => string`（照 `localizeGraphIssue` 模式，`lib/graph-editor-model.ts:442`）。

- [ ] **Step 1: 写失败测试**

断言：
- `extractGraphEdit`：含合法变更单 ```json 块 → kind "ops"；含合法全量图块 → kind "full"；混合文本取对的那块；先按变更单 schema 试再按全量 schema；都不合法 → null；无代码块 → null。
- `buildGraphAiInstruction`：返回串含**全部**模型目录条目（`#${id} ${name}` 形态）；含「两种输出形态」规则文案；含 modelId 约束（仅用目录 id 或 0 占位）。
- `buildGraphContextPrefix`：含图名/description/canonicalJson/选中节点 id 列表；`graphJson` 超 60_000 字符时降级为结构摘要（节点 id+kind+name 行 + 边行）且不含完整 JSON 与截断说明文案。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/graph-ai-context.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `graph-ai-context.ts`**

`extractGraphEdit`：正则提取所有 ```json fenced 块，逐块 `JSON.parse` → 先试 `graphChangeSetSchema.safeParse` 再试 `graphJsonSchema.safeParse`，首个命中即返回。60k 降级：`JSON.parse(graphJson)` 后取 `nodes.map(n => "${n.id} ${n.kind} ${n.name}")` + `edges` 行。i18n key 全走 `chat:orchestration.editor.ai.*`（本任务先在 locale 文件占位 key，Task 7 统一补全文案）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ai/graph-ai-context.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-desktop/src-react/domains/ai/orchestration/lib/graph-ai-context.ts apps/tianshu-desktop/tests/ai/graph-ai-context.test.ts apps/tianshu-desktop/src-react/i18n/locales/zh-CN/chat.json apps/tianshu-desktop/src-react/i18n/locales/en-US/chat.json
git commit -m "feat(desktop): 图 AI 指令/快照构建与回复解析"
```

---

### Task 3: aiSessionId 绑定全链路（DB → IPC → API）

**Files:**
- Modify: `apps/tianshu-desktop/prisma/schema.prisma`（graphDefinition 加列）
- Modify: `apps/tianshu-desktop/electron/infrastructure/script/v1/upgrade-table.sql`（graphDefinition 建表语句加列）
- Modify: `apps/tianshu-desktop/electron/domains/ai/orchestration/graph.repo.ts`（`toGraphRecord`、`registerHandlers`）
- Modify: `apps/tianshu-desktop/electron/commons/ipc-channels.ts`（`IPC_INVOKE_ALLOWLIST` 行 199-217 区块加一条）
- Modify: `apps/tianshu-desktop/src-react/domains/ai/orchestration/api/orchestration.api.ts`（`GraphRecord` 加字段 + `bindAiSession`）

**Interfaces:**
- Produces:
  ```ts
  // orchestration.api.ts
  interface GraphRecord { /* 现有字段 */ aiSessionId?: number | null }
  class GraphApi {
    static bindAiSession(
      id: number,
      aiSessionId: number | null,
    ): Promise<GraphRecord>; // 通道 "orchestration:bindAiSession"
  }
  ```
  主进程 handler：`handleUser("orchestration:bindAiSession", (_, userId, id, aiSessionId)` → `prisma.graphDefinition.updateMany({ where: { id, userId }, data: { aiSessionId } })`，count===0 抛 `"GRAPH_NOT_FOUND"`，随后 `findUniqueOrThrow` + `toGraphRecord`。

- [ ] **Step 1: schema 加列**

`schema.prisma` graphDefinition 增 `aiSessionId Int?`（带注释 `// AI 编排会话绑定（1:1，null=未绑定）`）；v1 `upgrade-table.sql` graphDefinition 建表语句同步加 `aiSessionId INTEGER NULL,`。运行 `cd apps/tianshu-desktop && npx prisma generate` 刷新 client。

- [ ] **Step 2: repo 与记录映射**

`graph.repo.ts`：`toGraphRecord` 增 `aiSessionId: row.aiSessionId ?? null`（主进程 `GraphRecord` 类型同步）；`registerHandlers` 内新增上述 handler（update 是全量覆盖+version 锁，**不动它**，绑定走独立通道避免误清）。

- [ ] **Step 3: 通道白名单 + 渲染 API**

`ipc-channels.ts` orchestration 区块加 `"orchestration:bindAiSession"`；`orchestration.api.ts` 加方法（走 `routeInvoke` 本地/远程同口径——远程 server-face 暂不支持，照 `templates` 的 `rejectOnRemote` 门控处理）。

- [ ] **Step 4: 验证**

Run: `npm run typecheck`
Expected: PASS（生成 client 后类型贯通）

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-desktop/prisma/schema.prisma apps/tianshu-desktop/electron/infrastructure/script/v1/upgrade-table.sql apps/tianshu-desktop/electron/domains/ai/orchestration/graph.repo.ts apps/tianshu-desktop/electron/commons/ipc-channels.ts apps/tianshu-desktop/src-react/domains/ai/orchestration/api/orchestration.api.ts
git commit -m "feat(desktop): graphDefinition 增加 aiSessionId 绑定列与专用 IPC"
```

---

### Task 4: ChatPane 扩展点 —— buildSendPrefix + renderMessageExtra

**Files:**
- Modify: `apps/tianshu-desktop/src-react/domains/ai/chat/components/ChatPane.tsx`（`ChatPaneProps` 加两个可选 prop；`handleSend` 两处发送路径拼前缀）
- Modify: `apps/tianshu-desktop/src-react/domains/ai/chat/components/ChatMessages.tsx`（透传 `renderMessageExtra`）
- Modify: `apps/tianshu-desktop/src-react/domains/ai/chat/components/MessageList.tsx`（透传）
- Modify: `apps/tianshu-desktop/src-react/domains/ai/chat/components/MessageItem.tsx`（气泡下方渲染插槽）
- Test: `apps/tianshu-desktop/tests/ai/message-item-extra.test.tsx`（文件头 `@vitest-environment jsdom`）

**Interfaces:**
- Produces:
  ```ts
  // ChatPaneProps 新增（均可选，缺省零行为变化）
  buildSendPrefix?: () => string;
  renderMessageExtra?: (message: MessageRecord) => ReactNode;
  // MessageItemProps 新增
  renderExtra?: (message: MessageRecord) => ReactNode;
  ```
  哨兵首条路径拼装顺序：`[resolved.contentPrefix, sendPrefix, injected].filter(Boolean).join("\n\n")`；常设路径：`send(sendPrefix ? sendPrefix + "\n\n" + injected : injected, …)`。

- [ ] **Step 1: 写失败测试（jsdom）**

渲染 `MessageItem`（message 为最小 `MessageRecord`：`{ id:1, sessionId:1, role:"assistant", blocks:'[{"type":"text","text":"hi"}]', createdAt:"" }`，props 其余照组件现有必填项给最小值），传 `renderExtra={() => <div data-testid="extra">X</div>}`，断言 `screen.getByTestId("extra")` 存在；不传时无该节点。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/message-item-extra.test.tsx`
Expected: FAIL（prop 不存在）

- [ ] **Step 3: 实现穿透**

`MessageItem` 底部（actions 行之外）加 `{renderExtra?.(message)}`；`MessageList`/`ChatMessages`/`ChatPane` 逐级透传同名 prop；`ChatPane.handleSend` 两处路径按接口注释拼 `buildSendPrefix()`。

- [ ] **Step 4: 跑测试 + 聊天域回归**

Run: `npx vitest run tests/ai/message-item-extra.test.tsx tests/ai/chat`
Expected: PASS（不传新 prop 时现有测试全绿）

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-desktop/src-react/domains/ai/chat/components/ apps/tianshu-desktop/tests/ai/message-item-extra.test.tsx
git commit -m "feat(desktop): ChatPane 增加发送前缀构建器与消息级渲染插槽"
```

---

### Task 5: use-graph-ai-session —— 会话绑定 hook

**Files:**
- Create: `apps/tianshu-desktop/src-react/domains/ai/orchestration/hooks/use-graph-ai-session.ts`

**Interfaces:**
- Consumes: Task 2 的 `buildGraphAiInstruction`/`buildGraphContextPrefix`；Task 3 的 `GraphApi.bindAiSession`；`ChatPane` 的 `SessionResolverResult`（`chat/components/ChatPane.tsx:53`）；`isSessionGoneError` 语义（`file-window/hooks/use-file-session.ts:52`，字符串含 `"SESSION_NOT_FOUND"`）。
- Produces（GraphAiPanel 按此引用）:
  ```ts
  export function useGraphAiSession(p: {
    graphId: number;
    graphName: string;
    description?: string;
    graphJson: string;
    models: GraphAiModelRef[];
    boundSessionId: number | undefined;      // record.aiSessionId ?? undefined
    onBindingChange: (sessionId: number | undefined) => void; // 面板本地态回写 + 失效图记录查询
  }): {
    prepareFirstSend: () => Promise<SessionResolverResult>;
    buildSendPrefix: () => string;
    startNewSession: () => Promise<void>;     // bindAiSession(graphId, null) + onBindingChange(undefined)
    handleSessionGone: () => void;            // 同上清绑定 + toast（i18n）
    isSessionGoneError: (e: unknown) => boolean;
  };
  ```

- [ ] **Step 1: 实现 hook**

- `ensureSession()`：防重入 ref；已绑定直接复用；否则 `WorkspaceApi.list()` 取首个空间（空列表自动补建默认空间是既有行为）→ `invoke("session:create", { workspaceId, title: graphName })` → `GraphApi.bindAiSession(graphId, id)` → `onBindingChange(id)`；返回 stub `SessionRecord`（照 `use-file-session.ts:231` 形状）。
- `prepareFirstSend`：`ensureSession()` 后返回 `{ session: stub, contentPrefix: instruction + "\n\n" + snapshot }`（instruction 仅首条带）。
- `buildSendPrefix()`：返回 snapshot（每次发送最新图）。
- `startNewSession`/`handleSessionGone`：调 `bindAiSession(graphId, null)` 清绑定 + `onBindingChange(undefined)` +（gone 时）toast `chat:orchestration.editor.ai.sessionGone`。

- [ ] **Step 2: 验证**

Run: `npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/tianshu-desktop/src-react/domains/ai/orchestration/hooks/use-graph-ai-session.ts
git commit -m "feat(desktop): 图 AI 会话绑定 hook（graphDefinition.aiSessionId）"
```

---

### Task 6: GraphEditCard —— 消息级回执卡片

**Files:**
- Create: `apps/tianshu-desktop/src-react/domains/ai/orchestration/components/GraphEditCard.tsx`
- Test: `apps/tianshu-desktop/tests/ai/graph-edit-card.test.tsx`（`@vitest-environment jsdom`）

**Interfaces:**
- Consumes: Task 1 `applyGraphOps`/`mergeSurvivingPositions`；Task 2 `extractGraphEdit`；`validateGraph`/`normalizeGraph`（`graph.schema`）；`parseBlocks`（`domains/ai/chat/model/blocks`）。
- Produces:
  ```ts
  export function extractTextOfMessage(blocksJson: string): string; // 只拼 text 块
  export function canUndoReceipt(appliedAtJson: string, currentJson: string): boolean;
  export default function GraphEditCard(p: {
    message: MessageRecord;
    graphJson: string;            // 当前画布 canonicalJson
    onApplyOps: (ops: GraphOp[]) => void;
    onApplyFull: (json: GraphJson) => void;
    onUndo: () => void;
  }): JSX.Element | null;
  ```
  状态机（组件内 state）：`"applied" | "failed" | null`（无提取时不渲染）。挂载 effect（按 `message.id` 守卫 ref，防 StrictMode 双跑）：提取 → 构造候选图（ops：当前图折叠；full：`mergeSurvivingPositions(当前, 解析结果)`）→ `normalizeGraph` + `validateGraph` → 通过则调 `onApply*` 并置 applied，失败置 failed 并在卡内列出 `localizeGraphIssue` 化的问题。

- [ ] **Step 1: 写失败测试**

- `extractTextOfMessage`：text 块拼接、thinking/工具块忽略、blocks 非法 JSON 返回 `""`；
- `canUndoReceipt`：两者相等 true，不等 false；
- 组件（最小渲染）：ops 合法 + `validateGraph` 通过时 onApplyOps 被调一次（重复渲染不重复调）、卡片显示「已执行」回执与撤销按钮；`validateGraph` 不通过时 onApplyOps 未被调、卡片红色显示问题条目；无可提取内容时返回 null。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/graph-edit-card.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现 `GraphEditCard.tsx`**

按状态机实现；i18n key `chat:orchestration.editor.ai.*`（文案 Task 7 统一补全）。样式按 Global Constraints（主题变量、`rounded-lg`、`border-border/50`）。图标：Plus/Pencil/Trash/Link/Unlink/RotateCcw（lucide）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ai/graph-edit-card.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/tianshu-desktop/src-react/domains/ai/orchestration/components/GraphEditCard.tsx apps/tianshu-desktop/tests/ai/graph-edit-card.test.tsx
git commit -m "feat(desktop): 图 AI 消息级回执卡片（解析/校验/自动应用/撤销）"
```

---

### Task 7: GraphAiPanel 组装 + i18n 全量文案

**Files:**
- Create: `apps/tianshu-desktop/src-react/domains/ai/orchestration/components/GraphAiPanel.tsx`
- Modify: `apps/tianshu-desktop/src-react/i18n/locales/zh-CN/chat.json`、`en-US/chat.json`（`orchestration.editor` 块内补 `ai` 子对象）

**Interfaces:**
- Consumes: Task 2 `buildGraphAiInstruction`/`buildGraphContextPrefix`/`GraphAiModelRef`；Task 5 `useGraphAiSession`；Task 6 `GraphEditCard`；Task 4 `ChatPane` 新 prop；`ModelApi.listAll` + `modelDisplayName`（`domains/ai/api/model.api.ts:138`）。
- Produces:
  ```ts
  export default function GraphAiPanel(p: {
    graphId: number;
    graphName: string;
    description?: string;
    graphJson: string;
    aiSessionId: number | undefined;
    onBindingChange: (sessionId: number | undefined) => void;
    onApplyOps: (ops: GraphOp[]) => void;
    onApplyFull: (json: GraphJson) => void;
    onUndo: () => void;
  }): JSX.Element;
  ```

- [ ] **Step 1: 补全 i18n 文案（zh-CN 与 en-US 对称）**

`orchestration.editor.ai` 子对象：`tab`（"AI 编排"/"AI orchestration"）、`panelTitle`、`newSession`、`collapse`、`sessionGone`、`receiptApplied`、`receiptUndo`、`receiptFailed`、`receiptFailedHint`、`itemAddNode`/`itemUpdateNode`/`itemRemoveNode`/`itemAddEdge`/`itemRemoveEdge`/`itemRenameNode`/`itemFullReplace`（插值变量如 `{id}` `{kind}`）、`issueCount`、`instruction`（长指令模板，含两种形态规则与 modelId 约束）、`prefixFull`/`prefixSummary`/`prefixSelectedNodes`/`truncatedNote`、`quickExplain`/`quickExplainPrompt`/`quickSuggest`/`quickSuggestPrompt`、`unsavedToast`、`modelsCatalog` 标签。检查顶层/嵌套 key 不重名。

- [ ] **Step 2: 实现 `GraphAiPanel.tsx`**

结构照 `FileChatPanel`（`file-window/components/FileChatPanel.tsx`）精简版：
- `useQuery(["models","all"], ModelApi.listAll)` → `models = list.map(m => ({ id: m.id, name: modelDisplayName(m) }))`；
- 会话记录查询 key `["sessions","graph-ai",boundId]`（enabled boundId>0, retry false）+ 占位哨兵（id=-1，shape 照 FileChatPanel:135-146）+ loading/错误两态照抄；
- `useGraphAiSession({…, boundSessionId, onBindingChange})`；
- `hasModel` 照 FileChatPanel 口径（会话 currentModelId ?? 工作空间 defaultModelId；工作空间取会话 workspaceId 经 `WorkspaceApi.list()` 解析，占位期按默认空间兜底）；
- `handleOpenSettings`：react-router `navigate`（providers `/module/ai/providers`、assistants `/module/ai/experts`、mcp `/module/ai/experts?tab=connectors`，照 `FileChatPanel.tsx:60-64` 映射表）；
- 头部：新建会话（SquarePen）、收起（PanelRightClose，回调经 prop 上抛给 GraphEditorView 收 panelState）；
- `ChatPane` 组合：`key={paneSession.id}`、`sessionResolver={prepareFirstSend}`、`onSessionResolved={(s)=>onBindingChange(s.id)}`、`buildSendPrefix`、`renderMessageExtra={(m)=> m.role==="assistant" ? <GraphEditCard message={m} graphJson={graphJson} onApplyOps={onApplyOps} onApplyFull={onApplyFull} onUndo={onUndo}/> : null}`、`quickPrompts` 两条（解释/建议，点击填草稿不发送）。

- [ ] **Step 3: 验证**

Run: `npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/tianshu-desktop/src-react/domains/ai/orchestration/components/GraphAiPanel.tsx apps/tianshu-desktop/src-react/i18n/locales/
git commit -m "feat(desktop): 图 AI 编排面板组件与会话绑定组装"
```

---

### Task 8: GraphEditorView 接线 —— 右栏 tabs + 自动应用回调

**Files:**
- Modify: `apps/tianshu-desktop/src-react/domains/ai/orchestration/views/GraphEditorView.tsx`（panelState 区行 310-320、右栏渲染区行 1203-1297、GraphApi 调用区行 841-899）

**Interfaces:**
- Consumes: Task 7 `GraphAiPanel`；Task 1 `applyGraphOps`/`mergeSurvivingPositions`；`normalizeGraph`/`validateGraph`。
- Produces: 无新导出（视图接线）。

- [ ] **Step 1: 视图状态与回调**

- `const [panelTab, setPanelTab] = useState<"props" | "ai">("props")`；
- `const [boundAiSessionId, setBoundAiSessionId] = useState<number | undefined>()`，`useEffect` 在 `record?.aiSessionId` 变化时同步（record 来自既有查询）；
- `handleApplyOps = useCallback((ops) => { commitGraph(cur => { const cand = normalizeGraph(applyGraphOps(cur, ops)); const v = validateGraph(cand); if (!v.ok) { toast.error(t("chat:orchestration.editor.ai.applyBlocked")); return cur; } return cand; }) }, …)`（防御线：卡片已校验，此处再拦一次）；
- `handleApplyFull = useCallback((json) => commitGraph(cur => { const merged = mergeSurvivingPositions(cur, json); const v = validateGraph(merged); if (!v.ok) { toast.error(…同上); return cur; } return merged; }), …)`；
- `handleUndo = useCallback(() => undoGraph(), …)`；应用后 `selectedId` 不在新图中时置 null。

- [ ] **Step 2: 右栏改 tabs + 双把手 + 常驻挂载**

- 头部标题行改 tabs（属性/AI 编排，图标 Settings2/Sparkles，激活态 `text-primary` 下划线或底边框）+ 右侧原最大化/最小化/收起不动；
- **两 tab 常驻挂载**：`NodePropertiesPanel` 与 `GraphAiPanel` 都渲染，用 `hidden`（`className={panelTab==="props" ? "" : "hidden"}`）切换显隐（5c：生成中切 tab 不断流）；
- 收起态右缘把手改两个（上下排列，属性/AI 各一，`Settings2`/`Sparkles` 图标 + 竖排文字），点击各自 `setPanelState("float") + setPanelTab(...)`；
- `isNew` 时 AI tab 点击 → toast `chat:orchestration.editor.ai.unsavedToast`，不切换；
- `GraphAiPanel` 传 props（Task 7 接口）：`graphId={graphId} graphName={name} description={description} graphJson={currentJson} aiSessionId={boundAiSessionId} onBindingChange={setBoundAiSessionId} onApplyOps/onApplyFull/onUndo` + 收起回调收 panel。

- [ ] **Step 3: 保存后回填绑定（isNew → 保存 → replace 导航）**

现状保存成功已 `invalidate` + `navigate(...saved.id, { replace: true })`；新图保存前 AI tab 本禁用，无需额外处理；在保存成功分支补 `setBoundAiSessionId(undefined)` 重置即可。

- [ ] **Step 4: 全量验证**

Run: `cd apps/tianshu-desktop && npx vitest run tests/ai && npm run typecheck && npm run lint`
Expected: 全 PASS

- [ ] **Step 5: 人工冒烟（dev 起 `npm run dev`）**

验证 Review Focus 第 3 条：打开已保存图 → AI tab 发一条「解释当前图」→ 流式期间切到属性 tab 再切回，流不断；AI 输出变更单后卡片自动应用、画布更新、撤销可用；新建图 AI tab 禁用提示。

- [ ] **Step 6: Commit**

```bash
git add apps/tianshu-desktop/src-react/domains/ai/orchestration/views/GraphEditorView.tsx
git commit -m "feat(desktop): 编排编辑器右栏接入 AI 编排面板（tabs/自动应用/回执）"
```

---

## 自审记录

- Spec 覆盖：右栏 tabs（Task 8）、GraphAiPanel（Task 7）、会话绑定（Task 3/5）、上下文注入（Task 2 + ChatPane Task 4）、变更卡片与自动应用回执（Task 6/8）、坐标保留（Task 1 merge + Task 8）、校验链（Task 6/8）、i18n（Task 2/6/7）、消息级插槽（Task 4）——spec 各节均有任务承载。
- 类型一致性：`GraphOp`/`GraphChangeSet`（Task 1 定义，Task 6/7/8 引用一致）；`GraphAiModelRef`（Task 2 定义，Task 5/7 引用一致）；`onBindingChange`（Task 5/7/8 一致）。
- 挂账未做（spec 明示）：空会话回收、60k 以上大图 token 优化、远程主机支持、真 agentic——计划中无任务，符合 spec。
