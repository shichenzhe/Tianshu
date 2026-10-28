# 图执行留痕去会话化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 图执行不再创建聊天会话；节点级完整输入/输出落新表 `graphRunNode`，执行详情在工作流自有页面下钻查看（对齐 Coze 运行记录体系）。

**Architecture:** 执行器（mirror + apps/tianshu-server 双份）删 `createGraphSession` 与节点消息对，节点收口处改落 `graphRunNode`（启动幂等建表，artifact 先例）；`AgentStreamOptions.sessionId` 可空化（图执行传 null）；存量图运行会话启动幂等清理；前端 `GraphRunTraceView` 行展开下钻查节点全文。

**Tech Stack:** Electron 主进程 + Prisma 7 (better-sqlite3)、React 19 + React Query、Vitest（mirror）/ Jest（server）、git subtree 双份文件同步。

**Spec:** `docs/superpowers/specs/2026-10-28-graph-run-own-trace-design.md`

## Global Constraints

- 双份铁律：`electron/domains/ai/orchestration/graph-executor.ts` ↔ `apps/tianshu-server/src/core/graph/graph-executor.ts` 是 drift 基线双份文件，Task 3 的改动必须在 Task 6 同批同步；改后跑 `npm run check:drift`，差异超容差先核算再处置。
- 不开新分支：所有提交直接在 main（用户裁定）。
- mirror 侧建表**不走 v1 快照**（`ensureGraphRunNodeTable` 启动幂等，artifact/monitor 先例）；server 侧走 `prisma migrate dev`（server package.json 既有 `prisma:migrate` 脚本）。
- 图执行 `automationRun.sessionId` 收尾写 null；列保留（prompt 型任务仍写）。
- prompt 型定时任务（automation-runner）行为不动；移动端不透出 graphRunNode。
- i18n：新增用户可见文案在 `src-react/i18n/locales/{zh-CN,en-US}/chat.json` 同步补 key，禁止硬编码。
- 验收不跑 `npm run lint`（环境态全红，见记忆），用 `npx prettier --check` + `npx tsc -p tsconfig.json --noEmit`（即 `npm run typecheck`）+ vitest 替代。
- 测试用替身法 mock prisma-client（Electron ABI 下真库不可行；形态见 `tests/ai/graph-executor.test.ts` 头部 `vi.mock("../../electron/commons/prisma-client", ...)`）。
- 函数命名/文件名 kebab-case；改包源码后须重建 dist（`npm --prefix packages/tianshu-core run build`，本计划不涉及）。

---

### Task 1: graphRunNode 表——schema 声明 + ensureGraphRunNodeTable 启动幂等建表（mirror）

**Files:**
- Modify: `prisma/schema.prisma`（graphRunNode 模型，加在 automationStat 之后、artifact 之前或邻近 automationRun 处）
- Modify: `electron/commons/prisma-client.ts`（新增 ensureGraphRunNodeTable）
- Modify: `electron/Application.ts:114-124`（execute() 启动序列串入）
- Test: `tests/commons/ensure-graph-run-node.test.ts`（新建）

**Interfaces:**
- Consumes: 无（首个任务）。
- Produces: `ensureGraphRunNodeTable(): Promise<void>`（prisma-client.ts export，Task 4 无消费但启动序列共用模式）；Prisma model `graphRunNode`，字段见下方 SQL——Task 3 的 `prisma.graphRunNode.create` 与 Task 5 的查询依赖此表结构。

- [ ] **Step 1: schema.prisma 追加模型**（在 `model automationRun` 块之后插入；不走 v1 快照，注释对齐 artifact/llmCallEvent 惯例）

```prisma
// 图运行节点级执行详情（图执行留痕去会话化 spec 2026-10-28）：Coze 式
// 运行记录体系——节点完整输入/输出取代原「节点消息对落聊天会话」。
// 实际建表由 ensureGraphRunNodeTable 启动幂等补建（不走 v1 快照，
// 避免指纹变化触发旧库 drop 重建）
model graphRunNode {
  id               Int     @id @default(autoincrement())
  runId            Int
  nodeId           String
  nodeName         String?
  status           String // success | failed
  input            String? // 渲染后完整输入，截 64KB
  output           String? // 完整输出，截 64KB
  errorJson        String? // { code, message, toolName?, detail }，同 trace error
  toolCallsJson    String? // 工具调用摘要数组，同 trace
  promptTokens     Int?
  completionTokens Int?
  durationMs       Int
  startedAt        String // ISO string，与 trace 条目同构
  outputImage      String? // imageGen 产物相对数据根路径
  errorOutput      String? // 循环节点死信（onItemError=continue）
  fallbackJson     String? // 降级继续标记 { code, message }

  @@unique([runId, nodeId])
  @@index([runId])
}
```

- [ ] **Step 2: 重新生成 Prisma Client**

Run: `npx prisma generate`
Expected: 输出 `Generated Prisma Client`，`electron/generated/prisma` 内出现 graphRunNode 模型。

- [ ] **Step 3: 写失败测试**

```ts
// tests/commons/ensure-graph-run-node.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`) },
}));

import { ensureGraphRunNodeTable } from "../../electron/commons/prisma-client";

