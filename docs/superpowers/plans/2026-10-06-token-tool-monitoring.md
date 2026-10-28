# Token 消耗与工具调用监控 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 AI 模块全场景（chat/graph/automation）建立 LLM token 用量与工具调用的事件采集、聚合查询和监控页面。

**Architecture:** 两张新事件表（`llmCallEvent`/`toolCallEvent`，启动幂等补建不走 v1 快照）+ 4 个 fire-and-forget 埋点（chat 落库、automation 落库、runToolCall 计时、graph 收尾）+ findMany 读回纯函数聚合（automation-stats 同构）+ `monitor:stats` IPC + `/module/ai/monitor` 监控页。

**Tech Stack:** Electron 主进程 TypeScript、Prisma 7 + better-sqlite3、React 19 + React Query + Zustand、react-i18next、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-06-token-tool-monitoring-design.md`（本计划从 spec 推导，执行者需同时阅读 spec）

## Global Constraints

- 工作区已有他人未提交改动（`git status` 大量 M）：**每次 commit 只 `git add` 本任务清单内的文件**，绝不 `git add -A`/`git add .`
- 埋点一律 fire-and-forget（调用方 `void` 前缀不 await）+ catch 吞错 + `Log.warn`，绝不影响主流程
- i18n：新增用户可见文案全部走 `t()`，key 放 `chat` namespace（`chat:sidebar.monitor`、`chat:monitor.*`），zh-CN 与 en-US **两个文件同步添加**；禁止 JSX/JS 硬编码中英文
- 样式：颜色只用主题变量（`bg-primary`/`text-muted-foreground`/`bg-destructive` 等），禁止 `bg-blue-*` 等硬编码色类；卡片边框 `border-border/50 rounded-lg`
- 变量 `camelCase`、文件名 `kebab-case`；函数 ≤20 行、单一职责；重复 ≥2 次抽函数
- 单测命令：`npx vitest run <file>`；全量 `npm run test`；类型检查 `npm run typecheck`；两者必须全绿才 commit
- 所有 `import prisma` 指默认导出单例：`import prisma from "../../commons/prisma-client"`（主进程文件，按相对层级调整）
- 代码注释风格：中文、说明「为什么」、引用 spec 章节（参照仓库现有注释）

---

### Task 1: 数据表——schema、幂等建表、保留期、启动接线

**Files:**
- Modify: `prisma/schema.prisma`（文件末尾追加）
- Modify: `electron/commons/prisma-client.ts`（新增 ensureMonitorTables、扩展 ensureEventStatMaintenance）
- Modify: `electron/Application.ts`（execute 中接线；import 块约 51 行附近）
- Modify: `electron/infrastructure/script/v1/upgrade-table.sql`（末尾注释）
- Create: `tests/ai/monitor-table.test.ts`
- Generate: `npx prisma generate` 产出 `electron/generated/prisma/*`

**Interfaces:**
- Consumes: 无（首任务）
- Produces: prisma 客户端 `prisma.llmCallEvent` / `prisma.toolCallEvent` delegate（后续任务依赖）；`ensureMonitorTables(): Promise<void>`（prisma-client.ts 导出）

- [ ] **Step 1: schema 追加两 model**

在 `prisma/schema.prisma` 文件末尾（`vectorChunk` model 之后）追加：

```prisma

// 监控事件表（token/工具监控）：不走 v1 快照，实际建表由
// ensureMonitorTables 启动幂等补建（artifact 先例）
model llmCallEvent {
  id           Int      @id @default(autoincrement())
  userId       Int? // v12 多用户隔离
  scene        String // chat | graph | automation
  modelId      Int? // chat/automation 有；graph 场景恒 null（trace 无 modelId）
  sessionId    Int? // chat/automation 会话
  graphId      Int? // graph 场景
  inputTokens  Int
  outputTokens Int
  durationMs   Int? // 流式轮次耗时
  createdAt    DateTime @default(now())

  @@index([userId, createdAt]) // 聚合主查询路径
}

model toolCallEvent {
  id         Int      @id @default(autoincrement())
  userId     Int?
  scene      String // chat | graph | automation
  toolName   String
  state      String // done | denied | error
  durationMs Int?
  sessionId  Int?
  createdAt  DateTime @default(now())

  @@index([userId, createdAt])
  @@index([userId, toolName]) // 工具排行分组
}
```

- [ ] **Step 2: 重新生成 Prisma Client**

Run: `npx prisma generate`
Expected: 输出 `Generated Prisma Client` 无报错；`electron/generated/prisma/models.ts` 等文件出现 llmCallEvent/toolCallEvent 字样（`grep -l llmCallEvent electron/generated/prisma/*.ts` 有结果）

- [ ] **Step 3: 写 ensureMonitorTables + 保留期扩展**

`electron/commons/prisma-client.ts`：在 `ensureArtifactTable` 之后新增函数（照其格式），并给 `ensureEventStatMaintenance` 补两表裁剪：

```ts
/**
 * 监控事件表建表（token/工具监控 spec §3.2）：启动幂等补建，不走 v1
 * 快照（指纹变化会触发旧库 drop 重建）。须在 initDatabase 之后调用。
 */