describe("ensureGraphRunNodeTable", () => {
  it("幂等建表：两跑均成功且表存在", async () => {
    await expect(ensureGraphRunNodeTable()).resolves.toBeUndefined();
    await expect(ensureGraphRunNodeTable()).resolves.toBeUndefined();
    // 首跑建表后 sqlite_master 必有 graphRunNode
    const prisma = (await import("../../electron/commons/prisma-client"))
      .default;
    const rows = (await prisma.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='graphRunNode'",
    )) as Array<{ name: string }>;
    expect(rows).toHaveLength(1);
  });
});
```

注：本用例走测试环境隔离库（`tests/setup.ts` 全局 `TIANSHU_DATA_ROOT`），better-sqlite3 在 Node ABI 下可用（vitest 环境真库限制仅针对 Electron ABI 场景；若本机跑挂于 ABI，改为断言 `$executeRawUnsafe` 被调用两次不抛——mock prisma-client 的 `$executeRawUnsafe` 为 `vi.fn()`）。

- [ ] **Step 4: 跑测试验证失败**

Run: `npx vitest run tests/commons/ensure-graph-run-node.test.ts`
Expected: FAIL（`ensureGraphRunNodeTable` 不是函数 / export 不存在）。

- [ ] **Step 5: 实现**（`electron/commons/prisma-client.ts`，紧跟 `ensureMonitorTables` 之后；DDL 与 schema 字段一一对应）

```ts
/**
 * 图运行节点详情表建表（图执行留痕去会话化 2026-10-28）：启动幂等补建，
 * 不走 v1 快照（指纹变化会触发旧库 drop 重建）。须在 initDatabase 之后调用。
 */
export async function ensureGraphRunNodeTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS graphRunNode (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      runId INTEGER NOT NULL,
      nodeId TEXT NOT NULL,
      nodeName TEXT,
      status TEXT NOT NULL,
      input TEXT,
      output TEXT,
      errorJson TEXT,
      toolCallsJson TEXT,
      promptTokens INTEGER,
      completionTokens INTEGER,
      durationMs INTEGER NOT NULL,
      startedAt TEXT NOT NULL,
      outputImage TEXT,
      errorOutput TEXT,
      fallbackJson TEXT,
      CONSTRAINT graphRunNode_runId_nodeId_key UNIQUE (runId, nodeId)
    )
  `);
  await prisma.$executeRawUnsafe(
    "CREATE INDEX IF NOT EXISTS graphRunNode_runId_idx ON graphRunNode (runId)",
  );
}
```

- [ ] **Step 6: 跑测试验证通过**

Run: `npx vitest run tests/commons/ensure-graph-run-node.test.ts`
Expected: PASS。

- [ ] **Step 7: Application.ts 启动序列串入**（`electron/Application.ts` execute() 内，`ensureMonitorTables` 调用之后追加）

```ts
    void ensureGraphRunNodeTable().catch((e) =>
      console.error("图运行节点详情表建表失败:", e),
    );
```

同步把 import 块里的 `ensureMonitorTables` 导入行扩为三行（ensureArtifactTable 已有、追加 ensureGraphRunNodeTable）。

- [ ] **Step 8: 回归 + 提交**

Run: `npx vitest run tests/commons/ && npx prettier --check electron/commons/prisma-client.ts electron/Application.ts prisma/schema.prisma`
Expected: 全 PASS。

```bash
git add prisma/schema.prisma electron/commons/prisma-client.ts electron/Application.ts tests/commons/ensure-graph-run-node.test.ts
git commit -m "feat(db): graphRunNode 节点详情表——schema 声明 + ensureGraphRunNodeTable 启动幂等建表（artifact/monitor 先例，不走 v1 快照）"
```

---

### Task 2: AgentStreamOptions.sessionId 可空化 + 消费点适配

**Files:**
- Modify: `electron/domains/ai/agent/tool-gate.ts:41`（接口字段）与 `:226`（工具 ctx 注入，类型透传不改）
- Modify: `electron/domains/ai/agent/browser-tools.ts:16`（GuestControlResolver 参数类型）
- Modify: `electron/domains/ai/chat/chat.service.ts:212`（backupFile 回调签名）、`electron/domains/security/file-history.ts:91-103`（backupFile 实现）、`electron/Application.ts:411`（透传处）
- Test: `tests/agent/tool-gate-session-id-null.test.ts`（新建）

**Interfaces:**
- Consumes: 无。
- Produces: `AgentStreamOptions.sessionId: number | null`（Task 3 的 buildAgentContext 传 null 依赖此放宽）；`FileHistory.backupFile(absPath: string, sessionId: number | null)`（null → 备份目录 `0/`，对齐 file-write-ipc.ts:162 传 0 先例）；`GuestControlResolver = (sessionId: number | null) => GuestControl | null`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/agent/tool-gate-session-id-null.test.ts
import { describe, expect, it } from "vitest";
import type { AgentStreamOptions } from "../../electron/domains/ai/agent/tool-gate";