export async function ensureMonitorTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS llmCallEvent (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      userId INTEGER,
      scene TEXT NOT NULL,
      modelId INTEGER,
      sessionId INTEGER,
      graphId INTEGER,
      inputTokens INTEGER NOT NULL,
      outputTokens INTEGER NOT NULL,
      durationMs INTEGER,
      createdAt DATETIME NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS toolCallEvent (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      userId INTEGER,
      scene TEXT NOT NULL,
      toolName TEXT NOT NULL,
      state TEXT NOT NULL,
      durationMs INTEGER,
      sessionId INTEGER,
      createdAt DATETIME NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(
    "CREATE INDEX IF NOT EXISTS llmCallEvent_userId_createdAt_idx ON llmCallEvent (userId, createdAt)",
  );
  await prisma.$executeRawUnsafe(
    "CREATE INDEX IF NOT EXISTS toolCallEvent_userId_createdAt_idx ON toolCallEvent (userId, createdAt)",
  );
  await prisma.$executeRawUnsafe(
    "CREATE INDEX IF NOT EXISTS toolCallEvent_userId_toolName_idx ON toolCallEvent (userId, toolName)",
  );
}
```

`ensureEventStatMaintenance` 函数体末尾（两行 deleteMany 之后）追加：

```ts
  await prisma.llmCallEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  await prisma.toolCallEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
```

- [ ] **Step 4: Application.ts 接线**

`electron/Application.ts`：import 块（`ensureArtifactTable` 导入处）补 `ensureMonitorTables`；`execute()` 中 `ensureArtifactTable` 调用之后追加：

```ts
    void ensureMonitorTables().catch((e) =>
      console.error("监控事件表建表失败:", e),
    );
```

- [ ] **Step 5: upgrade-table.sql 注释**

`electron/infrastructure/script/v1/upgrade-table.sql` 末尾追加一行注释（该文件是 SQL，用 `--`）：

```sql
-- llmCallEvent / toolCallEvent（token/工具监控）：不走本脚本，实际建表由
-- ensureMonitorTables 启动幂等补建（electron/commons/prisma-client.ts）
```

- [ ] **Step 6: 写建表单测（照 artifact-table.test.ts 模式）**

先读 `tests/ai/artifact-table.test.ts` 学习其 prisma 模块 mock / executeRaw 捕获建法（它测的 `ensureArtifactTable` 与本函数同构，直接复用其 mock 骨架与变量命名）。创建 `tests/ai/monitor-table.test.ts`，断言目标（捕获 `$executeRawUnsafe` 全部调用后）：

```ts
import { describe, expect, it } from "vitest";
// 顶部 mock 基建照抄 artifact-table.test.ts（含其 prisma mock 与捕获数组命名）

describe("ensureMonitorTables", () => {
  it("建两张表 + 三条索引，全部幂等 IF NOT EXISTS", async () => {
    const { ensureMonitorTables } = await import(
      "../../electron/commons/prisma-client"
    );
    await ensureMonitorTables();
    const sqls = executeRawCalls.map((s: unknown) => String(s));
    expect(sqls.filter((s) => s.includes("CREATE TABLE IF NOT EXISTS llmCallEvent"))).toHaveLength(1);
    expect(sqls.filter((s) => s.includes("CREATE TABLE IF NOT EXISTS toolCallEvent"))).toHaveLength(1);
    expect(sqls.filter((s) => s.includes("CREATE INDEX IF NOT EXISTS"))).toHaveLength(3);
  });
});
```

（`executeRawCalls` 为 artifact-table.test.ts 中捕获数组的实际命名——以该文件为准对齐）同时补一个 `ensureEventStatMaintenance` 用例：mock prisma 提供 `skillStat/automationStat/llmCallEvent/toolCallEvent` 的 `deleteMany` spy，断言四表各被裁剪一次且 `where.createdAt` 为 `{ lt: <cutoff> }`（cutoff ≈ 90 天前，用 `expect.objectContaining` 宽松断言）。

- [ ] **Step 7: 跑测试**

Run: `npx vitest run tests/ai/monitor-table.test.ts tests/ai/artifact-table.test.ts`
Expected: 全部 PASS（artifact-table 回归不受影响）

- [ ] **Step 8: typecheck**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma electron/commons/prisma-client.ts electron/Application.ts electron/infrastructure/script/v1/upgrade-table.sql tests/ai/monitor-table.test.ts electron/generated/prisma
git commit -m "feat(monitor): llmCallEvent/toolCallEvent 事件表幂等建表与保留期裁剪"
```

（`electron/generated/prisma` 为 Prisma 生成产物，整目录带入；不要 add 其他文件）

---

### Task 2: monitor-events.ts——埋点写入与 graph 事件构建纯函数

**Files:**
- Create: `electron/domains/ai/monitor/monitor-events.ts`
- Create: `tests/ai/monitor-events.test.ts`

**Interfaces:**
- Consumes: `MessageBlock`（`import type { MessageBlock } from "../chat/blocks"`，已存在的导出类型）
- Produces（后续任务全部依赖，签名必须一字不差）:

```ts
export type MonitorScene = "chat" | "graph" | "automation";
export interface LlmCallEventInput {
  userId?: number | null;
  scene: MonitorScene;
  modelId?: number | null;
  sessionId?: number | null;
  graphId?: number | null;
  inputTokens: number;
  outputTokens: number;
  durationMs?: number | null;
}
export interface ToolCallEventInput {
  userId?: number | null;
  scene: MonitorScene;
  toolName: string;
  state: "done" | "denied" | "error";
  durationMs?: number | null;
  sessionId?: number | null;
}
export function usageFromBlocks(
  blocks: MessageBlock[],
): { input: number; output: number } | null;
export async function recordLlmCall(
  prisma: LlmCallPrismaLike | undefined,
  event: LlmCallEventInput,
): Promise<void>;
export async function recordToolCall(
  prisma: ToolCallPrismaLike | undefined,
  event: ToolCallEventInput,
): Promise<void>;
export function buildGraphMonitorEvents(input: {
  graphId: number;
  userId?: number | null;
  sessionId?: number | null;
  trace: GraphTraceLike[];
}): { llm: LlmCallEventInput[]; tools: ToolCallEventInput[] };
export async function recordGraphMonitorEvents(
  prisma: (LlmCallPrismaLike & ToolCallPrismaLike) | undefined,
  input: Parameters<typeof buildGraphMonitorEvents>[0],
): Promise<void>;
```

- [ ] **Step 1: 写失败测试**

创建 `tests/ai/monitor-events.test.ts`：

```ts
// monitor-events 单测：写入载荷、吞错、缺席跳过（skill-stats 先例）、
// usageFromBlocks 提取、buildGraphMonitorEvents trace → 事件映射
import { describe, expect, it, vi } from "vitest";
import {
  buildGraphMonitorEvents,
  recordLlmCall,
  recordToolCall,
  usageFromBlocks,
} from "../../electron/domains/ai/monitor/monitor-events";

/** 捕获型 prisma stub（skill-stats.test 同款思路） */
function capturePrisma() {
  const calls = { llm: [] as unknown[], tools: [] as unknown[] };
  return {
    calls,
    llmCallEvent: {
      create: vi.fn(async (args: { data: unknown }) => {
        calls.llm.push(args.data);
      }),
    },
    toolCallEvent: {
      create: vi.fn(async (args: { data: unknown }) => {
        calls.tools.push(args.data);
      }),
    },
  };
}

describe("recordLlmCall/recordToolCall", () => {
  it("写入载荷字段完整、scene 透传", async () => {
    const p = capturePrisma();
    await recordLlmCall(p, {
      userId: 7, scene: "chat", modelId: 3, sessionId: 11,
      inputTokens: 100, outputTokens: 40, durationMs: 1200,
    });
    expect(p.calls.llm).toEqual([
      { userId: 7, scene: "chat", modelId: 3, sessionId: 11, inputTokens: 100, outputTokens: 40, durationMs: 1200 },
    ]);
    await recordToolCall(p, {
      userId: 7, scene: "graph", toolName: "write_file", state: "done", durationMs: 300, sessionId: 2,
    });
    expect(p.calls.tools).toEqual([
      { userId: 7, scene: "graph", toolName: "write_file", state: "done", durationMs: 300, sessionId: 2 },
    ]);
  });

  it("prisma 缺席静默跳过（不抛错）", async () => {
    await expect(
      recordLlmCall(undefined, { scene: "chat", inputTokens: 1, outputTokens: 1 }),
    ).resolves.toBeUndefined();
    await expect(
      recordToolCall(undefined, { scene: "chat", toolName: "t", state: "done" }),
    ).resolves.toBeUndefined();
  });

  it("写库异常吞掉不外抛", async () => {
    const broken = {
      llmCallEvent: { create: vi.fn(async () => { throw new Error("db down"); }) },
      toolCallEvent: { create: vi.fn(async () => { throw new Error("db down"); }) },
    };
    await expect(
      recordLlmCall(broken, { scene: "chat", inputTokens: 1, outputTokens: 1 }),
    ).resolves.toBeUndefined();
    await expect(
      recordToolCall(broken, { scene: "chat", toolName: "t", state: "done" }),
    ).resolves.toBeUndefined();
  });
});

describe("usageFromBlocks", () => {
  it("取 usage 块；缺失返回 null（错误轮次/中止不产出 usage）", () => {
    expect(
      usageFromBlocks([
        { type: "text", text: "hi" },
        { type: "usage", input: 12, output: 5 },
      ]),
    ).toEqual({ input: 12, output: 5 });
    expect(usageFromBlocks([{ type: "text", text: "hi" }])).toBeNull();
  });
});

describe("buildGraphMonitorEvents", () => {
  it("带 tokens 节点 → llm 事件；toolCalls → 工具事件（ok→done / !ok→error）", () => {
    const { llm, tools } = buildGraphMonitorEvents({
      graphId: 9, userId: 7, sessionId: 4,
      trace: [
        { name: "n1", durationMs: 500, tokens: { promptTokens: 20, completionTokens: 8 } },
        {
          name: "n2", durationMs: 300,
          toolCalls: [
            { name: "write_file", ok: true, durationMs: 120 },
            { name: "run_command", ok: false, durationMs: 60 },
          ],
        },
        { name: "n3", durationMs: 10 },
      ],
    });
    expect(llm).toEqual([
      { userId: 7, scene: "graph", modelId: null, sessionId: 4, graphId: 9, inputTokens: 20, outputTokens: 8, durationMs: 500 },
    ]);
    expect(tools).toEqual([
      { userId: 7, scene: "graph", toolName: "write_file", state: "done", durationMs: 120, sessionId: 4 },
      { userId: 7, scene: "graph", toolName: "run_command", state: "error", durationMs: 60, sessionId: 4 },
    ]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/monitor-events.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 monitor-events.ts**

```ts
/**
 * 监控埋点（token/工具监控 spec §4）：fire-and-forget 写入、catch +
 * Log.warn 吞错（埋点属可观测性，失败绝不影响主流程）、PrismaLike 缺席
 * （纯函数测试/独立形态）静默跳过——skill-stats 先例同款。
 */
import Log from "../../../commons/Log";
import type { MessageBlock } from "../chat/blocks";

export type MonitorScene = "chat" | "graph" | "automation";

export interface LlmCallEventInput {
  userId?: number | null;
  scene: MonitorScene;
  modelId?: number | null;
  sessionId?: number | null;
  graphId?: number | null;
  inputTokens: number;
  outputTokens: number;
  durationMs?: number | null;
}

export interface ToolCallEventInput {
  userId?: number | null;
  scene: MonitorScene;
  toolName: string;
  state: "done" | "denied" | "error";
  durationMs?: number | null;
  sessionId?: number | null;
}

/** prisma delegate 结构子集（注入 stub/真实客户端均可，skill-stats 先例） */
export interface LlmCallPrismaLike {
  llmCallEvent: {
    create(args: { data: Omit<LlmCallEventInput, "scene"> & { scene: string } }): Promise<unknown>;
  };
}

export interface ToolCallPrismaLike {
  toolCallEvent: {
    create(args: { data: Omit<ToolCallEventInput, "scene"> & { scene: string } }): Promise<unknown>;
  };
}

/** blocks 内 usage 块提取；缺失（错误轮次/中止）返回 null（spec §4.1 #1） */
export function usageFromBlocks(
  blocks: MessageBlock[],
): { input: number; output: number } | null {
  const usage = blocks.find((b): b is Extract<MessageBlock, { type: "usage" }> => b.type === "usage");
  return usage ? { input: usage.input, output: usage.output } : null;
}

export async function recordLlmCall(
  prisma: LlmCallPrismaLike | undefined,
  event: LlmCallEventInput,
): Promise<void> {
  if (!prisma) {
    return;
  }
  try {
    await prisma.llmCallEvent.create({ data: event });
  } catch (e) {
    Log.warn("LLM 用量埋点写入失败", event.scene, e);
  }
}

export async function recordToolCall(
  prisma: ToolCallPrismaLike | undefined,
  event: ToolCallEventInput,
): Promise<void> {
  if (!prisma) {
    return;
  }
  try {
    await prisma.toolCallEvent.create({ data: event });
  } catch (e) {
    Log.warn("工具调用埋点写入失败", event.toolName, e);
  }
}

/** graph trace 行结构子集（TraceEntry 的聚合所需列） */
export interface GraphTraceLike {
  name: string;
  durationMs: number;
  tokens?: { promptTokens: number; completionTokens: number };
  toolCalls?: Array<{ name: string; ok: boolean; durationMs: number }>;
}

/** trace → 监控事件（纯函数，spec §4.1 #4）：带 tokens 节点逐个一行
 * llm 事件（modelId 恒 null：trace 无模型归属），toolCalls 逐条工具事件 */
export function buildGraphMonitorEvents(input: {
  graphId: number;
  userId?: number | null;
  sessionId?: number | null;
  trace: GraphTraceLike[];
}): { llm: LlmCallEventInput[]; tools: ToolCallEventInput[] } {
  const llm: LlmCallEventInput[] = [];
  const tools: ToolCallEventInput[] = [];
  for (const entry of input.trace) {
    if (entry.tokens) {
      llm.push({
        userId: input.userId,
        scene: "graph",
        modelId: null,
        sessionId: input.sessionId,
        graphId: input.graphId,
        inputTokens: entry.tokens.promptTokens,
        outputTokens: entry.tokens.completionTokens,
        durationMs: entry.durationMs,
      });
    }
    for (const call of entry.toolCalls ?? []) {
      tools.push({
        userId: input.userId,
        scene: "graph",
        toolName: call.name,
        state: call.ok ? "done" : "error",
        durationMs: call.durationMs,
        sessionId: input.sessionId,
      });
    }
  }
  return { llm, tools };
}

/** graph 收尾一次性写入（recordLlmCall/recordToolCall 已各自吞错） */
export async function recordGraphMonitorEvents(
  prisma: (LlmCallPrismaLike & ToolCallPrismaLike) | undefined,
  input: Parameters<typeof buildGraphMonitorEvents>[0],
): Promise<void> {
  if (!prisma) {
    return;
  }
  const { llm, tools } = buildGraphMonitorEvents(input);
  await Promise.all([
    ...llm.map((event) => recordLlmCall(prisma, event)),
    ...tools.map((event) => recordToolCall(prisma, event)),
  ]);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ai/monitor-events.test.ts`
Expected: PASS 全绿

- [ ] **Step 5: typecheck + Commit**

Run: `npm run typecheck`（Expected: 无错误）

```bash
git add electron/domains/ai/monitor/monitor-events.ts tests/ai/monitor-events.test.ts
git commit -m "feat(monitor): 埋点写入函数与 graph trace 事件构建纯函数"
```

---

### Task 3: chat 链路埋点——落库提取 + runToolCall 计时

**Files:**
- Modify: `electron/domains/ai/chat/chat.service.ts`
- Create: `tests/ai/monitor-emit-chat.test.ts`

**Interfaces:**
- Consumes: `recordLlmCall`/`recordToolCall`/`usageFromBlocks`（Task 2 签名）；`AgentStreamOptions`（chat.service.ts:147 现有接口）
- Produces: `AgentStreamOptions` 新增两个可选字段（automation 链路 Task 4 依赖）:

```ts
  /** 监控埋点（token/工具监控 spec §4.1 #3）：终态工具事件回调；
   *  缺席（单测）不采集；durationMs 仅执行路径有（denied 无计时） */
  toolStats?: (event: {
    toolName: string;
    state: "done" | "denied" | "error";
    durationMs?: number;
  }) => void;
  /** 监控场景标注：chat 服务传 "chat"、automation 传 "automation"；缺省 "chat" */
  monitorScene?: "chat" | "automation";
```

- [ ] **Step 1: 写失败测试**

先读 `tests/ai/chat.service.test.ts` 中既有 `runToolCall` 用例（`grep -n "runToolCall" tests/ai/chat.service.test.ts` 定位），照抄其 `def`/`agent` stub 写法。创建 `tests/ai/monitor-emit-chat.test.ts`：

```ts
// chat 链路监控埋点单测：runToolCall 终态回调（done/error/denied/aborted 不计）
// 与 usageFromBlocks 落库提取（接线处一行调用，类型由 typecheck 保障）
import { describe, expect, it, vi } from "vitest";
import { runToolCall } from "../../electron/domains/ai/chat/chat.service";
// AgentStreamOptions 若为非导出 stub 困难，则照 chat.service.test.ts 的 agent 构造方式

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 1,
    fullAccess: () => false,
    isToolAllowed: async () => false,
    requestApproval: async () => true,
    ...overrides,
  } as Parameters<typeof runToolCall>[1];
}

function makeDef(execute?: (input: unknown) => Promise<string>) {
  return {
    name: "read_file",
    kind: "read",
    execute: execute ?? (async () => "ok"),
  } as Parameters<typeof runToolCall>[0];
}

describe("runToolCall toolStats 回调", () => {
  it("执行成功 → done + durationMs", async () => {
    const events: unknown[] = [];
    await runToolCall(
      makeDef(async () => "done output"),
      makeAgent({ toolStats: (e) => events.push(e) }),
      "call-1",
      {},
      undefined,
    );
    expect(events).toEqual([
      { toolName: "read_file", state: "done", durationMs: expect.any(Number) },
    ]);
  });

  it("输出以「错误:」开头 → error", async () => {
    const events: unknown[] = [];
    await runToolCall(
      makeDef(async () => "错误: boom"),
      makeAgent({ toolStats: (e) => events.push(e) }),
      "call-2",
      {},
      undefined,
    );
    expect(events).toEqual([
      { toolName: "read_file", state: "error", durationMs: expect.any(Number) },
    ]);
  });

  it("审批拒绝 → denied、无 durationMs", async () => {
    const events: unknown[] = [];
    await runToolCall(
      makeDef(),
      makeAgent({
        requestApproval: async () => false,
        toolStats: (e) => events.push(e),
      }),
      "call-3",
      {},
      undefined,
    );
    expect(events).toEqual([{ toolName: "read_file", state: "denied" }]);
  });

  it("agent 未传 toolStats → 不抛错（缺席静默）", async () => {
    await expect(
      runToolCall(makeDef(), makeAgent(), "call-4", {}, undefined),
    ).resolves.toBeTruthy();
  });
});
```

注意：makeDef/makeAgent 若与真实 `ToolDefinition`/`AgentStreamOptions` 类型不符（缺 decideCommand 等可选字段无碍，必填字段以 chat.service.test.ts 现有 stub 为准），以现有测试的构造为准调整——**先读现有用例再落笔**。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/monitor-emit-chat.test.ts`
Expected: FAIL（toolStats 回调未触发，events 为空）

- [ ] **Step 3: 实现埋点**

`electron/domains/ai/chat/chat.service.ts`：

3a. `AgentStreamOptions`（147 行接口内）追加 `toolStats?` 与 `monitorScene?` 两字段（见 Interfaces，注释照写）。

3b. `runToolCall`（553-727 行）内，各 denied 终态分支（gate "block" 拒绝、unattended 强拒共 4 处 `return ..._OUTPUT;` 之前，即每个 `finalStates?.set(toolCallId, "denied")` 处）与 `awaitApproval` 的 `decision === "denied"` 分支加：