describe("AgentStreamOptions.sessionId 可空", () => {
  it("sessionId: null 满足类型（图执行传 null 编译通过）", () => {
    const opts = {
      sessionId: null,
      workspacePath: undefined,
      projectId: null,
      fullAccess: () => false,
      isToolAllowed: async () => false,
      requestApproval: async () => false,
    } as AgentStreamOptions;
    expect(opts.sessionId).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run tests/agent/tool-gate-session-id-null.test.ts`
Expected: FAIL（类型错误：`Type 'null' is not assignable to type 'number'`）。

- [ ] **Step 3: 实现——四处类型放宽**

1. `tool-gate.ts:41`：`sessionId: number;` → `sessionId: number | null;`（注释行同步：「图执行无会话传 null（2026-10-28 去会话化）」）
2. `browser-tools.ts:16`：`export type GuestControlResolver = (sessionId: number | null) => GuestControl | null;`（运行时行为不变：map 查不到 null 键返回 null → 工具回「无可操控浏览器页」文案，图执行场景正确降级）
3. `chat.service.ts:212`：`backupFile: (absPath: string, sessionId: number | null) => Promise<BackupFileResult>;`
4. `file-history.ts:91-103`：签名 `sessionId: number | null`，行 103 目录名改 `String(sessionId ?? 0)`（对齐 file-write-ipc `backupFile(abs, 0)` 先例：图执行备份落 0/ 目录，不关联会话）

`Application.ts:411` 与 `automation-runner.ts:386` 是透传调用点，签名放宽后无需改（传的是 number）。

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `npx vitest run tests/agent/ && npm run typecheck`
Expected: PASS（typecheck 覆盖 chat.service/automation-runner 等全部消费方，确认无 number 收窄点报错）。

- [ ] **Step 5: 提交**

```bash
git add electron/domains/ai/agent/tool-gate.ts electron/domains/ai/agent/browser-tools.ts electron/domains/ai/chat/chat.service.ts electron/domains/security/file-history.ts tests/agent/tool-gate-session-id-null.test.ts
git commit -m "feat(agent): AgentStreamOptions.sessionId 可空化——GuestControlResolver/backupFile 链同步放宽，null 备份目录对齐 0/ 先例（图执行去会话化前置）"
```

---

### Task 3: 执行器改造——删会话、节点行落库、单节点测试即席化（mirror 侧）

**Files:**
- Modify: `electron/domains/ai/orchestration/graph-executor.ts`（主改造；调用点见 Step 3 清单）
- Test: `tests/ai/graph-executor.test.ts`（既有文件扩展）

**Interfaces:**
- Consumes: Task 1 的 `prisma.graphRunNode`；Task 2 的 `sessionId: number | null`。
- Produces:
  - `NodeContext`：**移除** `sessionId` 字段，**新增** `runId: number | null`（runGraph 传实值；testSingleNode 传 null）
  - `writeNodeRecord(ctx, node, input, output, startedAt, extra?)` / `writeNodeFailureRecord(ctx, node, input, failure, startedAt, extra?)`（取代 writeNodeMessages/writeNodeFailure；ctx.runId 为 null 时 no-op）
  - `NodeRecordExtra = { usage?, toolCalls?, outputImage?, fallback?, errorOutput? }`（Task 6 server 双改同签名）

- [ ] **Step 1: 写失败测试**（`tests/ai/graph-executor.test.ts` 追加 describe 块；文件头部 prisma mock 的 default 对象**先**追加 `graphRunNode: { create: vi.fn(async () => ({ id: 1 })) }` 并**删除** `session: { create: ... }`、`message: { create: vi.fn() }` 两键——去会话化后 executor 不再触碰这两表，删除后任何残留调用会以 undefined 崩掉被用例捕获）

```ts
describe("图执行留痕去会话化", () => {
  it("全程零 session/message 写入，节点行落 graphRunNode", async () => {
    const result = await runGraphToResult({
      graph,
      task: null,
      inputs: { topic: "x" },
      triggerType: "manual",
      attempt: 1,
      abort: undefined,
      workspace: { id: 1, directoryPath: null },
    });
    expect(result.status).toBe("success");
    const prismaMock = vi.mocked(prisma);
    // 会话/消息零写入（mock 已删两键，此处断言兜底防回归）
    expect(prismaMock.session?.create).toBeUndefined();
    expect(prismaMock.message?.create).toBeUndefined();
    // 节点行：research 节点一条 success，input 为渲染后 prompt
    const creates = vi.mocked(prisma.graphRunNode.create).mock.calls;
    const research = creates.find(
      (c) => (c[0] as { data: { nodeId: string } }).data.nodeId === "research",
    );
    expect(research).toBeDefined();
    expect(research![0]).toMatchObject({
      data: {
        runId: 9,
        status: "success",
        input: "调研 x",
        output: "agent-done",
      },
    });
  });

  it("单节点测试不建会话：返回值照常", async () => {
    const { testSingleNode } = await import(
      "../../electron/domains/ai/orchestration/graph-executor"
    );
    const res = await testSingleNode({
      node: {
        id: "n1",
        name: "代码",
        kind: "code",
        language: "nodejs",
        code: "return 1+1",
      },
      inputs: {},
      nodes: {},
      workspace: { id: 1, directoryPath: null },
      userId: 1,
    });
    expect(res.ok).toBe(true);
  });
});
```

（`runGraphToResult` 既有导出；graph 夹具用文件内已有 `graph` 常量；testSingleNode 的 node 形状以 `packages/tianshu-core/src/graph-schema.ts` 的 code 节点校验为准，跑挂时按校验错误修夹具字段。）

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run tests/ai/graph-executor.test.ts`
Expected: FAIL（graphRunNode.create 未被调用 / session.create 仍被调用）。

- [ ] **Step 3: 实现改造**（全部在同文件，按序）：

1. **删 `createGraphSession`**（:468-488 整函数）。
2. **`runGraph`（:343-344）**：`const sessionId = await createGraphSession(params, json);` 删除；`buildNodeContext(params, deps, sessionId)` 改为 `buildNodeContext(params, deps, runId)`（runId 是 runGraph 第 4 参，已在作用域内）；`base` 对象（:371）`sessionId` 字段删除，`finishRun` 的 `FinishParams.sessionId` 字段与 `:1790` 落库行删除（graph 路径不再写 sessionId——schema 列保留）。
3. **`buildNodeContext`（:490-521）**：签名 `sessionId: number` → `runId: number | null`；返回对象 `sessionId` 字段删、加 `runId`；`buildAgentContext(params, sessionId, workspacePath)` → `buildAgentContext(params, workspacePath)`（内部 `sessionId` 字段删——AgentStreamOptions.sessionId 已可空，不传即 undefined，**显式写 `sessionId: null`** 保持明确）。
4. **`writeNodeMessages`（:1616-1635）→ `writeNodeRecord`**：

```ts
/** 节点执行详情落库（去会话化 2026-10-28）：Coze 式运行记录——节点
 * 完整输入/输出落 graphRunNode（单节点测试 runId=null 不落，对齐 Coze
 * 即席试跑）；input/output 截 64KB 对齐 code 节点输出上限 */
const NODE_IO_LIMIT = 64 * 1024;
const clipNodeIo = (text: string) => text.slice(0, NODE_IO_LIMIT);

interface NodeRecordExtra {
  usage?: { promptTokens: number; completionTokens: number };
  toolCalls?: Array<{ name: string; ok: boolean; durationMs: number }>;
  outputImage?: string;
  fallback?: { code: string; message: string };
  errorOutput?: string;
}

function nodeRecordData(
  ctx: NodeContext,
  node: GraphNode,
  status: "success" | "failed",
  input: string,
  output: string,
  startedAt: number,
  extra: NodeRecordExtra,
) {
  return {
    data: {
      runId: ctx.runId as number,
      nodeId: node.id,
      nodeName: node.name,
      status,
      input: clipNodeIo(input),
      output: clipNodeIo(output),
      toolCallsJson: extra.toolCalls
        ? JSON.stringify(extra.toolCalls)
        : null,
      promptTokens: extra.usage?.promptTokens,
      completionTokens: extra.usage?.completionTokens,
      durationMs: Date.now() - startedAt,
      startedAt: new Date(startedAt).toISOString(),
      outputImage: extra.outputImage,
      errorOutput: extra.errorOutput ? clipNodeIo(extra.errorOutput) : null,
      fallbackJson: extra.fallback ? JSON.stringify(extra.fallback) : null,
    },
  };
}

async function writeNodeRecord(
  ctx: NodeContext,
  node: GraphNode,
  input: string,
  output: string,
  startedAt: number,
  extra: NodeRecordExtra = {},
): Promise<void> {
  if (ctx.runId === null) return; // 单节点测试即席，不留痕
  await prisma.graphRunNode.create(nodeRecordData(ctx, node, "success", input, output, startedAt, extra));
}
```

5. **`writeNodeFailure`（:1637-1662）→ `writeNodeFailureRecord`**：同构（status="failed"、output=失败全貌 `${code}: ${message}` + detail、`errorJson: JSON.stringify({ code: failure.code, message: failure.message, toolName: failure.toolName, detail: failure.detail })`）；`nodeLabel`/`userMessageData`（:1600-1614）删除。
6. **全调用点改名与实参对齐**（`grep -n "writeNodeMessages\|writeNodeFailure" electron/domains/ai/orchestration/graph-executor.ts` 全量复核；已知点位）：
   - :654 `writeNodeMessages(ctx, node, prompt, done.output, startedAt)` → `writeNodeRecord(ctx, node, prompt, done.output, startedAt, done)`（done 含 usage/toolCalls，NodeRecordExtra 结构兼容——字段缺省即 undefined）
   - :665 降级分支 → `writeNodeRecord(ctx, node, prompt, output, startedAt, { fallback })`（fallback 变量在作用域内）
   - :672 → `writeNodeFailureRecord(ctx, node, prompt, failure, startedAt)`
   - :955/:960 code 节点、:1021/:1032 http 节点、:1863 fileRead → 同名替换（实参顺序不变）
   - 其余调用点（imageGen/iterate/notify/subflow 等，grep 兜底全量）→ 同名替换；imageGen 传 `{ outputImage }`、iterate 传 `{ errorOutput }`（变量名以现场为准，语义即「trace 同名字段」）
7. **`testSingleNode`（:3385-3450）**：删 :3394-3403 的 `firstLlm`/`prisma.session.create` 段与 `session.id` 引用；`buildNodeContext` 第三参改传 `null`；函数头注释「消息对落临时会话」改为「即席执行不留痕（Coze 式）」。
8. **`recordGraphMonitorEvents` 调用（:1777）**：`sessionId: p.sessionId` 改为 `sessionId: null`（FinishParams.sessionId 已删）。

- [ ] **Step 4: 跑测试验证通过**

Run: `npx vitest run tests/ai/graph-executor.test.ts`
Expected: PASS（含既有用例——若既有用例断言 session.create/message.create 被调用，按新语义改断言为「零调用/键已删」）。

- [ ] **Step 5: 类型检查 + 全量相关回归**

Run: `npm run typecheck && npx vitest run tests/ai/`
Expected: 无类型错误；tests/ai/ 全 PASS。

- [ ] **Step 6: 提交**

```bash
git add electron/domains/ai/orchestration/graph-executor.ts tests/ai/graph-executor.test.ts
git commit -m "feat(graph): 执行留痕去会话化——删 createGraphSession 与节点消息对，节点收口改落 graphRunNode（runId null 即席不落）；testSingleNode 即席化；monitor 埋点 sessionId 置 null"
```

---

### Task 4: 存量图运行会话清理（启动幂等）

**Files:**
- Modify: `electron/commons/prisma-client.ts`（新增 cleanupGraphRunSessions）
- Modify: `electron/Application.ts`（启动序列串入，在 ensureGraphRunNodeTable 之后）
- Test: `tests/commons/cleanup-graph-run-sessions.test.ts`（新建）

**Interfaces:**
- Consumes: 无（仅 automationRun/session/message 表，均已存在）。
- Produces: `cleanupGraphRunSessions(): Promise<void>`。

- [ ] **Step 1: 写失败测试**（替身法全 mock）

```ts
// tests/commons/cleanup-graph-run-sessions.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`) },
}));