```ts
      agent.toolStats?.({ toolName: def.name, state: "denied" });
```

（`decision === "aborted"` 分支不加——用户中止不计，spec §4.2）

3c. 执行路径（702 行 `state: "running"` chunk 之前）记 `const toolStartedAt = Date.now();`，终态 chunk 处（719-725 行 `state: output.startsWith("错误:") ...` 之后）加：

```ts
  agent.toolStats?.({
    toolName: def.name,
    state: output.startsWith("错误:") ? "error" : "done",
    durationMs: Date.now() - toolStartedAt,
  });
```

（`if (abortSignal?.aborted) return output;` 提前返回处不加——中止不计）

3d. **chat 落库埋点（spec §4.1 #1）**：`appendMessage` 调用之后（chat.service.ts 约 1963 行）加：

```ts
      // 监控埋点（spec §4.1 #1）：落库时提取 usage（H7a 同款「落库时提取」；
      // 错误轮次/中止无 usage 块不写）
      const usage = usageFromBlocks(result.blocks);
      if (usage) {
        void recordLlmCall(prisma, {
          userId,
          scene: "chat",
          modelId: ctx.modelId,
          sessionId,
          inputTokens: usage.input,
          outputTokens: usage.output,
          durationMs: Date.now() - startedAt,
        });
      }
```

import 块加：`import { recordLlmCall, recordToolCall, usageFromBlocks } from "../monitor/monitor-events";`

3e. **agent 组装接线（toolStats → 落库）**：grep 找 chat.service.ts 中构造 agent 对象的位置（`grep -n "fullAccess:" electron/domains/ai/chat/chat.service.ts`，assembleContext 内），在该对象字面量加：

```ts
        monitorScene: "chat",
        toolStats: (e) =>
          void recordToolCall(prisma, {
            ...e,
            scene: "chat",
            userId,
            sessionId,
          }),
```

（闭包内 userId/sessionId 可用性以实际作用域为准；若 agent 在无 userId 的作用域构造，改从 session.userId 取——先读上下文再定）

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npx vitest run tests/ai/monitor-emit-chat.test.ts tests/ai/chat.service.test.ts`
Expected: 全 PASS（chat.service.test.ts 为 52K 大文件回归，必须全绿）

- [ ] **Step 5: typecheck + Commit**

Run: `npm run typecheck`（Expected: 无错误）

```bash
git add electron/domains/ai/chat/chat.service.ts tests/ai/monitor-emit-chat.test.ts
git commit -m "feat(monitor): chat 链路 token/工具埋点（落库提取 + runToolCall 计时）"
```

---

### Task 4: automation 与 graph 链路埋点

**Files:**
- Modify: `electron/domains/ai/automation/automation-runner.ts`（约 369-381 行落库处 + agent 组装约 326-372 行）
- Modify: `electron/domains/ai/orchestration/graph-executor.ts`（`FinishParams` 204 行 + `finishRun` 1637 行 + finishRun 调用方）

**Interfaces:**
- Consumes: `recordLlmCall`/`recordToolCall`/`recordGraphMonitorEvents`（Task 2）；`AgentStreamOptions.toolStats`/`monitorScene`（Task 3）
- Produces: 无（终端埋点任务）

- [ ] **Step 1: automation 落库埋点（spec §4.1 #2）**

`automation-runner.ts`：`const usage = extractUsage(result.blocks);`（约 369 行）与 `prisma.message.create` 之间加：

```ts
  if (usage) {
    // 监控埋点（spec §4.1 #2）：automation prompt 任务落库时提取
    void recordLlmCall(prisma, {
      userId: task.userId ?? undefined,
      scene: "automation",
      modelId: task.modelId,
      sessionId: ctx.sessionId,
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      durationMs: Date.now() - ctx.startedAt,
    });
  }