const prismaMock = {
  automationRun: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  message: { deleteMany: vi.fn() },
  session: { deleteMany: vi.fn() },
};
vi.mock("../../electron/commons/prisma-client", () => ({
  default: prismaMock,
  ensureGraphRunNodeTable: vi.fn(),
}));

import { cleanupGraphRunSessions } from "../../electron/commons/prisma-client";

describe("cleanupGraphRunSessions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("图运行会话连带消息删除、run.sessionId 置 null", async () => {
    prismaMock.automationRun.findMany.mockResolvedValue([
      { sessionId: 11 },
      { sessionId: 12 },
    ]);
    await cleanupGraphRunSessions();
    expect(prismaMock.message.deleteMany).toHaveBeenCalledWith({
      where: { sessionId: { in: [11, 12] } },
    });
    expect(prismaMock.session.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [11, 12] } },
    });
    expect(prismaMock.automationRun.updateMany).toHaveBeenCalledWith({
      where: { graphId: { not: null }, sessionId: { not: null } },
      data: { sessionId: null },
    });
  });

  it("无待清数据时零删除（幂等二跑）", async () => {
    prismaMock.automationRun.findMany.mockResolvedValue([]);
    await cleanupGraphRunSessions();
    expect(prismaMock.message.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.session.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.automationRun.updateMany).not.toHaveBeenCalled();
  });
});
```

（prompt 型 run 的 session 不误删由 where 条件保证：findMany 与 updateMany 的 where 均 `graphId: { not: null }`——prompt 型 run graphId 恒 null，不入集合。）

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run tests/commons/cleanup-graph-run-sessions.test.ts`
Expected: FAIL（export 不存在）。

- [ ] **Step 3: 实现**（`electron/commons/prisma-client.ts`，ensureGraphRunNodeTable 之后）

```ts
/**
 * 存量图运行会话清理（去会话化 2026-10-28 一次性迁移）：图 run 产生的
 * 会话+消息删除、run.sessionId 置 null（prompt 型 run graphId 恒 null
 * 不受影响）。幂等：清后判据不再命中。须在 initDatabase 之后调用。
 */
export async function cleanupGraphRunSessions(): Promise<void> {
  const runs = await prisma.automationRun.findMany({
    where: { graphId: { not: null }, sessionId: { not: null } },
    select: { sessionId: true },
    distinct: ["sessionId"],
  });
  const sessionIds = runs
    .map((r) => r.sessionId)
    .filter((id): id is number => id !== null);
  if (sessionIds.length > 0) {
    await prisma.message.deleteMany({
      where: { sessionId: { in: sessionIds } },
    });
    await prisma.session.deleteMany({ where: { id: { in: sessionIds } } });
    await prisma.automationRun.updateMany({
      where: { graphId: { not: null }, sessionId: { not: null } },
      data: { sessionId: null },
    });
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `npx vitest run tests/commons/cleanup-graph-run-sessions.test.ts`
Expected: PASS。

- [ ] **Step 5: Application.ts 串入**（ensureGraphRunNodeTable 之后链式调用）

```ts
    void ensureGraphRunNodeTable()
      .then(() => cleanupGraphRunSessions())
      .catch((e) => console.error("图运行节点表/存量会话清理失败:", e));