```

import 加：`import { recordLlmCall, recordToolCall } from "../monitor/monitor-events";`

- [ ] **Step 2: automation agent 接线**

runner 内构造 `agent:` 对象处（约 326 行 `agent: {`，`unattended: true` 同级）加：

```ts
      monitorScene: "automation",
      toolStats: (e) =>
        void recordToolCall(prisma, {
          ...e,
          scene: "automation",
          userId: task.userId ?? undefined,
          sessionId: ctx.sessionId,
        }),
```

- [ ] **Step 3: graph FinishParams 扩展**

`graph-executor.ts:204` `FinishParams` 加两字段：

```ts
  graphId: number;
  userId?: number | null;
```

`grep -n "finishRun(" electron/domains/ai/orchestration/graph-executor.ts` 找全部调用点（含 `await finishRun` 与可能的 `void finishRun`），每处构造参数补 `graphId: <图 id 来源>` 与 `userId:`——调用点作用域内有 `params`/`p`（GraphRunParams，含 `graph: GraphRow` 与 `task`），按作用域实际变量名传 `graphId: <...>.graph.id`、`userId: <...>.task?.userId ?? <...>.graph.userId ?? null`。

- [ ] **Step 4: graph 收尾埋点（spec §4.1 #4）**

`finishRun` 内 `const tokens = sumTokens(p.trace);` 之后加：

```ts
  // 监控埋点（spec §4.1 #4）：trace → 事件一次性写入（内部吞错，不影响收尾）
  void recordGraphMonitorEvents(prisma, {
    graphId: p.graphId,
    userId: p.task?.userId ?? p.graph.userId ?? null,
    sessionId: p.sessionId,
    trace: p.trace,
  });
```

import 加：`import { recordGraphMonitorEvents } from "../monitor/monitor-events";`

注意：`finishRun` 签名是 `(p: FinishParams)`，`p.graph` 不在 FinishParams 里——userId 传参用 `p.task?.userId ?? p.userId ?? null`（Step 3 已把 userId 放进 FinishParams），即埋点处写 `userId: p.task?.userId ?? p.userId ?? null`。

- [ ] **Step 5: 回归测试**

Run: `npx vitest run tests/ai/automation-runner.test.ts tests/ai/graph-executor.test.ts tests/ai/monitor-events.test.ts`
Expected: 全 PASS（buildGraphMonitorEvents 纯函数已由 Task 2 覆盖，本任务接线正确性由既有回归 + typecheck 保障）

- [ ] **Step 6: typecheck + Commit**

Run: `npm run typecheck`（Expected: 无错误——FinishParams 新必填字段 graphId 漏传会在此暴露）

```bash
git add electron/domains/ai/automation/automation-runner.ts electron/domains/ai/orchestration/graph-executor.ts
git commit -m "feat(monitor): automation/graph 链路埋点接线（落库提取 + trace 事件写入）"
```

---

### Task 5: 聚合纯函数 + monitor.repo + IPC

**Files:**
- Create: `src-react/domains/ai/monitor/api/monitor.api.ts`（类型源，后端 import 它——automation-stats 先例）
- Create: `electron/domains/ai/monitor/monitor-stats.ts`
- Create: `electron/domains/ai/monitor/monitor.repo.ts`
- Modify: `electron/commons/ipc-channels.ts`（IPC_INVOKE_ALLOWLIST 加通道）
- Modify: `electron/Application.ts`（registerServices 实例化）
- Create: `tests/ai/monitor-stats.test.ts`

**Interfaces:**
- Consumes: prisma delegate（Task 1）；无前端依赖（本任务自带类型定义）
- Produces（Task 6/7 依赖）:

```ts
// monitor.api.ts
export type MonitorScene = "chat" | "graph" | "automation";
export interface MonitorStats {
  today: {
    inputTokens: number;
    outputTokens: number;
    llmCalls: number;
    toolCalls: number;
    toolSuccessRate: number; // done/(done+denied+error)，分母 0 记 0
  };
  trend: Array<{ date: string; inputTokens: number; outputTokens: number; llmCalls: number; toolCalls: number }>; // 近 7 天含空日补零，旧→新
  byModel: Array<{ modelId: number; name: string; calls: number; inputTokens: number; outputTokens: number }>; // inputTokens 降序
  tools: Array<{ toolName: string; total: number; done: number; denied: number; error: number; avgDurationMs: number | null; successRate: number }>; // total 降序
}
export const MonitorApi = { stats: (scene?: MonitorScene) => invoke<MonitorStats>("monitor:stats", scene) };
```

- [ ] **Step 1: 写失败测试**

创建 `tests/ai/monitor-stats.test.ts`：

```ts
// computeMonitorStats 纯函数单测（automation-stats.test 同风格）：
// 趋势空日补零、今日口径、成功率分母 0 记 0、byModel 跳过 null、排序
import { describe, expect, it } from "vitest";
import { computeMonitorStats } from "../../electron/domains/ai/monitor/monitor-stats";
import type { LlmEventRow, ToolEventRow } from "../../electron/domains/ai/monitor/monitor-stats";

const now = new Date("2026-10-06T15:00:00");

function llmRow(over: Partial<LlmEventRow>): LlmEventRow {
  return { modelId: 1, inputTokens: 0, outputTokens: 0, createdAt: now, ...over };
}
function toolRow(over: Partial<ToolEventRow>): ToolEventRow {
  return { toolName: "t", state: "done", durationMs: null, createdAt: now, ...over };
}

describe("computeMonitorStats", () => {
  it("空数据：今日全 0、趋势 7 天补零、列表空", () => {
    const s = computeMonitorStats([], [], [], now);
    expect(s.today).toEqual({ inputTokens: 0, outputTokens: 0, llmCalls: 0, toolCalls: 0, toolSuccessRate: 0 });
    expect(s.trend).toHaveLength(7);
    expect(s.trend.every((d) => d.llmCalls === 0 && d.toolCalls === 0)).toBe(true);
    expect(s.byModel).toEqual([]);
    expect(s.tools).toEqual([]);
  });

  it("今日聚合 + 趋势按本地日分桶（跨日不串桶）", () => {
    const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
    const s = computeMonitorStats(
      [llmRow({ inputTokens: 10, outputTokens: 4 }), llmRow({ inputTokens: 20, outputTokens: 6, createdAt: yesterday })],
      [toolRow({ state: "done" }), toolRow({ state: "error" }), toolRow({ state: "denied", createdAt: yesterday })],
      [],
      now,
    );
    expect(s.today).toEqual({ inputTokens: 10, outputTokens: 4, llmCalls: 1, toolCalls: 2, toolSuccessRate: 0.5 });
    expect(s.trend[6].llmCalls).toBe(1);
    expect(s.trend[6].toolCalls).toBe(2);
    expect(s.trend[5].llmCalls).toBe(1);
    expect(s.trend[5].toolCalls).toBe(1);
  });

  it("byModel：null modelId 跳过、名字补位 name→modelId→#id、inputTokens 降序", () => {
    const s = computeMonitorStats(
      [
        llmRow({ modelId: 1, inputTokens: 10, outputTokens: 2 }),
        llmRow({ modelId: 2, inputTokens: 50, outputTokens: 5 }),
        llmRow({ modelId: null, inputTokens: 99, outputTokens: 99 }),
      ],
      [],
      [
        { id: 1, name: null, modelId: "gpt-x" },
        { id: 2, name: "主力模型", modelId: "m2" },
      ],
      now,
    );
    expect(s.byModel).toEqual([
      { modelId: 2, name: "主力模型", calls: 1, inputTokens: 50, outputTokens: 5 },
      { modelId: 1, name: "gpt-x", calls: 1, inputTokens: 10, outputTokens: 2 },
    ]);
  });

  it("tools：state 分桶计数、avgDurationMs 忽略 null、total 降序", () => {
    const s = computeMonitorStats(
      [],
      [
        toolRow({ toolName: "a", state: "done", durationMs: 100 }),
        toolRow({ toolName: "a", state: "done", durationMs: 200 }),
        toolRow({ toolName: "a", state: "error", durationMs: null }),
        toolRow({ toolName: "b", state: "done", durationMs: 5 }),
      ],
      [],
      now,
    );
    expect(s.tools[0]).toEqual({ toolName: "a", total: 3, done: 2, denied: 0, error: 1, avgDurationMs: 150, successRate: 2 / 3 });
    expect(s.tools[1].toolName).toBe("b");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/monitor-stats.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 先建 monitor.api.ts（类型源）**

创建 `src-react/domains/ai/monitor/api/monitor.api.ts`：

```ts
// src-react/domains/ai/monitor/api/monitor.api.ts
/**
 * 监控页 API（IPC 封装）+ 统计类型（主进程 monitor-stats 经此 import，
 * automation-stats 先例：类型以前端 api 文件为单一事实源）。
 */
import { invoke } from "@/lib/ipc";

export type MonitorScene = "chat" | "graph" | "automation";

export interface MonitorStats {
  today: {
    inputTokens: number;
    outputTokens: number;
    llmCalls: number;
    toolCalls: number;
    toolSuccessRate: number; // done/(done+denied+error)，分母 0 记 0
  };
  trend: Array<{
    date: string;
    inputTokens: number;
    outputTokens: number;
    llmCalls: number;
    toolCalls: number;
  }>;
  byModel: Array<{
    modelId: number;
    name: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  tools: Array<{
    toolName: string;
    total: number;
    done: number;
    denied: number;
    error: number;
    avgDurationMs: number | null;
    successRate: number;
  }>;
}

export const MonitorApi = {
  stats: (scene?: MonitorScene) => invoke<MonitorStats>("monitor:stats", scene),
};
```

- [ ] **Step 4: 实现 monitor-stats.ts 纯函数**

创建 `electron/domains/ai/monitor/monitor-stats.ts`（口径注释照 automation-stats 风格，`localDateKey` 私有函数照抄 automation-stats.ts:40-44）：

```ts
/**
 * 监控统计纯函数（spec §5.2）：findMany 读回行 → 内存聚合（7 天窗口
 * 本地单机千级，automation-stats computeStats 同构、skill-stats 决策 4
 * 同判词）。口径：成功率 = done/(done+denied+error)（denied 进分母，
 * 与自动化成功率「skipped 不进分母」不同：工具被拒是可观测结果）；
 * byModel 跳过 modelId=null（graph 场景，今日/趋势已含其 token）；
 * 趋势 7 天含空日补零（旧→新）；avgDurationMs 仅非 null 参与均值。
 */
import type { MonitorStats } from "../../../../src-react/domains/ai/monitor/api/monitor.api";

const TREND_DAYS = 7;

/** findMany 产出行（llmCallEvent select 子集） */
export interface LlmEventRow {
  modelId: number | null;
  inputTokens: number;
  outputTokens: number;
  createdAt: Date;
}

/** findMany 产出行（toolCallEvent select 子集） */
export interface ToolEventRow {
  toolName: string;
  state: string;
  durationMs: number | null;
  createdAt: Date;
}

/** model 联查行（名字补位） */
export interface ModelNameRow {
  id: number;
  name: string | null;
  modelId: string;
}

/** 本地日键 yyyy-MM-dd（设备时区，automation-stats 同款） */
function localDateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function emptyTrendDay(date: string): MonitorStats["trend"][number] {
  return { date, inputTokens: 0, outputTokens: 0, llmCalls: 0, toolCalls: 0 };
}

function emptyToolItem(toolName: string): MonitorStats["tools"][number] {
  return { toolName, total: 0, done: 0, denied: 0, error: 0, avgDurationMs: null, successRate: 0 };
}

function withRate(item: MonitorStats["tools"][number], durationSum: number, durationCount: number): MonitorStats["tools"][number] {
  return {
    ...item,
    avgDurationMs: durationCount > 0 ? Math.round(durationSum / durationCount) : null,
    successRate: item.total > 0 ? item.done / item.total : 0,
  };
}

export function computeMonitorStats(
  llmRows: LlmEventRow[],
  toolRows: ToolEventRow[],
  models: ModelNameRow[],
  now: Date,
): MonitorStats {
  // —— 趋势骨架：近 7 天含空日补零（旧→新；automation-stats.ts:51-60 同款）——
  const trend = Array.from({ length: TREND_DAYS }, (_, i) =>
    emptyTrendDay(
      localDateKey(
        new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate() - (TREND_DAYS - 1 - i),
        ),
      ),
    ),
  );
  const trendByDate = new Map(trend.map((day) => [day.date, day]));
  for (const row of llmRows) {
    const bucket = trendByDate.get(localDateKey(row.createdAt));
    if (bucket) {
      bucket.inputTokens += row.inputTokens;
      bucket.outputTokens += row.outputTokens;
      bucket.llmCalls += 1;
    }
  }
  // —— 工具趋势分桶 + 今日成功率分子（denied/error 进分母，spec §5.2）——
  let todayToolDone = 0;
  const todayKey = trend[TREND_DAYS - 1].date;
  for (const row of toolRows) {
    const key = localDateKey(row.createdAt);
    const bucket = trendByDate.get(key);
    if (bucket) {
      bucket.toolCalls += 1;
    }
    if (key === todayKey && row.state === "done") {
      todayToolDone += 1;
    }
  }
  const today = trend[TREND_DAYS - 1];
  // —— byModel：null modelId（graph 场景）跳过，今日/趋势已含其 token ——
  const names = new Map(
    models.map((m) => [m.id, m.name ?? m.modelId ?? `#${m.id}`]),
  );
  const byModelMap = new Map<number, MonitorStats["byModel"][number]>();
  for (const row of llmRows) {
    if (row.modelId === null) {
      continue;
    }
    const item = byModelMap.get(row.modelId) ?? {
      modelId: row.modelId,
      name: names.get(row.modelId) ?? `#${row.modelId}`,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    item.calls += 1;
    item.inputTokens += row.inputTokens;
    item.outputTokens += row.outputTokens;
    byModelMap.set(row.modelId, item);
  }
  // —— tools：state 分桶计数，avgDurationMs 仅非 null 参与均值 ——
  const toolsMap = new Map<
    string,
    { item: MonitorStats["tools"][number]; sum: number; cnt: number }
  >();
  for (const row of toolRows) {
    const entry = toolsMap.get(row.toolName) ?? {
      item: emptyToolItem(row.toolName),
      sum: 0,
      cnt: 0,
    };
    entry.item.total += 1;
    if (
      row.state === "done" ||
      row.state === "denied" ||
      row.state === "error"
    ) {
      entry.item[row.state] += 1;
    }
    if (row.durationMs !== null) {
      entry.sum += row.durationMs;
      entry.cnt += 1;
    }
    toolsMap.set(row.toolName, entry);
  }
  return {
    today: {
      inputTokens: today.inputTokens,
      outputTokens: today.outputTokens,
      llmCalls: today.llmCalls,
      toolCalls: today.toolCalls,
      toolSuccessRate:
        today.toolCalls === 0 ? 0 : todayToolDone / today.toolCalls,
    },
    trend,
    byModel: [...byModelMap.values()].sort(
      (a, b) => b.inputTokens - a.inputTokens,
    ),
    tools: [...toolsMap.values()]
      .map((e) => withRate(e.item, e.sum, e.cnt))
      .sort((a, b) => b.total - a.total),
  };
}
```

（上文引用的 `emptyTrendDay`/`emptyToolItem`/`withRate` 三个私有辅助函数已在代码块前部定义，整段可直接编译）

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/ai/monitor-stats.test.ts`
Expected: PASS

- [ ] **Step 6: monitor.repo.ts + IPC**

创建 `electron/domains/ai/monitor/monitor.repo.ts`（照 automation.repo.ts 的 handleUser 模式）：

```ts
/**
 * 监控仓储（spec §5）：monitor:stats 聚合查询——7 天窗口三查
 * findMany（llm/tool/模型名联查补位）+ computeMonitorStats 内存聚合。
 */
import prisma from "../../../commons/prisma-client";
import { handleUser } from "../../../commons/ipc-user";
import type { MonitorScene, MonitorStats } from "../../../../src-react/domains/ai/monitor/api/monitor.api";
import { computeMonitorStats } from "./monitor-stats";

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 7;

const SCENES: MonitorScene[] = ["chat", "graph", "automation"];

export class MonitorRepository {
  constructor() {
    handleUser("monitor:stats", (_, userId: number, scene?: string) =>
      this.getStats(
        userId,
        SCENES.includes(scene as MonitorScene) ? (scene as MonitorScene) : undefined,
      ),
    );
  }

  async getStats(userId: number, scene?: MonitorScene): Promise<MonitorStats> {
    const since = new Date(Date.now() - WINDOW_DAYS * DAY_MS);
    const where = {
      userId,
      createdAt: { gte: since },
      ...(scene ? { scene } : {}),
    };
    const [llmRows, toolRows] = await Promise.all([
      prisma.llmCallEvent.findMany({
        where,
        select: { modelId: true, inputTokens: true, outputTokens: true, createdAt: true },
      }),
      prisma.toolCallEvent.findMany({
        where,
        select: { toolName: true, state: true, durationMs: true, createdAt: true },
      }),
    ]);
    const modelIds = [
      ...new Set(llmRows.map((r) => r.modelId).filter((id): id is number => id !== null)),
    ];
    const models = modelIds.length
      ? await prisma.model.findMany({
          where: { id: { in: modelIds } },
          select: { id: true, name: true, modelId: true },
        })
      : [];
    return computeMonitorStats(llmRows, toolRows, models, new Date());
  }
}

export default MonitorRepository;
```

（`import prisma` 路径：确认 `electron/commons/prisma-client.ts` 的 default export——是的，`export default prisma`；automation.repo.ts 顶部有同款 import 可对照）

`electron/commons/ipc-channels.ts`：`IPC_INVOKE_ALLOWLIST` 数组里 `automation:stats` 之后加一行 `"monitor:stats",`（注意保持数组内逗号与分组注释风格）。

`electron/Application.ts`：import 加 `import MonitorRepository from "./domains/ai/monitor/monitor.repo";`；`registerServices()` 中 `new LibraryRepository(prisma);` 之后加 `new MonitorRepository();`（附一行中文注释「监控统计：token/工具事件聚合查询 IPC」）。

- [ ] **Step 7: 测试 + typecheck**

Run: `npx vitest run tests/ai/monitor-stats.test.ts && npm run typecheck`
Expected: PASS + 无错误

- [ ] **Step 8: Commit**

```bash
git add src-react/domains/ai/monitor/api/monitor.api.ts electron/domains/ai/monitor/monitor-stats.ts electron/domains/ai/monitor/monitor.repo.ts electron/commons/ipc-channels.ts electron/Application.ts tests/ai/monitor-stats.test.ts
git commit -m "feat(monitor): monitor:stats 聚合查询（纯函数口径 + IPC 注册）"
```

---

### Task 6: 前端 store 与 i18n 文案

**Files:**
- Create: `src-react/domains/ai/monitor/store/monitor.store.ts`
- Create: `tests/ai/monitor-store.test.ts`
- Modify: `src-react/i18n/locales/zh-CN/chat.json`、`src-react/i18n/locales/en-US/chat.json`

**Interfaces:**
- Consumes: `MonitorScene`/`MonitorApi`（Task 5）
- Produces（Task 7 依赖）:

```ts
export type MonitorSceneFilter = MonitorScene | "all";
// store: { scene: MonitorSceneFilter; setScene(s: MonitorSceneFilter): void }
export const useMonitorStore: import("zustand").UseBoundStore<...>;
```

- [ ] **Step 1: 写失败测试**

创建 `tests/ai/monitor-store.test.ts`：

```ts
// 场景筛选 store：缺省 all、setScene 可往返
import { beforeEach, describe, expect, it } from "vitest";
import { useMonitorStore } from "../../src-react/domains/ai/monitor/store/monitor.store";

describe("useMonitorStore", () => {
  beforeEach(() => {
    useMonitorStore.getState().setScene("all");
  });
  it("缺省 all", () => {
    expect(useMonitorStore.getState().scene).toBe("all");
  });
  it("setScene 往返", () => {
    useMonitorStore.getState().setScene("graph");
    expect(useMonitorStore.getState().scene).toBe("graph");
    useMonitorStore.getState().setScene("all");
    expect(useMonitorStore.getState().scene).toBe("all");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/monitor-store.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 store**

照 `src-react/domains/ai/automation/store/automation.store.ts` 的 zustand 写法创建：

```ts
// src-react/domains/ai/monitor/store/monitor.store.ts
/** 监控页场景筛选（spec §6）：all = 不过滤（IPC 不传 scene） */
import { create } from "zustand";
import type { MonitorScene } from "../api/monitor.api";

export type MonitorSceneFilter = MonitorScene | "all";

interface MonitorStore {
  scene: MonitorSceneFilter;
  setScene: (scene: MonitorSceneFilter) => void;
}

export const useMonitorStore = create<MonitorStore>((set) => ({
  scene: "all",
  setScene: (scene) => set({ scene }),
}));
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ai/monitor-store.test.ts`
Expected: PASS

- [ ] **Step 5: i18n 双语言 key**

`zh-CN/chat.json`：在顶层 `sidebar` 对象内加 `"monitor": "监控"`（与现有 `automation` 键并列）；在顶层新增 `monitor` 子树（**顶层不得与既有 key 重名——先确认 chat.json 顶层没有 `monitor` 键**）：

```json
"monitor": {
  "title": "监控",
  "subtitle": "Token 消耗与工具调用（近 7 天）",
  "sceneAll": "全部",
  "sceneChat": "对话",
  "sceneGraph": "工作流",
  "sceneAutomation": "自动化",
  "todayInputTokens": "今日输入 Token",
  "todayOutputTokens": "今日输出 Token",
  "todayLlmCalls": "今日 LLM 轮次",
  "todayToolCalls": "今日工具调用",
  "toolSuccessRate": "工具成功率",
  "trendTitle": "近 7 天趋势",
  "trendTokens": "Token",
  "trendCalls": "调用次数",
  "trendBar": "{{date}} · Token {{tokens}} · 调用 {{calls}}",
  "byModelTitle": "按模型分布",
  "modelName": "模型",
  "modelCalls": "轮次",
  "modelInput": "输入 Token",
  "modelOutput": "输出 Token",
  "toolsTitle": "工具排行",
  "toolName": "工具",
  "toolTotal": "次数",
  "toolSuccess": "成功率",
  "toolAvgDuration": "平均耗时",
  "toolDenied": "被拒",
  "toolError": "失败",
  "empty": "暂无数据",
  "loadFailed": "监控数据加载失败"
}
```

`en-US/chat.json` 同结构：

```json
"monitor": {
  "title": "Monitor",
  "subtitle": "Token usage & tool calls (last 7 days)",
  "sceneAll": "All",
  "sceneChat": "Chat",
  "sceneGraph": "Workflows",
  "sceneAutomation": "Automation",
  "todayInputTokens": "Input tokens today",
  "todayOutputTokens": "Output tokens today",
  "todayLlmCalls": "LLM calls today",
  "todayToolCalls": "Tool calls today",
  "toolSuccessRate": "Tool success rate",
  "trendTitle": "Last 7 days",
  "trendTokens": "Tokens",
  "trendCalls": "Calls",
  "trendBar": "{{date}} · Tokens {{tokens}} · Calls {{calls}}",
  "byModelTitle": "By model",
  "modelName": "Model",
  "modelCalls": "Calls",
  "modelInput": "Input tokens",
  "modelOutput": "Output tokens",
  "toolsTitle": "Tool leaderboard",
  "toolName": "Tool",
  "toolTotal": "Calls",
  "toolSuccess": "Success rate",
  "toolAvgDuration": "Avg duration",
  "toolDenied": "Denied",
  "toolError": "Failed",
  "empty": "No data yet",
  "loadFailed": "Failed to load monitor data"
}
```

en-US 的 `sidebar` 对象内加 `"monitor": "Monitor"`。

- [ ] **Step 6: JSON 合法性校验 + Commit**

Run: `node -e "JSON.parse(require('fs').readFileSync('src-react/i18n/locales/zh-CN/chat.json'));JSON.parse(require('fs').readFileSync('src-react/i18n/locales/en-US/chat.json'));console.log('ok')" && npx vitest run tests/ai/monitor-store.test.ts`
Expected: `ok` + PASS

```bash
git add src-react/domains/ai/monitor/store/monitor.store.ts tests/ai/monitor-store.test.ts src-react/i18n/locales/zh-CN/chat.json src-react/i18n/locales/en-US/chat.json
git commit -m "feat(monitor): 场景筛选 store 与双语 i18n 文案"
```

---

### Task 7: MonitorView 监控页 + 路由 + 导航入口

**Files:**
- Create: `src-react/domains/ai/monitor/views/MonitorView.tsx`
- Create: `src-react/domains/ai/monitor/components/MonitorTrendChart.tsx`
- Create: `src-react/domains/ai/monitor/lib/format.ts`
- Modify: `src-react/routes/index.tsx`（懒加载 import + 子路由）
- Modify: `src-react/components/layout/GlobalSidebar.tsx`（navEntries + Activity 图标 import）
- Create: `tests/ai/monitor-view.test.tsx`

**Interfaces:**
- Consumes: `MonitorApi`/`MonitorStats`/`MonitorScene`（Task 5）、`useMonitorStore`/`MonitorSceneFilter`（Task 6）、i18n key（Task 6）
- Produces: `export default function MonitorView()`（路由懒加载需要 default export）；`formatCount(n: number): string`、`formatDuration(ms: number | null): string`（lib/format.ts）

- [ ] **Step 1: 写失败测试**

创建 `tests/ai/monitor-view.test.tsx`（模式照 chat-messages.test.tsx 的 vi.mock stub；i18n 未初始化时 `t()` 返回 key 本身，断言用数字与 key）：

```tsx
// @vitest-environment jsdom
// MonitorView 渲染：KPI 数字与榜单行来自 monitor.api fixture；
// i18n 未初始化时 t() 返回 key，断言只锚数字/工具名
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";

const fixture = {
  today: { inputTokens: 12345, outputTokens: 678, llmCalls: 9, toolCalls: 12, toolSuccessRate: 0.5 },
  trend: Array.from({ length: 7 }, (_, i) => ({
    date: `2026-09-${30 + i}`, inputTokens: 10, outputTokens: 5, llmCalls: 2, toolCalls: 3,
  })),
  byModel: [{ modelId: 1, name: "主力模型", calls: 9, inputTokens: 12345, outputTokens: 678 }],
  tools: [
    { toolName: "write_file", total: 8, done: 4, denied: 2, error: 2, avgDurationMs: 150, successRate: 0.5 },
  ],
};

vi.mock("../../src-react/domains/ai/monitor/api/monitor.api", () => ({
  MonitorApi: { stats: vi.fn(async () => fixture) },
}));

import MonitorView from "../../src-react/domains/ai/monitor/views/MonitorView";

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MonitorView />
    </QueryClientProvider>,
  );
}

describe("MonitorView", () => {
  it("渲染 KPI 与工具/模型榜单行", async () => {
    renderView();
    expect(await screen.findByText("write_file")).toBeTruthy();
    expect(await screen.findByText("主力模型")).toBeTruthy();
    // 数字经 formatCount：12345 → 1.2w（zh 缺省 locale 由 Intl 决定，
    // 断言放宽为文本包含 "9"（llmCalls KPI）即可
    expect(screen.getByText("9")).toBeTruthy();
  });
});
```

（若 `formatCount` 的 compact 输出与断言不符，以实现输出为准调整断言——测试锚定「fixture 数字出现在页面」这一行为而非具体格式）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/monitor-view.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现 lib/format.ts**

```ts
// src-react/domains/ai/monitor/lib/format.ts
/** 紧凑数字（Intl compact，zh → 1.2万/en → 12K 交由 locale） */
export function formatCount(n: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(n);
}

/** 耗时：<1s 毫秒、否则秒保留 1 位；null → "-" */
export function formatDuration(ms: number | null): string {
  if (ms === null) {
    return "-";
  }
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
```

- [ ] **Step 4: 实现 MonitorTrendChart.tsx**

创建 `src-react/domains/ai/monitor/components/MonitorTrendChart.tsx`（AutomationStatsPanel TrendChart 骨架、两柱放大版）：

```tsx
// src-react/domains/ai/monitor/components/MonitorTrendChart.tsx
/** 7 天趋势（spec §6）：每日两柱——token 总量 bg-primary / 调用次数
 *  bg-primary-active（主题变量）；归一基准 = 窗口内单日单柱最大值 */
import { useTranslation } from "react-i18next";
import type { MonitorStats } from "../api/monitor.api";

const BAR_AREA_HEIGHT = 64;

function TrendBar({ value, max, className }: { value: number; max: number; className: string }) {
  const height = value === 0 ? 2 : Math.max(3, Math.round((value / max) * BAR_AREA_HEIGHT));
  return (
    <div
      className={`w-2.5 rounded-sm ${className} ${value === 0 ? "opacity-30" : ""}`}
      style={{ height }}
    />
  );
}

export default function MonitorTrendChart({ trend }: { trend: MonitorStats["trend"] }) {
  const { t } = useTranslation(["chat"]);
  const max = Math.max(
    1,
    ...trend.map((day) =>
      Math.max(day.inputTokens + day.outputTokens, day.llmCalls + day.toolCalls),
    ),
  );
  return (
    <div className="flex items-end gap-2">
      {trend.map((day) => (
        <div key={day.date} className="flex flex-1 flex-col items-center gap-1"
          title={t("chat:monitor.trendBar", {
            date: day.date,
            tokens: day.inputTokens + day.outputTokens,
            calls: day.llmCalls + day.toolCalls,
          })}
        >
          <div className="flex items-end justify-center gap-1" style={{ height: BAR_AREA_HEIGHT }}>
            <TrendBar value={day.inputTokens + day.outputTokens} max={max} className="bg-primary" />
            <TrendBar value={day.llmCalls + day.toolCalls} max={max} className="bg-primary-active" />
          </div>
          <span className="text-[10px] leading-none text-muted-foreground">{day.date.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: 实现 MonitorView.tsx**

```tsx
// src-react/domains/ai/monitor/views/MonitorView.tsx
/**
 * 监控页（spec §6）：场景筛选 chip + KPI 行 + 7 天趋势 + 按模型分布 +
 * 工具排行。数据 monitor:stats 即时聚合；场景变更经 queryKey 失效重拉。
 */
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { MonitorApi, type MonitorScene } from "../api/monitor.api";
import { useMonitorStore, type MonitorSceneFilter } from "../store/monitor.store";
import { formatCount, formatDuration } from "../lib/format";
import MonitorTrendChart from "../components/MonitorTrendChart";

const SCENE_FILTERS: MonitorSceneFilter[] = ["all", "chat", "graph", "automation"];

/** 场景 chip 行（选中态 bg-primary text-primary-foreground，主题变量） */
function SceneChips({ scene, onPick }: { scene: MonitorSceneFilter; onPick: (s: MonitorSceneFilter) => void }) {
  const { t } = useTranslation(["chat"]);
  const labelKey: Record<MonitorSceneFilter, string> = {
    all: "chat:monitor.sceneAll",
    chat: "chat:monitor.sceneChat",
    graph: "chat:monitor.sceneGraph",
    automation: "chat:monitor.sceneAutomation",
  };
  return (
    <div className="flex items-center gap-1.5">
      {SCENE_FILTERS.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onPick(s)}
          className={`rounded-full px-3 py-1 text-xs transition-colors ${
            s === scene
              ? "bg-primary text-primary-foreground"
              : "bg-muted/40 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
          }`}
        >
          {t(labelKey[s])}
        </button>
      ))}
    </div>
  );
}

/** KPI 卡（AutomationStatsPanel KpiCard 同款放大） */
function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/40 px-3 py-2">
      <p className="text-2xl font-semibold leading-7 text-foreground">{value}</p>
      <p className="truncate text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

/** 通用统计表（模型分布/工具排行共用骨架） */
function StatTable({ head, rows }: { head: string[]; rows: Array<Array<{ text: string; tone?: "destructive" }>> }) {
  return (
    <table className="w-full text-left text-xs">
      <thead>
        <tr className="text-muted-foreground">
          {head.map((h) => (
            <th key={h} className="px-2 py-1 font-medium">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className="border-t border-border/50">
            {row.map((cell, j) => (
              <td key={j} className={`px-2 py-1.5 ${cell.tone === "destructive" ? "text-destructive/80" : ""}`}>
                {cell.text}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function MonitorView() {
  const { t } = useTranslation(["chat"]);
  const scene = useMonitorStore((s) => s.scene);
  const setScene = useMonitorStore((s) => s.setScene);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["monitor", "stats", scene],
    queryFn: () => MonitorApi.stats(scene === "all" ? undefined : (scene as MonitorScene)),
  });

  if (isError) {
    toast.error(t("chat:monitor.loadFailed"));
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-border/50 px-4 py-3">
        <div>
          <h1 className="text-base font-semibold">{t("chat:monitor.title")}</h1>
          <p className="text-xs text-muted-foreground">{t("chat:monitor.subtitle")}</p>
        </div>
        <SceneChips scene={scene} onPick={setScene} />
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <div className="h-40 animate-pulse rounded-lg bg-muted/40" />
        ) : !data ? (
          <p className="py-20 text-center text-sm text-muted-foreground">{t("chat:monitor.empty")}</p>
        ) : (
          <div className="flex flex-col gap-4">
            <section className="rounded-lg border border-border/50 p-3">
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <KpiCard label={t("chat:monitor.todayInputTokens")} value={formatCount(data.today.inputTokens)} />
                <KpiCard label={t("chat:monitor.todayOutputTokens")} value={formatCount(data.today.outputTokens)} />
                <KpiCard label={t("chat:monitor.todayLlmCalls")} value={formatCount(data.today.llmCalls)} />
                <KpiCard
                  label={`${t("chat:monitor.todayToolCalls")} · ${Math.round(data.today.toolSuccessRate * 100)}%`}
                  value={formatCount(data.today.toolCalls)}
                />
              </div>
              <div className="mt-3 border-t border-border/50 pt-3">
                <p className="mb-2 text-xs font-medium text-muted-foreground">{t("chat:monitor.trendTitle")}</p>
                <MonitorTrendChart trend={data.trend} />
              </div>
            </section>
            <section className="rounded-lg border border-border/50 p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">{t("chat:monitor.byModelTitle")}</p>
              {data.byModel.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">{t("chat:monitor.empty")}</p>
              ) : (
                <StatTable
                  head={[t("chat:monitor.modelName"), t("chat:monitor.modelCalls"), t("chat:monitor.modelInput"), t("chat:monitor.modelOutput")]}
                  rows={data.byModel.map((m) => [
                    { text: m.name },
                    { text: String(m.calls) },
                    { text: formatCount(m.inputTokens) },
                    { text: formatCount(m.outputTokens) },
                  ])}
                />
              )}
            </section>
            <section className="rounded-lg border border-border/50 p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">{t("chat:monitor.toolsTitle")}</p>
              {data.tools.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">{t("chat:monitor.empty")}</p>
              ) : (
                <StatTable
                  head={[t("chat:monitor.toolName"), t("chat:monitor.toolTotal"), t("chat:monitor.toolSuccess"), t("chat:monitor.toolAvgDuration"), t("chat:monitor.toolDenied"), t("chat:monitor.toolError")]}
                  rows={data.tools.map((tool) => [
                    { text: tool.toolName },
                    { text: String(tool.total) },
                    { text: `${Math.round(tool.successRate * 100)}%` },
                    { text: formatDuration(tool.avgDurationMs) },
                    { text: String(tool.denied), tone: tool.denied > 0 ? "destructive" : undefined },
                    { text: String(tool.error), tone: tool.error > 0 ? "destructive" : undefined },
                  ])}
                />
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: 路由 + 导航**

`src-react/routes/index.tsx`：lazy import 区（AutomationView 之后）加：

```tsx
const MonitorView = lazy(() => import("@/domains/ai/monitor/views/MonitorView"));
```

AI children 中 `automation` 路由对象之后加：

```tsx
          {
            path: "monitor",
            element: (
              <LazyWrapper>
                <MonitorView />
              </LazyWrapper>
            ),
          },
```

`src-react/components/layout/GlobalSidebar.tsx`：lucide import 补 `Activity`；`navEntries` 数组「自动化」条目之后加：

```tsx
    {
      icon: <Activity size={16} />,
      label: t("chat:sidebar.monitor"),
      onClick: () => navigate("/module/ai/monitor"),
      active: location.pathname.startsWith("/module/ai/monitor"),
    },
```

- [ ] **Step 7: 跑测试 + 全量回归 + typecheck**

Run: `npx vitest run tests/ai/monitor-view.test.tsx && npm run test && npm run typecheck`
Expected: 全部 PASS、无类型错误

- [ ] **Step 8: 手动验收**

Run: `npm run dev`（提示用户执行；如环境无法启动 GUI 则标注「未验收」并说明）
验收点：侧边栏出现「监控」入口 → 进入 /module/ai/monitor → KPI/趋势/榜单渲染 → 切换场景 chip 数据变化 → 切换语言文案跟随 → 切换主题颜色跟随。

- [ ] **Step 9: Commit**

```bash
git add src-react/domains/ai/monitor src-react/routes/index.tsx src-react/components/layout/GlobalSidebar.tsx tests/ai/monitor-view.test.tsx
git commit -m "feat(monitor): /module/ai/monitor 监控页（KPI/趋势/模型分布/工具排行）"
```

---

## 执行注意（所有任务通用）

1. **工作区脏**：commit 严格按各任务 `git add` 清单；`git status --short` 确认无误后再 commit
2. **先读后写**：修改任何既有文件前先 Read 目标区段；任务中标注的行号是计划编写时的快照，以 grep 结果为准
3. **测试先行**：每任务先写测试跑失败再实现；既有大测试文件（chat.service.test.ts 等）只读不改
4. 卡住时（类型不符/测试基建缺失）：优先照 spec 与相邻先例（automation/skill-stats/artifact）调整实现细节，不改变对外接口；仍无法解决则在完成报告中如实标注