```

（替换 Task 1 Step 7 的单独调用；import 追加 cleanupGraphRunSessions。）

- [ ] **Step 6: 回归 + 提交**

Run: `npx vitest run tests/commons/ && npm run typecheck`
Expected: PASS。

```bash
git add electron/commons/prisma-client.ts electron/Application.ts tests/commons/cleanup-graph-run-sessions.test.ts
git commit -m "feat(db): 存量图运行会话启动幂等清理——session+message 删除、graph run sessionId 置 null（prompt 型不受影响）"
```

---

### Task 5: 前端——节点详情下钻 API + GraphRunTraceView 全文展示 + 文案对齐

**Files:**
- Modify: `electron/domains/ai/orchestration/graph.repo.ts:250` 附近（新增 orchestration:runNodes 通道）
- Modify: `src-react/domains/ai/orchestration/api/orchestration.api.ts`（新增 runNodes）
- Modify: `src-react/domains/ai/orchestration/components/GraphRunTraceView.tsx`（行展开下钻）
- Modify: `src-react/domains/ai/automation/components/RunHistoryPanel.tsx:2-5`（头注释对齐新事实）
- Modify: `src-react/i18n/locales/zh-CN/chat.json`、`src-react/i18n/locales/en-US/chat.json`（orchestration.trace 区块补 key）
- Test: `tests/ai/graph-run-nodes-endpoint.test.ts`（新建，repo 通道层）

**Interfaces:**
- Consumes: Task 1 的 graphRunNode 表；Task 3 落库的行结构。
- Produces: IPC `orchestration:runNodes`（入参 `runId: number`，返回 `Array<GraphRunNodeRow>`）；前端 `OrchestrationApi.runNodes(runId)`；`GraphRunNodeRow = { nodeId: string; nodeName: string | null; status: string; input: string | null; output: string | null; errorJson: string | null; ... }`（全字段见 Task 1 表结构，时间字段原样透传 string）。

- [ ] **Step 1: 写失败测试**（通道行为：按 runId 查行 + 非 owner run 拒绝）

```ts
// tests/ai/graph-run-nodes-endpoint.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
const prismaMock = {
  automationRun: {
    findFirst: vi.fn(),
  },
  graphRunNode: {
    findMany: vi.fn(async () => [
      { nodeId: "research", nodeName: "调研", status: "success", input: "调研 x", output: "全文…", errorJson: null, toolCallsJson: null, promptTokens: 3, completionTokens: 5, durationMs: 120, startedAt: "2026-10-28T00:00:00.000Z", outputImage: null, errorOutput: null, fallbackJson: null },
    ]),
  },
  graphDefinition: {},
};
vi.mock("../../electron/commons/prisma-client", () => ({ default: prismaMock }));

import { ipcMain } from "electron";

describe("orchestration:runNodes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("按 runId 查节点行（经图归属校验）", async () => {
    prismaMock.automationRun.findFirst.mockResolvedValue({
      id: 9,
      graphId: 5,
      graph: { userId: 7 },
    });
    const { GraphRepo } = await import(
      "../../electron/domains/ai/orchestration/graph.repo"
    );
    new GraphRepo().registerIpc(); // 若注册方法名不同，以现场为准（grep registerIpc）
    const call = vi.mocked(ipcMain.handle).mock.calls.find(
      (c) => c[0] === "orchestration:runNodes",
    );
    expect(call).toBeDefined();
    const rows = await (call![1] as any)(null, 7, 9);
    expect(rows).toHaveLength(1);
    expect(rows[0].nodeId).toBe("research");
    expect(prismaMock.automationRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 9, graphId: { not: null } }),
      }),
    );
  });

  it("非 owner 或 prompt 型 run → 空数组", async () => {
    prismaMock.automationRun.findFirst.mockResolvedValue(null);
    const { GraphRepo } = await import(
      "../../electron/domains/ai/orchestration/graph.repo"
    );
    new GraphRepo().registerIpc();
    const call = vi.mocked(ipcMain.handle).mock.calls.find(
      (c) => c[0] === "orchestration:runNodes",
    )!;
    const rows = await (call[1] as any)(null, 8, 9);
    expect(rows).toEqual([]);
  });
});
```

（GraphRepo 类名/注册方法名以 `graph.repo.ts` 现场为准——grep `class .*Repo` 与 `handleUser` 所在方法；`graphDefinition` 关联是否可经 include 取，以 schema 关系为准，无 relation 则改两段查询：先查 run 得 graphId，再查 graphDefinition.userId 比对。）

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run tests/ai/graph-run-nodes-endpoint.test.ts`
Expected: FAIL（通道不存在）。

- [ ] **Step 3: 实现通道**（`graph.repo.ts` registerIpc 内 `orchestration:runs` 旁追加；schema 无 relation 时用两段查询）

```ts
    handleUser("orchestration:runNodes", async (_, userId, runId: number) => {
      const run = await prisma.automationRun.findFirst({
        where: { id: runId, graphId: { not: null } },
        select: { graphId: true },
      });
      if (!run?.graphId) return [];
      const graph = await prisma.graphDefinition.findUnique({
        where: { id: run.graphId },
        select: { userId: true },
      });
      if (graph?.userId !== userId && graph?.userId !== null) return [];
      return prisma.graphRunNode.findMany({
        where: { runId },
        orderBy: { id: "asc" },
      });
    });
```

（归属口径对齐 executor 现状：历史 graph 行 userId 可空——null 视为可查，与 createGraphSession 注释「历史 graph 行 userId 可空」一致。）

- [ ] **Step 4: 跑测试验证通过**

Run: `npx vitest run tests/ai/graph-run-nodes-endpoint.test.ts`
Expected: PASS。

- [ ] **Step 5: 前端 API + GraphRunTraceView 下钻**

1. `orchestration.api.ts` 追加（形态对齐同文件既有 invoke 封装）：

```ts
  /** 运行节点详情（去会话化 2026-10-28）：按 runId 拉节点级完整输入/输出 */
  static runNodes(runId: number): Promise<Array<Record<string, unknown>>> {
    return window.ipcRenderer.invoke("orchestration:runNodes", runId);
  },
```

2. `GraphRunTraceView.tsx`：`GraphRunTraceView` 组件签名加 `runId?: number`；`TraceRow` 展开时经 React Query 按 runId 拉取，命中同 nodeId 行时输出区/输入区展示全文（`<pre>` 同现有样式），否则回落 `outputPreview`（老 run 无节点行）。展开逻辑骨架：

```tsx
const { t } = useTranslation(["chat"]);
// 行展开详情全文（去会话化 2026-10-28）：runId 在场（运行历史/弹窗）
// 时按需拉节点行；老 run 无行回落 outputPreview
const { data: nodeRows } = useQuery({
  queryKey: ["orchestration", "runNodes", runId],
  queryFn: () => OrchestrationApi.runNodes(runId!),
  enabled: expanded && runId !== undefined,
  staleTime: Infinity,
});
const full = nodeRows?.find((r) => r.nodeId === entry.id) as
  | { input: string | null; output: string | null }
  | undefined;
```

`TraceDetail` 增加入参 `full`；`entry.outputImage` 优先级不变（图片渲染在前）；文本区 `full?.output ?? entry.outputPreview`，`full?.input` 有值时输出区上方加「输入」块。**注意**：单节点测试等无 runId 场景 `runId` 不传，维持纯预览渲染。
3. 调用方（`GraphRunHistoryDialog.tsx:196`、`RunHistoryView.tsx:194`）给 `<GraphRunTraceView>` 传 `runId={run.id}`。
4. `RunHistoryPanel.tsx:2-5` 头注释改：「graph run(graphId,去会话化后无 sessionId)弹工作流运行历史弹窗」——现状注释本来就是这么写的，去会话化后重新成立，仅补一句「2026-10-28 去会话化：executor 不再落 sessionId，节点详情走 graphRunNode」。

- [ ] **Step 5.5: 删 run/删图路径级联删节点行**（spec §3.1：删 run 时级联删 graphRunNode）

Run: `grep -rn "automationRun.deleteMany\|automationRun.delete" electron/ --include="*.ts" | grep -v test`
按命中点（预期在 `graph.repo.ts` 删图路径与 executor 在途删 run 路径）逐一在删 run 的同一事务段补：

```ts
await prisma.graphRunNode.deleteMany({ where: { runId: <被删runId> } });
// 删图批量路径（按 graphId 删 run 的场景）：
await prisma.graphRunNode.deleteMany({
  where: { runId: { in: runIds } },
});
```

（以现场变量名为准；原则：run 行删除前/同段内，其节点行必须连带删除，避免孤儿行。）

- [ ] **Step 6: i18n 补 key**（zh-CN 与 en-US 的 chat.json `orchestration.trace` 区块同步）

zh-CN：`"input": "输入"`、`"outputFull": "完整输出"`
en-US：`"input": "Input"`、`"outputFull": "Full output"`
（`orchestration.trace.output` 已有，输入块用新 key `orchestration.trace.input`。）

- [ ] **Step 7: 类型检查 + 回归**

Run: `npm run typecheck && npx vitest run tests/ai/ && npx prettier --check src-react/domains/ai/orchestration src-react/domains/ai/automation electron/domains/ai/orchestration/graph.repo.ts`
Expected: 全过。

- [ ] **Step 8: 提交**

```bash
git add electron/domains/ai/orchestration/graph.repo.ts src-react/domains/ai/orchestration src-react/domains/ai/automation/components/RunHistoryPanel.tsx src-react/i18n/locales/zh-CN/chat.json src-react/i18n/locales/en-US/chat.json tests/ai/graph-run-nodes-endpoint.test.ts
git commit -m "feat(ui): 节点详情下钻——orchestration:runNodes 通道 + GraphRunTraceView 展开查 graphRunNode 全文（老 run 回落预览）+ i18n"
```

---

### Task 6: server 侧同批同步（apps/tianshu-server）+ drift 复核

**Files:**
- Modify: `apps/tianshu-server/prisma/schema.prisma`（graphRunNode 模型，@map/@@@map 惯例对齐该文件既有模型）
- Create: `apps/tianshu-server/prisma/migrations/<ts>_add_graph_run_node/migration.sql`（经 prisma migrate dev 生成）
- Modify: `apps/tianshu-server/src/core/graph/graph-executor.ts`（Task 3 同款改动——**逐条对齐**：删 createGraphSession、NodeContext sessionId→runId、writeNodeRecord/writeNodeFailureRecord、testSingleNode 即席化、monitor sessionId null）
- Test: `apps/tianshu-server/test/core/graph-executor.spec.ts`（既有 Jest 文件同步断言：零 session/message、graphRunNode 落行）

**Interfaces:**
- Consumes: Task 3 的 `writeNodeRecord`/`writeNodeFailureRecord`/`NodeRecordExtra` 定义（签名逐字一致，drift 容差内）。
- Produces: server 侧库表与执行行为与 mirror 同构；无新对外接口（graphRunNode 不透出移动端——spec §5）。

- [ ] **Step 1: schema + migration**

`apps/tianshu-server/prisma/schema.prisma` 追加模型（字段同 Task 1；`@@map("graphRunNode")` 对齐该文件 automationRun 的 @@@map 惯例）：

```prisma
model GraphRunNode {
  id               Int     @id @default(autoincrement())
  runId            Int
  nodeId           String
  nodeName         String?
  status           String
  input            String?
  output           String?
  errorJson        String?
  toolCallsJson    String?
  promptTokens     Int?
  completionTokens Int?
  durationMs       Int
  startedAt        String
  outputImage      String?
  errorOutput      String?
  fallbackJson     String?

  @@unique([runId, nodeId])
  @@index([runId])
  @@map("graphRunNode")
}
```

Run: `cd apps/tianshu-server && npx prisma migrate dev --name add_graph_run_node && npx prisma generate`
Expected: migration 目录新增、client 生成、本地 local.db 应用成功。

- [ ] **Step 2: server 执行器同步改动**（对 mirror 侧 Task 3 Step 3 的 8 条逐条镜像；server 侧 prisma import 路径不同（`db-client.ts`），方法名一致）。同步后 diff 校验：

Run: `node -e "const {execSync}=require('child_process');const a=execSync('grep -c \"writeNodeRecord\" /Users/hjx/workspace/mirror/electron/domains/ai/orchestration/graph-executor.ts').toString();const b=execSync('grep -c \"writeNodeRecord\" /Users/hjx/workspace/mirror/apps/tianshu-server/src/core/graph/graph-executor.ts').toString();console.log('mirror:',a.trim(),'server:',b.trim())"`
Expected: 两数一致。

- [ ] **Step 3: server 测试同步**（`graph-executor.spec.ts` 对齐 mirror 侧 Task 3 用例语义：mock prisma 加 graphRunNode.create、删 session/message 两键、断言零调用+节点行落库）

Run: `cd apps/tianshu-server && npx jest test/core/graph-executor.spec.ts`
Expected: PASS。

- [ ] **Step 4: drift 复核**

Run: `npm run check:drift`
Expected: exit 0（graph-executor 双份同批同改，差异行数应在容差内；若因行号/注释差异超容差，核算差异行数合理性后 `npm run check:drift -- --rebase` 并人工复核 diff 全部为本次有意变更）。

- [ ] **Step 4.5: server-face runPage 透传核对**（spec §5：graph run sessionId 置 null 后透传面无破坏）

Run: `grep -rn "sessionId" electron/domains/server-face/*.ts | grep -iv "chat\|approval" | head`
Expected: runPage/automation 产出路径中 sessionId 均为 automationRun 行透传（graph run 置 null 后自动 null，协议 `AutomationRunRecord.sessionId?` 可选兼容）——若发现对 sessionId 做非空假设的分支（如 `sessionId!` 非空断言参与 graph run 逻辑），记录并改为空值容忍。

- [ ] **Step 5: server 侧回归 + 提交**

Run: `cd apps/tianshu-server && npm test`
Expected: PASS。

```bash
git add apps/tianshu-server/prisma apps/tianshu-server/src/core/graph/graph-executor.ts apps/tianshu-server/test/core/graph-executor.spec.ts
git commit -m "feat(server): 图执行去会话化同批同步——graphRunNode 表(migrate) + executor 删会话/节点行落库 + spec 断言对齐（drift 复核通过）"
```

---

### Task 7: 全量验收

**Files:** 无新增（纯验证 + 手工冒烟指引）

- [ ] **Step 1: 全量自动化**

Run: `npm run typecheck && npx vitest run && npx prettier --check $(git diff --name-only main~6 | grep -E '\.(ts|tsx)$' | tr '\n' ' ') && npm run check:drift`
Expected: 全 PASS（prettier 只查本批 6 个提交动过的 ts/tsx）。

- [ ] **Step 2: 冒烟指引（用户亲自起 dev，参照记忆「未经允许不启动服务」）**

告知用户验证点：
1. `npm run dev` 后跑一张纯 code 节点图 → 会话列表**无新会话**；运行历史弹窗节点行展开见完整输入/输出
2. 跑一张含 LLM 节点图 → 同上；监控页 graph 场景事件照常
3. prompt 型定时任务跑一轮 → 会话列表照常出现（不回归）
4. 单节点测试 → 面板出结果、会话列表无「单节点测试 · xxx」
5. 存量清理：升级启动一次后，旧图运行会话从列表消失

- [ ] **Step 3: 收尾提交（如有验收修复）**

```bash
git add -A ':!apply-fix.mjs'
git commit -m "fix(graph): 验收修复——<按实际>"
```

（`apply-fix.mjs` 为仓内既有未跟踪文件，不属于本批，恒排除。）
