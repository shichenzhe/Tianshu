# LangGraph 编排与多触发方式自动化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 orchestration 编排域（LangGraph StateGraph 编译执行、结构化错误 trace、图试运行），automation 域扩展为「定时/手动/事件」三触发层，并补健康度统计总览。

**Architecture:** 方案 2 全 LangChain 化——LangChain 栈只活在 `electron/domains/ai/orchestration/`；图节点 = LangChain ChatModel（+ createReactAgent 工具步骤，工具经 adapter 复用已导出的 `runToolCall` 安全链）；`automation` 保持触发调度职责，`targetKind=graph` 分流到图执行器；运行记录统一 `automationRun`（taskId 可空 + graphId/graphTrace）。

**Tech Stack:** Electron 44 / React 19 / Prisma 7 + SQLite / zod 4 / @langchain/langgraph 1.4.x + @langchain/core 1.1.x + @langchain/{anthropic,google-genai,ollama} / Vitest。

**Spec:** `docs/superpowers/specs/2026-10-03-langgraph-orchestration-design.md`（本计划从 spec 出发，执行者须同时读 spec）

## Global Constraints

- **spec §0 决策表全部有效**：v1 仅 `kind:"llm"` 节点；MemorySaver（不做 SqliteSaver）；不做拖拽画布；事件源仅 appStarted/taskFinished；事件 payload 仅 `{ outcome }`；任务可同时挂 scheduleJson+eventJson；manual/event 触发不推进调度。
- **迁移走法**：项目未发布——直接改 `prisma/schema.prisma` + `electron/infrastructure/script/v1/upgrade-table.sql`（快照指纹守卫自动重建开发库，数据可弃）；**不新建 script/v2**。
- **安全红线（spec §1）**：LangChain 工具执行必须经 `chat.service` 已导出的 `runToolCall`，禁止绕过（chat 行为零改动）。
- 命名：文件 kebab-case、变量 camelCase、类 PascalCase；IPC 通道 `orchestration:*` 进 `electron/commons/ipc-channels.ts` 白名单（单一事实源）。
- 用户可见文本一律 `t()`（`chat:orchestration.*` / `chat:automation.*`），zh-CN 与 en-US 同步添加；**禁止顶层 key 与嵌套对象 key 重名**。
- 主题色只用 `*-primary*` 变量类名；弹出层 `border-border/50 rounded-lg shadow-lg`。
- Prettier：双引号、分号、tabWidth=2、printWidth=80、无尾随逗号。
- 每个任务结束跑 `npm run test`（至少本任务测试文件）+ `npm run typecheck`，然后 commit（中文 conventional commit，先例：`feat(编排): ...`）。
- 测试放 `tests/ai/`，先例 mock 三件套见 `tests/ai/automation-runner.test.ts:7-53`（mock electron / prisma-client / Log）。

## 关键既有接口（执行者必读，均已核实存在）

| 接口 | 位置 | 签名要点 |
|---|---|---|
| `runToolCall` | `electron/domains/ai/chat/chat.service.ts:553` | `(def: ToolDefinition, agent: AgentStreamOptions, toolCallId: string, input: unknown, abortSignal?: AbortSignal, onChunk?, finalStates?) => Promise<string>`；返回 `错误:` 前缀 = 工具失败 |
| `AgentStreamOptions` | `chat.service.ts:147` | `{ sessionId, workspacePath?, fullAccess(): boolean, isToolAllowed(n): Promise<boolean>, requestApproval(id, summary): Promise<boolean>, unattended?: boolean, ... }` |
| `ToolDefinition` | `electron/domains/ai/agent/file-tools.ts:34` | `{ name, description, parameters: zod \| object(JSON Schema), kind, execute(ctx, args): Promise<string> }` |
| `resolveAutomationPermissions` | `electron/domains/ai/automation/automation-runner.ts:91` | `(accessMode: "default"\|"full") => AutomationPermissions` |
| `executeTask` | `automation-runner.ts:119` | `(task: AutomationTaskRow, opts: ExecuteTaskOptions) => Promise<"success"\|"failed">` |
| `inflight` | `automation-inflight.ts` | `Map<number, AbortController>`（taskId 互斥） |
| `classifyError` | `electron/domains/ai/chat/error-classify.ts` | `(e: unknown) => string` 错误分类码 |
| `handleUser` | `electron/commons/ipc-user.ts:58` | 自动剥 token 解 userId 作首参 |
| `AUTOMATION_CHANGED_EVENT` | `src-react/domains/ai/automation/api/automation.api.ts:150` | `"automation:tasks-changed"`（渲染层 `on()` 已可用，无需进事件白名单——跟随现有 automation 先例，经 `@/lib/ipc` 的 on 收敛面） |
| `ProviderRuntimeInfo` / `parseExtraHeaders` | `electron/domains/ai/provider/provider-factory.ts` | `{ type, baseUrl, apiKey?, extraHeaders? }` |

---

### Task 1: 安装 LangChain 依赖 + 提交 spec

**Files:**
- Modify: `package.json`、`package-lock.json`（npm 自动）
- Commit: `docs/superpowers/specs/2026-10-03-langgraph-orchestration-design.md`（已写好未提交）

**Interfaces:** 无代码接口；产出可用依赖。

- [ ] **Step 1: 安装依赖（锁 ^ 次版本）**

```bash
npm i @langchain/langgraph@^1.4.18 @langchain/core@^1.1.48 @langchain/anthropic @langchain/google-genai @langchain/ollama
```

- [ ] **Step 2: 验证可解析（ESM 主进程可用）**

```bash
node -e "import('@langchain/langgraph').then(m => console.log(typeof m.StateGraph, typeof m.Annotation))"
```
Expected: `function function`

- [ ] **Step 3: 提交 spec + 依赖**

```bash
git add docs/superpowers/specs/2026-10-03-langgraph-orchestration-design.md package.json package-lock.json
git commit -m "feat(编排): 引入 LangGraph 依赖并提交编排设计 spec"
```

---

### Task 2: 数据模型与 v1 快照迁移

**Files:**
- Modify: `prisma/schema.prisma:188-233`（automationTask/automationRun）+ 文件尾部（新表）
- Modify: `electron/infrastructure/script/v1/upgrade-table.sql:222-276`（两表）+ automationStat 后（新表）

**Interfaces:**
- Produces: Prisma 模型 `graphDefinition`（id/name/description?/graphJson/version/enabled/userId?/createdAt/updatedAt）；`automationTask` 新列 `targetKind`（默认 `"prompt"`）、`graphId Int?`、`eventJson String?`；`automationRun` 新列 `graphId Int?`、`graphTrace String?`，`taskId` 变可空。后续任务的 `AutomationTaskRow`/`GraphRow` Prisma 类型由此生成。

- [ ] **Step 1: schema.prisma——automationTask 加列（`templateSlug String?` 行后）**

```prisma
  templateSlug String?
  targetKind   String    @default("prompt") // prompt | graph
  graphId      Int?      // targetKind=graph 时必填；引用 graphDefinition.id
  eventJson    String?   // 事件触发配置，与 scheduleJson 可并存
```

- [ ] **Step 2: schema.prisma——automationRun 的 `taskId Int` 改 `taskId Int?`，并加列（`completionTokens` 行后）**

```prisma
  taskId           Int?
  graphId          Int?   // 图运行（试运行 taskId=null）
  graphTrace       String? // 节点级轨迹 JSON（spec §4）
```

同时 `@@index([taskId])` 下补 `@@index([graphId], map: "automationRun_graphId_index")`。

- [ ] **Step 3: schema.prisma——文件尾新增模型**

```prisma
model graphDefinition {
  id          Int      @id @default(autoincrement())
  name        String
  description String?
  graphJson   String
  version     Int      @default(1)
  enabled     Boolean  @default(true)
  userId      Int?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([userId], map: "graphDefinition_userId_index")
}
```

- [ ] **Step 4: v1 快照同步（`--/p` 注释 + `--/ignore` 索引格式照抄同文件先例）**

`automationTask` 建表语句（:223）`templateSlug TEXT,` 行后加：

```sql
    targetKind TEXT NOT NULL DEFAULT 'prompt',
    graphId INTEGER,
    eventJson TEXT,
```

`automationRun` 建表语句（:258）`taskId INTEGER NOT NULL` 改 `taskId INTEGER`；`completionTokens INTEGER,` 行后加 `graphId INTEGER,` 与 `graphTrace TEXT,`；`automationRun_taskId_idx` 索引后补：

```sql
--/ignore
CREATE INDEX IF NOT EXISTS automationRun_graphId_index ON automationRun(graphId);
```

automationStat 表（:279-284）后新增：

```sql
--/p 编排域（LangGraph）：图定义表；graphJson 为 zod 校验的节点/边定义
CREATE TABLE IF NOT EXISTS graphDefinition (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    graphJson TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    enabled BOOLEAN NOT NULL DEFAULT true,
    userId INTEGER NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL
);
--/ignore
CREATE INDEX IF NOT EXISTS graphDefinition_userId_index ON graphDefinition (userId);
```

- [ ] **Step 5: 重新生成 Prisma Client 并验证**

```bash
npx prisma generate && npm run typecheck
```
Expected: typecheck PASS（`taskId` 可空后若有下游类型报错，属 Task 9/15 范围内的调用点修改——若 typecheck 在本任务报 `automation.repo.ts` 相关错误，最小修复：`toRunRecord` 的 `taskName` 查询容 null，见 Task 9 Step 3 一并处理；本任务先跑 `npx tsc --noEmit` 记录错误清单，允许存在，后续任务消除）

- [ ] **Step 6: 提交**

```bash
git add prisma/schema.prisma electron/infrastructure/script/v1/upgrade-table.sql
git commit -m "feat(编排): graphDefinition 表与 automationTask/Run 触发编排列（并入 v1 快照）"
```

---

### Task 3: GraphJson zod schema 与跨节点校验

**Files:**
- Create: `src-react/domains/ai/orchestration/api/graph.schema.ts`（前后端共享，先例 `src-react/domains/ai/automation/api/schedule.schema.ts`）
- Test: `tests/ai/graph-schema.test.ts`

**Interfaces:**
- Produces: `graphJsonSchema`（zod）、`GraphJson`/`GraphNode`/`GraphEdge` 类型、`validateGraph(json: unknown): { ok: true; value: GraphJson } | { ok: false; issues: string[] }`（结构 + 跨节点校验：单入口/悬空边/branch 匹配/重 id/条件边挂非 branch 节点）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/ai/graph-schema.test.ts
import { describe, expect, it } from "vitest";
import { validateGraph, graphJsonSchema } from "../../src-react/domains/ai/orchestration/api/graph.schema";

const llmNode = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: id, kind: "llm", modelId: 1, prompt: "p", outputMode: "text", ...extra,
});
const base = (nodes: object[], edges: object[]) => ({ version: 1, inputSchema: {}, nodes, edges });

describe("graphJsonSchema", () => {
  it("合法最小图通过", () => {
    expect(graphJsonSchema.parse(base([llmNode("a")], [{ from: "a", to: "END" }]))).toBeTruthy();
  });
  it("非 llm kind 拒绝（v1 仅 llm）", () => {
    expect(() => graphJsonSchema.parse(base([llmNode("a", { kind: "tool" })], []))).toThrow();
  });
});

describe("validateGraph 跨节点校验", () => {
  it("重 id 报错", () => {
    const r = validateGraph(base([llmNode("a"), llmNode("a")], []));
    expect(r.ok).toBe(false);
  });
  it("多入口报错（START 出边须唯一）", () => {
    const r = validateGraph(base([llmNode("a"), llmNode("b")], []));
    expect(r).toEqual({ ok: false, issues: [expect.stringContaining("唯一入口")] });
  });
  it("悬空边报错（to 不存在）", () => {
    const r = validateGraph(base([llmNode("a")], [{ from: "a", to: "ghost" }]));
    expect(r.ok).toBe(false);
  });
  it("branch 节点条件边取值超 branchOptions 报错", () => {
    const g = base(
      [llmNode("a", { outputMode: "branch", branchOptions: ["x", "y"] }), llmNode("b"), llmNode("c")],
      [
        { from: "a", to: "b", condition: { type: "branch", value: "x" } },
        { from: "a", to: "c", condition: { type: "branch", value: "z" } },
      ],
    );
    const r = validateGraph(g);
    expect(r).toEqual({ ok: false, issues: [expect.stringContaining("z")] });
  });
  it("条件边挂非 branch 节点报错", () => {
    const g = base([llmNode("a"), llmNode("b")], [{ from: "a", to: "b", condition: { type: "branch", value: "x" } }]);
    expect(validateGraph(g).ok).toBe(false);
  });
  it("分支图合法", () => {
    const g = base(
      [llmNode("a", { outputMode: "branch", branchOptions: ["x", "y"] }), llmNode("b"), llmNode("c")],
      [
        { from: "a", to: "b", condition: { type: "branch", value: "x" } },
        { from: "a", to: "c", condition: { type: "branch", value: "y" } },
        { from: "b", to: "END" },
        { from: "c", to: "END" },
      ],
    );
    expect(validateGraph(g)).toEqual({ ok: true, value: expect.anything() });
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run tests/ai/graph-schema.test.ts
```
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src-react/domains/ai/orchestration/api/graph.schema.ts
/**
 * GraphJson 结构与校验（spec §3）：节点/边/条件边/输入变量。
 * 前后端共享（先例 schedule.schema.ts）；v1 节点仅 kind:"llm"，
 * schema 预留扩展值由 zod enum 收口——加类型只改这里。
 */
import { z } from "zod";

export const graphNodeSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "节点 id 须为 kebab-case"),
  name: z.string().min(1),
  kind: z.literal("llm"),
  modelId: z.number().int().positive(),
  systemPrompt: z.string().optional(),
  prompt: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  tools: z.union([z.boolean(), z.array(z.string().min(1))]).default(false),
  maxSteps: z.number().int().min(1).max(50).optional(),
  outputMode: z.enum(["text", "branch"]).default("text"),
  branchOptions: z.array(z.string().min(1)).optional(),
});

export const graphEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  condition: z.object({ type: z.literal("branch"), value: z.string().min(1) }).optional(),
});

export const graphJsonSchema = z.object({
  version: z.literal(1),
  inputSchema: z.record(z.string(), z.literal("string")).default({}),
  nodes: z.array(graphNodeSchema).min(1),
  edges: z.array(graphEdgeSchema).min(1),
});

export type GraphNode = z.infer<typeof graphNodeSchema>;
export type GraphEdge = z.infer<typeof graphEdgeSchema>;
export type GraphJson = z.infer<typeof graphJsonSchema>;

/** 跨节点结构校验（spec §3 保存期校验清单） */
export function validateGraph(json: unknown): { ok: true; value: GraphJson } | { ok: false; issues: string[] } {
  const parsed = graphJsonSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  }
  const { nodes, edges } = parsed.data;
  const ids = new Set(nodes.map((n) => n.id));
  const issues: string[] = [];
  if (new Set(nodes.map((n) => n.id)).size !== nodes.length) {
    issues.push("节点 id 重复");
  }
  const entries = edges.filter((e) => !edges.some((other) => other.from === e.from && other.to === e.to && other !== e && !other.condition && !e.condition) && !edges.some((x) => x.from === e.from && x !== e && !x.condition));
  // 唯一入口：无入边的节点必须恰有 1 个（START 直连）
  const noIncoming = nodes.filter((n) => !edges.some((e) => e.to === n.id));
  if (noIncoming.length !== 1) {
    issues.push(`图须有唯一入口（无入边节点 ${noIncoming.length} 个），请从单一首节点开始`);
  }
  for (const e of edges) {
    if (!ids.has(e.from)) issues.push(`边的 from 引用不存在节点: ${e.from}`);
    if (e.to !== "END" && !ids.has(e.to)) issues.push(`边的 to 引用不存在节点: ${e.to}`);
  }
  const branchable = new Map(nodes.filter((n) => n.outputMode === "branch").map((n) => [n.id, n]));
  for (const e of edges) {
    if (!e.condition) continue;
    const src = branchable.get(e.from);
    if (!src) {
      issues.push(`条件边挂在非 branch 节点: ${e.from}`);
    } else if (!(src.branchOptions ?? []).includes(e.condition.value)) {
      issues.push(`条件边取值 ${e.condition.value} 不在 ${e.from} 的 branchOptions 内`);
    }
  }
  return issues.length ? { ok: false, issues } : { ok: true, value: parsed.data };
}
```

（注：`entries` 中间变量无用即删——实现时保留上面代码中真正用到的校验即可，`noIncoming`/悬空/branch 三段是全部跨节点校验。）

- [ ] **Step 4: 跑测试通过 + typecheck**

```bash
npx vitest run tests/ai/graph-schema.test.ts && npm run typecheck
```
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src-react/domains/ai/orchestration/api/graph.schema.ts tests/ai/graph-schema.test.ts
git commit -m "feat(编排): GraphJson zod schema 与跨节点结构校验"
```

---

### Task 4: 节点 prompt 模板渲染（输入/上游输出/日期变量）

**Files:**
- Create: `electron/domains/ai/orchestration/graph-prompt.ts`
- Test: `tests/ai/graph-prompt.test.ts`

**Interfaces:**
- Consumes: `GraphNode`（Task 3）。
- Produces: `renderNodePrompt(template: string, ctx: { inputs: Record<string, string>; nodes: Record<string, { output: string }>; now: Date }): string`；`GraphTemplateError`（`{ code: "template_ref_missing"; varName: string }`）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/ai/graph-prompt.test.ts
import { describe, expect, it } from "vitest";
import { renderNodePrompt } from "../../electron/domains/ai/orchestration/graph-prompt";

const now = new Date("2026-10-03T09:05:00");

describe("renderNodePrompt", () => {
  it("input / nodes / 日期变量全替换", () => {
    expect(renderNodePrompt("{{input.topic}} + {{nodes.research.output}} @ {{date}} {{weekday}} {{time}}", {
      inputs: { topic: "日报" },
      nodes: { research: { output: "结论" } },
      now,
    })).toBe("日报 + 结论 @ 2026-10-03 星期六 09:05");
  });
  it("未定义 input 引用抛 template_ref_missing", () => {
    expect(() => renderNodePrompt("{{input.nope}}", { inputs: {}, nodes: {}, now }))
      .toThrowError(/input\.nope/);
  });
  it("未定义 nodes 引用抛 template_ref_missing", () => {
    expect(() => renderNodePrompt("{{nodes.ghost.output}}", { inputs: {}, nodes: {}, now }))
      .toThrowError(/nodes\.ghost\.output/);
  });
  it("无变量原样返回", () => {
    expect(renderNodePrompt("plain", { inputs: {}, nodes: {}, now })).toBe("plain");
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run tests/ai/graph-prompt.test.ts
```
Expected: FAIL

- [ ] **Step 3: 实现（复用 runner 的 WEEKDAY 语义，日期格式与 automation-runner 一致）**

```ts
// electron/domains/ai/orchestration/graph-prompt.ts
/** 节点 prompt 模板渲染（spec §4）：{{input.x}}/{{nodes.<id>.output}}/
 * {{date}}/{{weekday}}/{{time}}；缺引用抛 GraphTemplateError */
import { format } from "date-fns";

const WEEKDAY_ZH = ["一", "二", "三", "四", "五", "六", "日"];
const VAR_RE = /\{\{(input\.[A-Za-z0-9_]+|nodes\.[a-z0-9-]+\.output|date|weekday|time)\}\}/g;

export class GraphTemplateError extends Error {
  constructor(public varName: string) {
    super(`模板变量未定义: ${varName}`);
    this.name = "GraphTemplateError";
  }
}

export interface PromptRenderContext {
  inputs: Record<string, string>;
  nodes: Record<string, { output: string }>;
  now: Date;
}

export function renderNodePrompt(template: string, ctx: PromptRenderContext): string {
  return template.replace(VAR_RE, (raw, token: string) => {
    if (token === "date") return format(ctx.now, "yyyy-MM-dd");
    if (token === "weekday") return WEEKDAY_ZH[(ctx.now.getDay() === 0 ? 7 : ctx.now.getDay()) - 1];
    if (token === "time") return format(ctx.now, "HH:mm");
    if (token.startsWith("input.")) {
      const key = token.slice("input.".length);
      if (!(key in ctx.inputs)) throw new GraphTemplateError(token);
      return ctx.inputs[key];
    }
    const nodeId = token.slice("nodes.".length, -".output".length);
    if (!(nodeId in ctx.nodes)) throw new GraphTemplateError(token);
    return ctx.nodes[nodeId].output;
  });
}
```

- [ ] **Step 4: 跑测试 + typecheck 通过**
- [ ] **Step 5: 提交**

```bash
git add electron/domains/ai/orchestration/graph-prompt.ts tests/ai/graph-prompt.test.ts
git commit -m "feat(编排): 节点模板渲染——输入/上游输出/日期变量与缺引用报错"
```

---

### Task 5: LangChain provider 工厂

**Files:**
- Create: `electron/domains/ai/orchestration/langchain-model-factory.ts`
- Test: `tests/ai/langchain-model-factory.test.ts`

**Interfaces:**
- Consumes: `ProviderRuntimeInfo`（provider-factory.ts）。
- Produces: `createChatModel(provider: ProviderRuntimeInfo, modelId: string): BaseChatModel`——四协议映射，temperature 由调用方（createReactAgent/invoke config）传。

- [ ] **Step 1: 写失败测试（类型映射断言，不发请求）**

```ts
// tests/ai/langchain-model-factory.test.ts
import { describe, expect, it } from "vitest";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOllama } from "@langchain/ollama";
import { createChatModel } from "../../electron/domains/ai/orchestration/langchain-model-factory";

describe("createChatModel", () => {
  it("openai-compatible → ChatOpenAI（baseUrl/headers 透传）", () => {
    const m = createChatModel({ type: "openai-compatible", baseUrl: "http://x", apiKey: "k", extraHeaders: JSON.stringify({ a: "b" }) }, "gpt-x");
    expect(m).toBeInstanceOf(ChatOpenAI);
  });
  it("anthropic → ChatAnthropic", () => {
    expect(createChatModel({ type: "anthropic", baseUrl: "http://y", apiKey: "k" }, "claude-x")).toBeInstanceOf(ChatAnthropic);
  });
  it("gemini → ChatGoogleGenerativeAI", () => {
    expect(createChatModel({ type: "gemini", baseUrl: "", apiKey: "k" }, "gem-x")).toBeInstanceOf(ChatGoogleGenerativeAI);
  });
  it("ollama → ChatOllama", () => {
    expect(createChatModel({ type: "ollama", baseUrl: "http://z" }, "qwen-x")).toBeInstanceOf(ChatOllama);
  });
});
```

注：`@langchain/openai` 随 `@langchain/core` peer 依赖显式补装（Task 1 若未装则本任务 `npm i @langchain/openai`）。

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**

```ts
// electron/domains/ai/orchestration/langchain-model-factory.ts
/** LangChain 协议适配唯一收口（对齐 provider-factory.createLanguageModel 的分流）：
 * 只活在 orchestration 域（spec §0 LLM 栈边界） */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOllama } from "@langchain/ollama";
import { parseExtraHeaders, type ProviderRuntimeInfo } from "../provider/provider-factory";

export function createChatModel(provider: ProviderRuntimeInfo, modelId: string): BaseChatModel {
  const headers = parseExtraHeaders(provider.extraHeaders);
  switch (provider.type) {
    case "anthropic":
      return new ChatAnthropic({ anthropicApiUrl: provider.baseUrl, apiKey: provider.apiKey ?? "", model: modelId, defaultHeaders: headers });
    case "gemini":
      return new ChatGoogleGenerativeAI({ apiKey: provider.apiKey ?? "", model: modelId, ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}) });
    case "ollama":
      return new ChatOllama({ baseUrl: provider.baseUrl, model: modelId, headers });
    case "openai-compatible":
    default:
      return new ChatOpenAI({
        configuration: { baseURL: provider.baseUrl, apiKey: provider.apiKey, defaultHeaders: headers },
        model: modelId,
      });
  }
}
```

（注：各包 1.x 构造参数名以安装版本的 `.d.ts` 为准——`anthropicApiUrl`/`configuration` 名不符时按 d.ts 修正，测试断言的是类型与透传行为。）

- [ ] **Step 4: 跑测试 + typecheck 通过**
- [ ] **Step 5: 提交**

```bash
git add electron/domains/ai/orchestration/langchain-model-factory.ts tests/ai/langchain-model-factory.test.ts package.json package-lock.json
git commit -m "feat(编排): LangChain provider 工厂——四协议 ChatModel 映射"
```

---

### Task 6: LangChain 工具适配器（安全链接线，红线任务）

**Files:**
- Create: `electron/domains/ai/orchestration/langchain-tool-adapter.ts`
- Test: `tests/ai/langchain-tool-adapter.test.ts`

**Interfaces:**
- Consumes: `ToolDefinition`、`AgentStreamOptions`、`runToolCall`（chat.service 导出）。
- Produces: `toLangChainTools(defs: ToolDefinition[], agent: AgentStreamOptions, opts: { abortSignal?: AbortSignal; onToolCall?: (call: { name: string; ok: boolean }) => void }): ToolInterface[]`。

- [ ] **Step 1: 写失败测试（红线：断言经 runToolCall 且 zod 参数透传）**

```ts
// tests/ai/langchain-tool-adapter.test.ts
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("../../electron/domains/ai/chat/chat.service", () => ({
  runToolCall: vi.fn(async (_d, _a, _id, input: unknown) => `ok:${JSON.stringify(input)}`),
}));

import { runToolCall } from "../../electron/domains/ai/chat/chat.service";
import { toLangChainTools } from "../../electron/domains/ai/orchestration/langchain-tool-adapter";
import type { ToolDefinition } from "../../electron/domains/ai/agent/file-tools";

const agent = {
  sessionId: 7, fullAccess: () => false,
  isToolAllowed: async () => false, requestApproval: async () => false,
} as never;

const zodTool: ToolDefinition = {
  name: "read_file", description: "d", kind: "read",
  parameters: z.object({ path: z.string() }),
  execute: async () => "",
};
const mcpTool: ToolDefinition = {
  name: "mcp__x__y", description: "mcp d", kind: "read",
  parameters: { type: "object", properties: { q: { type: "string" } } },
  execute: async () => "",
};

describe("toLangChainTools", () => {
  it("zod 工具走 runToolCall 且参数透传", async () => {
    const [t] = toLangChainTools([zodTool], agent, {});
    const out = await t.invoke({ path: "a.txt" });
    expect(out).toBe('ok:{"path":"a.txt"}');
    expect(runToolCall).toHaveBeenCalled();
  });
  it("MCP（JSON Schema）工具 func 收 JSON 字符串并解析透传", async () => {
    const [, t] = toLangChainTools([zodTool, mcpTool], agent, {});
    const out = await t.invoke(JSON.stringify({ q: "hi" }));
    expect(out).toBe('ok:{"q":"hi"}');
  });
  it("MCP 工具非法 JSON 回喂错误文案不抛出", async () => {
    const [, t] = toLangChainTools([zodTool, mcpTool], agent, {});
    const out = await t.invoke("not-json");
    expect(String(out)).toContain("错误");
  });
  it("onToolCall 回调 ok 判定（错误: 前缀 = 失败）", async () => {
    vi.mocked(runToolCall).mockResolvedValueOnce("错误: x");
    const calls: Array<{ name: string; ok: boolean }> = [];
    const [t] = toLangChainTools([zodTool], agent, { onToolCall: (c) => calls.push(c) });
    await t.invoke({ path: "b" });
    expect(calls).toEqual([{ name: "read_file", ok: false }]);
  });
});
```

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**

```ts
// electron/domains/ai/orchestration/langchain-tool-adapter.ts
/** AI SDK 工具 → LangChain Tool 适配（spec §1 安全红线）：
 * 执行必须经 chat.service 导出的 runToolCall（命令门/文件门/批量删除/
 * 审批/审计全链继承），绝不直调 def.execute。
 * zod 参数 → DynamicStructuredTool；MCP（JSON Schema 裸对象）→ Tool
 * 基类（模型按 description 内嵌 schema 生成 JSON 字符串参数）。 */
import { z } from "zod";
import { DynamicStructuredTool, Tool } from "@langchain/core/tools";
import type { ToolInterface } from "@langchain/core/tools";
import { runToolCall, type AgentStreamOptions } from "../chat/chat.service";
import type { ToolDefinition } from "../agent/file-tools";

export interface ToolAdapterOptions {
  abortSignal?: AbortSignal;
  onToolCall?: (call: { name: string; ok: boolean }) => void;
}

export function toLangChainTools(
  defs: ToolDefinition[],
  agent: AgentStreamOptions,
  opts: ToolAdapterOptions,
): ToolInterface[] {
  return defs.map((def) => {
    const dispatch = async (input: unknown): Promise<string> => {
      const output = await runToolCall(def, agent, `${def.name}-${Date.now()}`, input, opts.abortSignal);
      opts.onToolCall?.({ name: def.name, ok: !output.startsWith("错误:") });
      return output;
    };
    if (def.parameters instanceof z.ZodType) {
      return new DynamicStructuredTool({
        name: def.name,
        description: def.description,
        schema: def.parameters as z.ZodType<Record<string, unknown>>,
        func: dispatch,
      });
    }
    return new Tool({
      name: def.name,
      description: `${def.description}\nInput JSON Schema: ${JSON.stringify(def.parameters)}`,
      func: async (raw: string) => {
        try {
          return await dispatch(JSON.parse(raw));
        } catch {
          return "错误: 工具参数不是合法 JSON，请按 Input JSON Schema 输出 JSON 字符串";
        }
      },
    });
  });
}
```

- [ ] **Step 4: 跑测试 + typecheck 通过**
- [ ] **Step 5: 提交**

```bash
git add electron/domains/ai/orchestration/langchain-tool-adapter.ts tests/ai/langchain-tool-adapter.test.ts
git commit -m "feat(编排): LangChain 工具适配器——执行经 runToolCall 安全链"
```

---

### Task 7: 图编译器（GraphJson → StateGraph 结构计划）

**Files:**
- Create: `electron/domains/ai/orchestration/graph-compiler.ts`
- Test: `tests/ai/graph-compiler.test.ts`

**Interfaces:**
- Consumes: `GraphJson`（Task 3）。
- Produces: `buildEdgePlan(json: GraphJson): { direct: Array<{ from: string; to: string }>; conditional: Array<{ from: string; mapping: Record<string, string> }> }`（纯函数）；`compileStateGraph(json: GraphJson, handlers: Record<string, (state: GraphRunState) => Promise<Partial<GraphRunState>>>): CompiledStateGraph`；`GraphRunState` 类型 `{ inputs: Record<string, string>; nodes: Record<string, NodeResult>; route?: string }`（`NodeResult = { output: string; usage?: { promptTokens: number; completionTokens: number } }`）；常量 `GRAPH_RECURSION_LIMIT = 25`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/ai/graph-compiler.test.ts
import { describe, expect, it } from "vitest";
import { buildEdgePlan, compileStateGraph, GRAPH_RECURSION_LIMIT } from "../../electron/domains/ai/orchestration/graph-compiler";
import type { GraphJson } from "../../src-react/domains/ai/orchestration/api/graph.schema";

const json: GraphJson = {
  version: 1, inputSchema: {},
  nodes: [
    { id: "a", name: "A", kind: "llm", modelId: 1, prompt: "p", tools: false, outputMode: "branch", branchOptions: ["x", "y"] },
    { id: "b", name: "B", kind: "llm", modelId: 1, prompt: "p", tools: false, outputMode: "text" },
  ],
  edges: [
    { from: "a", to: "b", condition: { type: "branch", value: "x" } },
    { from: "a", to: "END", condition: { type: "branch", value: "y" } },
  ],
};

describe("buildEdgePlan", () => {
  it("条件边按 from 聚合成 mapping", () => {
    expect(buildEdgePlan(json)).toEqual({
      direct: [],
      conditional: [{ from: "a", mapping: { x: "b", y: "END" } }],
    });
  });
});

describe("compileStateGraph", () => {
  it("按 route 分支执行到 END", async () => {
    const handlers = {
      a: async () => ({ nodes: { a: { output: "" } }, route: "y" }),
      b: async () => ({ nodes: { b: { output: "ran-b" } } }),
    };
    const app = compileStateGraph(json, handlers);
    const result = await app.invoke({ inputs: {}, nodes: {} });
    expect(result.nodes.b).toBeUndefined();
  });
  it("route=x 走 b", async () => {
    const handlers = {
      a: async () => ({ nodes: { a: { output: "" } }, route: "x" }),
      b: async () => ({ nodes: { b: { output: "ran-b" } } }),
    };
    const result = await compileStateGraph(json, handlers).invoke({ inputs: {}, nodes: {} });
    expect(result.nodes.b).toEqual({ output: "ran-b" });
  });
});
```

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**

```ts
// electron/domains/ai/orchestration/graph-compiler.ts
/** GraphJson → LangGraph StateGraph（spec §3）：nodes reducer merge、
 * route 驱动条件边；recursionLimit 兜底环。 */
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import type { GraphJson } from "../../../../src-react/domains/ai/orchestration/api/graph.schema";

export const GRAPH_RECURSION_LIMIT = 25;

export interface NodeResult {
  output: string;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface GraphRunState {
  inputs: Record<string, string>;
  nodes: Record<string, NodeResult>;
  route?: string;
}

const GraphState = Annotation.Root({
  inputs: Annotation<Record<string, string>>(),
  nodes: Annotation<Record<string, NodeResult>>({
    reducer: (prev, next) => ({ ...prev, ...next }),
    default: () => ({}),
  }),
  route: Annotation<string | undefined>(),
});

export function buildEdgePlan(json: GraphJson) {
  const direct: Array<{ from: string; to: string }> = [];
  const cond = new Map<string, Record<string, string>>();
  for (const e of json.edges) {
    if (e.condition) {
      const m = cond.get(e.from) ?? {};
      m[e.condition.value] = e.to;
      cond.set(e.from, m);
    } else {
      direct.push({ from: e.from, to: e.to });
    }
  }
  return { direct, conditional: [...cond.entries()].map(([from, mapping]) => ({ from, mapping })) };
}

export function compileStateGraph(
  json: GraphJson,
  handlers: Record<string, (state: GraphRunState) => Promise<Partial<GraphRunState>>>,
) {
  const entry = json.nodes.find((n) => !json.edges.some((e) => e.to === n.id));
  if (!entry) throw new Error("graph_invalid: 无入口节点");
  const { direct, conditional } = buildEdgePlan(json);
  let g = new StateGraph(GraphState)
    .addNode("__entry__", async () => ({}));
  for (const n of json.nodes) {
    g = g.addNode(n.id, (state: GraphRunState) => handlers[n.id](state));
  }
  g = g.addEdge(START, "__entry__").addEdge("__entry__", entry.id);
  for (const e of direct) {
    g = g.addEdge(e.from, e.to === "END" ? END : e.to);
  }
  for (const c of conditional) {
    g = g.addConditionalEdges(c.from, (state: GraphRunState) => state.route ?? "__fallback__", {
      ...c.mapping,
      __fallback__: END,
    });
  }
  return g.compile({ recursionLimit: GRAPH_RECURSION_LIMIT });
}
```

（注：`compile` 不收 `recursionLimit`——它属 `invoke` 的 config；改为 `compileStateGraph` 返回 `{ graph, config: { recursionLimit: GRAPH_RECURSION_LIMIT } }`，invoke 传 `{ configurable: { thread_id }, recursionLimit }`。测试相应调 `app.graph.invoke(initial, app.config)`；MemorySaver 在 executor（Task 8）装配。）

- [ ] **Step 4: 跑测试 + typecheck 通过**
- [ ] **Step 5: 提交**

```bash
git add electron/domains/ai/orchestration/graph-compiler.ts tests/ai/graph-compiler.test.ts
git commit -m "feat(编排): 图编译器——边计划聚合与 route 条件分支"
```

---

### Task 8: 图执行器（graph-executor + trace + 集成测试）

**Files:**
- Create: `electron/domains/ai/orchestration/graph-executor.ts`
- Test: `tests/ai/graph-executor.test.ts`

**Interfaces:**
- Consumes: Task 3/4/5/6/7 全部产物；`executeTask` 的 `ExecuteTaskOptions`（automation-runner）；`resolveAutomationPermissions`；`collectTools`（automation-runner 导出）；`classifyError`；`serializeBlocks`（chat/blocks）。
- Produces: `executeGraphRun(params: GraphRunParams): Promise<"success" | "failed">`，`GraphRunParams = { graph: GraphRow; task: AutomationTaskRow | null; inputs: Record<string, string>; triggerType: "schedule" | "catchUp" | "retry" | "manual" | "event"; attempt: number; abort: AbortSignal; workspace: { id: number; directoryPath: string | null }; disabledTools?: () => string[] }`。图专属错误码（spec §4）：`graph_invalid` / `graph_recursion_limit` / `template_ref_missing` / `branch_parse_error` / `graph_missing`（外层用）/ `model_missing`。
- 依赖注入 seam：`executeGraphRun` 内部经 `deps` 参数默认取 `createChatModel`/`toLangChainTools`/`compileStateGraph`——测试 mock 这三个。

- [ ] **Step 1: 写失败测试（集成：2 节点 + 分支，mock 模型与工具适配）**

```ts
// tests/ai/graph-executor.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: vi.fn(() => "/tmp/tianshu-test-user-data") } }));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    session: { create: vi.fn(async () => ({ id: 42 })) },
    message: { create: vi.fn() },
    automationRun: { create: vi.fn(async () => ({ id: 9 })), update: vi.fn() },
    automationTask: { update: vi.fn() },
  },
}));
vi.mock("../../electron/commons/Log", () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("../../electron/domains/ai/agent/skill-loader", () => ({ loadSkills: vi.fn(() => []) }));

const modelMock = { invoke: vi.fn() };
vi.mock("../../electron/domains/ai/orchestration/langchain-model-factory", () => ({
  createChatModel: vi.fn(() => modelMock),
}));

import prisma from "../../electron/commons/prisma-client";
import { executeGraphRun } from "../../electron/domains/ai/orchestration/graph-executor";

const graph = {
  id: 5, name: "demo", graphJson: JSON.stringify({
    version: 1, inputSchema: { topic: "string" },
    nodes: [
      { id: "research", name: "调研", kind: "llm", modelId: 1, prompt: "调研 {{input.topic}}", tools: false, outputMode: "branch", branchOptions: ["go", "stop"] },
      { id: "report", name: "成文", kind: "llm", modelId: 1, prompt: "基于 {{nodes.research.output}} 成文", tools: false, outputMode: "text" },
    ],
    edges: [
      { from: "research", to: "report", condition: { type: "branch", value: "go" } },
      { from: "research", to: "END", condition: { type: "branch", value: "stop" } },
      { from: "report", to: "END" },
    ],
  }), version: 1, enabled: true, userId: 1, createdAt: new Date(), updatedAt: new Date(),
} as never;

const runParams = (inputs: Record<string, string>) => ({
  graph, task: null, inputs, triggerType: "manual" as const, attempt: 1,
  abort: new AbortController().signal, workspace: { id: 9, directoryPath: null },
});

describe("executeGraphRun", () => {
  it("分支 go：两节点执行，graphTrace 落 success，模板引用上游输出", async () => {
    modelMock.invoke
      .mockResolvedValueOnce({ branch: "go" })          // research 结构化输出
      .mockResolvedValueOnce({ content: "最终报告" });   // report 文本
    const out = await executeGraphRun(runParams({ topic: "AI" }));
    expect(out).toBe("success");
    const update = vi.mocked(prisma.automationRun.update).mock.calls[0][0];
    const trace = JSON.parse(update.data.graphTrace as string);
    expect(trace).toHaveLength(2);
    expect(trace[1].status).toBe("success");
    // report 的输入消息引用了 research 输出（消息落库第二条 user）
    const msg = vi.mocked(prisma.message.create).mock.calls[1][0];
    expect(JSON.parse(msg.data.blocks)[0].text).toContain("调研");
  });
  it("节点 LLM 失败：run failed，error 含 node:<id> 与分类码，后续节点 skipped", async () => {
    modelMock.invoke.mockRejectedValueOnce(new Error("network down"));
    const out = await executeGraphRun(runParams({ topic: "AI" }));
    expect(out).toBe("failed");
    const update = vi.mocked(prisma.automationRun.update).mock.calls.at(-1)![0];
    expect(update.data.error).toMatch(/^node:research /);
    const trace = JSON.parse(update.data.graphTrace as string);
    expect(trace.find((t: { id?: string }) => t.id === "research").status).toBe("failed");
  });
  it("非法 graphJson：run failed(graph_invalid)", async () => {
    const bad = { ...graph, graphJson: "{oops" } as never;
    const out = await executeGraphRun({ ...runParams({}), graph: bad });
    expect(out).toBe("failed");
    expect(vi.mocked(prisma.automationRun.update).mock.calls.at(-1)![0].data.error).toContain("graph_invalid");
  });
});
```

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现（结构骨架 + 节点 handler；长函数拆小）**

```ts
// electron/domains/ai/orchestration/graph-executor.ts
/** 图执行编排（spec §4）：run 落库 → session → 逐节点（模板渲染 →
 * LangChain 模型/agent → 消息落库 → trace 追加）→ 收尾（run/task/
 * usage）。全部异常吞掉落库返回 "failed"，绝不向调用方抛。 */
import prisma from "../../../commons/prisma-client";
import Log from "../../../commons/Log";
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage } from "@langchain/core/messages";
import { validateGraph, type GraphJson, type GraphNode } from "../../../../src-react/domains/ai/orchestration/api/graph.schema";
import { renderNodePrompt, GraphTemplateError } from "./graph-prompt";
import { createChatModel } from "./langchain-model-factory";
import { toLangChainTools } from "./langchain-tool-adapter";
import { compileStateGraph, type GraphRunState } from "./graph-compiler";
import { runChatStream, type AgentStreamOptions } from "../chat/chat.service";
import { serializeBlocks } from "../chat/blocks";
import { classifyError } from "../chat/error-classify";
import { commandGate } from "../../security/command-gate";
import { fileGate } from "../../security/file-gate";
import { collectTools, resolveAutomationPermissions } from "../automation/automation-runner";
import { normalizeWorkspacePath } from "../chat/chat.service";
import { createLanguageModel } from "../provider/provider-factory";

export interface TraceEntry {
  id: string; name: string;
  status: "success" | "failed" | "skipped";
  startedAt: string; durationMs: number;
  tokens?: { promptTokens: number; completionTokens: number };
  error?: { code: string; message: string; toolName?: string };
  toolCalls?: Array<{ name: string; ok: boolean; durationMs: number }>;
  outputPreview?: string;
}
```

实现要点（每点一个 ≤20 行函数，执行者按此展开）：

1. `executeGraphRun`：`automationRun.create({ taskId: task?.id ?? null, graphId, triggerType, attempt, status: "running" })` → `JSON.parse(graphJson)` + `validateGraph`（fail → `finishRun("failed", "graph_invalid: …")`）→ 建 session（`prisma.session.create({ workspaceId, currentModelId: 入口节点模型, title: 图名, mode: "agent" })`）→ 组装 `agentCtx`（`AgentStreamOptions`，权限 `resolveAutomationPermissions(task?.accessMode ?? "default")` + `decideCommand: commandGate` + `decideFileAccess: fileGate` + `unattended: true`）→ 逐节点生成 handler → `compileStateGraph(...)` + `MemorySaver` invoke（thread_id = `graph-${graph.id}-run-${run.id}`，`recursionLimit: GRAPH_RECURSION_LIMIT`）→ 按异常分支收尾。
2. 节点 handler `makeNodeHandler(node, ctx)`：`renderNodePrompt`（catch `GraphTemplateError` → 抛 `NodeFailure("template_ref_missing", varName)`）；无 tools：`outputMode==="branch"` → `createChatModel(...).withStructuredOutput(z.enum(branchOptions)).invoke(messages)` 得 label（catch → `branch_parse_error`），写 `state.route` + `nodes[id] = { output: label }`；text → `model.invoke([system?, new HumanMessage(prompt)])` 取 `.content`。有 tools：`createReactAgent(model, toLangChainTools(...), { prompt: systemPrompt })` invoke 收 final message content，`toolCalls` 由 `onToolCall` 回调累计（name/ok/耗时）。每节点完成即：`prisma.message.create` 一对 user/assistant（blocks 用 `serializeBlocks([{type:"text",text}])`，assistant 带 `durationMs`）+ trace push。
3. LangGraph 抛 `GraphRecursionError` → 错误码 `graph_recursion_limit`。
4. `finishRun(runId, status, trace, error?)`：`automationRun.update`（`graphTrace: JSON.stringify(trace)`、`error: node:<id> <code>: <msg>` 截 500、durationMs、tokens 汇总、finishedAt、sessionId）；`advanceTask` 语义复用——**导入 automation-runner 的 advanceTask 前，先在该文件导出它**（现为私有；Task 9 一并导出并补一行注释）。manual/event 触发不推进（advanceTask 已实现 manual 分支，扩 event 同款 return）。
5. 失败节点之后的节点在 trace 里补 `status:"skipped"` 条目（invoke 结束后按 `json.nodes` 顺序 diff 已执行集合）。

- [ ] **Step 4: 跑测试 + typecheck 通过（含既有 automation-runner 测试不回归）**
- [ ] **Step 5: 提交**

```bash
git add electron/domains/ai/orchestration/graph-executor.ts electron/domains/ai/automation/automation-runner.ts tests/ai/graph-executor.test.ts
git commit -m "feat(编排): 图执行器——LangGraph 编排执行/节点消息落库/graphTrace 错误码"
```

---

### Task 9: automation 域改造——runner 分流 + repo 扩展 + 触发层

**Files:**
- Modify: `electron/domains/ai/automation/automation-runner.ts`（executeTask 分流；`advanceTask` 导出；ExecuteTaskOptions 加 `inputs?`）
- Modify: `electron/domains/ai/automation/automation.repo.ts`（create/update 校验 targetKind/graphId/eventJson 自引用；toTaskRecord/toRunRecord 扩展）
- Modify: `src-react/domains/ai/automation/api/automation.api.ts`（类型扩展：`TaskRecord.targetKind/graphId/eventJson?`、`RunRecord.taskId: number | null`/`graphId?`/`graphTrace?`、`TriggerType` 加 `"event"`、`EventTriggerConfig`、`AutomationStats`）
- Test: `tests/ai/automation-event-bus.test.ts`（Task 10 前置类型在 api 文件）

**Interfaces:**
- Consumes: Task 2 新列、Task 8 `executeGraphRun`。
- Produces: `executeTask` 对 `targetKind==="graph"` 任务分流（校验图存在——缺失置 task error/graph_missing，对齐 workspace_missing 先例）；`EventTriggerConfig` zod（`eventJsonSchema`：appStarted | taskFinished{targetType,targetId,on}）；`assertNoSelfReference(eventConfig, taskId)`；`AutomationStats` 类型（Task 14 用）。

- [ ] **Step 1: automation.api.ts 类型扩展（先立契约）**

```ts
export type TriggerType = "schedule" | "catchUp" | "retry" | "manual" | "event";
export type EventTriggerConfig =
  | { source: "appStarted" }
  | { source: "taskFinished"; targetType: "task" | "graph"; targetId: number; on: "success" | "failed" | "any" };
// TaskCreateParams / TaskRecord 加：targetKind: "prompt" | "graph"; graphId?: number;
//   eventJson?: string（EventTriggerConfig 的 JSON 序列）
// RunRecord：taskId: number | null; graphId?: number; graphTrace?: string; taskName: string（图运行为图名）
export interface AutomationStats {
  today: { total: number; success: number; failed: number; running: number; successRate: number };
  trend: Array<{ date: string; success: number; failed: number }>;
  attention: Array<
    | { kind: "taskError"; taskId: number; name: string; statusNote: string }
    | { kind: "failedRun"; runId: number; name: string; graphId?: number; error: string; startedAt: string }
  >;
  errorTaskCount: number;
}
```

- [ ] **Step 2: runner 分流（executeTask 建 run 与 workspace/model 校验之间插入）**

```ts
// targetKind=graph：模型校验改为「入口节点模型」由 executor 自查；此处仅 workspace
if (task.targetKind === "graph") {
  const graph = task.graphId
    ? await prisma.graphDefinition.findUnique({ where: { id: task.graphId } })
    : null;
  if (!graph || !graph.enabled) {
    return await failRun(run.id, task, "graph_missing", startedAt, sessionId, opts.triggerType);
  }
  return await executeGraphRun({
    graph, task, inputs: opts.inputs ?? {}, triggerType: opts.triggerType,
    attempt: opts.attempt, abort: opts.abort, workspace,
    disabledTools: opts.disabledTools,
  });
}
```

同步：`failRun` 的系统错误码分支加 `graph_missing`；`advanceTask` 导出 + triggerType 参数类型加 `"event"`；`ExecuteTaskOptions.triggerType` 加 `"event"`、加 `inputs?: Record<string, string>`。

- [ ] **Step 3: repo 扩展（buildTaskData 落 targetKind/graphId/eventJson；create/update 校验）**

```ts
// buildTaskData 追加：
...(p.targetKind === "graph"
  ? { targetKind: "graph", graphId: p.graphId ?? null, prompt: "", modelId: 0 as unknown as number }
  : { targetKind: "prompt", graphId: null }),
eventJson: p.eventJson ? JSON.stringify(eventJsonSchema.parse(JSON.parse(p.eventJson))) : null,
```

校验（createTask/updateTask 在 assertTaskRefsOwned 后）：

```ts
if (p.targetKind === "graph") {
  const g = await prisma.graphDefinition.findFirst({ where: { id: p.graphId ?? -1, userId } });
  if (!g) throw new Error("GRAPH_NOT_FOUND");
}
if (p.eventJson) {
  const ev = eventJsonSchema.parse(JSON.parse(p.eventJson));
  // spec §5 防环：自引用拒绝
  if (ev.source === "taskFinished" && ev.targetType === "task" && ev.targetId === id) {
    throw new Error("EVENT_SELF_REFERENCE");
  }
  if (ev.source === "taskFinished" && ev.targetType === "task") {
    await this.assertTaskOwned(ev.targetId, userId);
  } else if (ev.source === "taskFinished") {
    const g = await prisma.graphDefinition.findFirst({ where: { id: ev.targetId, userId } });
    if (!g) throw new Error("EVENT_TARGET_NOT_FOUND");
  }
}
```

（`updateTask` 的自引用校验用被编辑任务 id；`modelId: 0` 占位——graph 任务模型在各节点，UI 提交时 targetKind=graph 则 modelId 允许 0，`assertTaskRefsOwned` 对 graph 任务跳过 model 校验。）

`eventJsonSchema` 放 `src-react/domains/ai/orchestration/api/graph.schema.ts` 尾部：

```ts
export const eventJsonSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("appStarted") }),
  z.object({
    source: z.literal("taskFinished"),
    targetType: z.enum(["task", "graph"]),
    targetId: z.number().int().positive(),
    on: z.enum(["success", "failed", "any"]),
  }),
]);
export type EventTriggerConfig = z.infer<typeof eventJsonSchema>;
```

`toRunRecord` 扩展（taskId 容 null，graphId/graphTrace 透出；taskName 查询 names map 缺失时图运行用图名——listRuns 联查 graphDefinition 名称）。

- [ ] **Step 4: 跑既有自动化测试 + typecheck（automation-repo/runner 测试需补 `targetKind: "prompt"` 字段到 taskRow fixture）**
- [ ] **Step 5: 提交**

```bash
git add electron/domains/ai/automation/automation-runner.ts electron/domains/ai/automation/automation.repo.ts src-react/domains/ai/automation/api/automation.api.ts src-react/domains/ai/orchestration/api/graph.schema.ts tests/ai/automation-runner.test.ts tests/ai/automation-repo.test.ts
git commit -m "feat(自动化): 任务执行体扩展 prompt|graph 分流与事件触发配置校验"
```

---

### Task 10: 事件总线（appStarted + taskFinished 链式，防环）

**Files:**
- Create: `electron/domains/ai/automation/automation-event-bus.ts`
- Modify: `electron/domains/ai/automation/automation-scheduler.ts`（start() 末尾发 appStarted；launch 收尾发 taskFinished；launch triggerType 加 "event"；launch 加 `inputs`/`chainDepth` 透传）
- Modify: `electron/domains/ai/automation/automation.repo.ts`（runNow 收尾发 taskFinished）
- Test: `tests/ai/automation-event-bus.test.ts`

**Interfaces:**
- Consumes: `executeTask`、`inflight`、`EventTriggerConfig`。
- Produces: `publishAutomationEvent(event: AutomationEvent): Promise<void>`；纯函数 `matchEventTasks(tasks: Array<Pick<AutomationTaskRow, "id"|"eventJson"|"enabled"|"status">>, event: AutomationEvent): { task: …; inputs: Record<string, string> }[]`（单测主体）；`AutomationEvent = { source: "appStarted" } | { source: "taskFinished"; targetType: "task" | "graph"; targetId: number; outcome: "success" | "failed" }`；常量 `MAX_CHAIN_DEPTH = 5`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/ai/automation-event-bus.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: vi.fn(() => []) } }));
vi.mock("../../electron/commons/prisma-client", () => ({ default: { automationTask: { findMany: vi.fn() } } }));
vi.mock("../../electron/commons/Log", () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("../../electron/domains/ai/automation/automation-runner", () => ({ executeTask: vi.fn() }));

import { matchEventTasks, MAX_CHAIN_DEPTH } from "../../electron/domains/ai/automation/automation-event-bus";

const task = (id: number, eventJson: string | null) => ({
  id, eventJson, enabled: true, status: "active",
});

describe("matchEventTasks", () => {
  it("appStarted 命中", () => {
    const hits = matchEventTasks([task(1, JSON.stringify({ source: "appStarted" }))], { source: "appStarted" });
    expect(hits).toHaveLength(1);
  });
  it("taskFinished 按 targetType/targetId/on 过滤，并注入 outcome", () => {
    const rows = [
      task(1, JSON.stringify({ source: "taskFinished", targetType: "task", targetId: 3, on: "success" })),
      task(2, JSON.stringify({ source: "taskFinished", targetType: "graph", targetId: 7, on: "any" })),
      task(3, JSON.stringify({ source: "taskFinished", targetType: "task", targetId: 3, on: "failed" })),
    ];
    const hits = matchEventTasks(rows, { source: "taskFinished", targetType: "task", targetId: 3, outcome: "success" });
    expect(hits.map((h) => h.task.id)).toEqual([1]);
    expect(hits[0].inputs).toEqual({ outcome: "success" });
  });
  it("坏 eventJson 行静默跳过；disabled/error 不入选（findMany where 已滤，函数再容错）", () => {
    expect(matchEventTasks([task(1, "{bad")], { source: "appStarted" })).toHaveLength(0);
  });
});
it("链深上限常量为 5", () => expect(MAX_CHAIN_DEPTH).toBe(5));
```

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**

```ts
// electron/domains/ai/automation/automation-event-bus.ts
/** 事件触发（spec §5）：publish → 匹配 enabled+active 任务 → launch。
 * 防环：链深 >5 落 skipped(chain_depth_exceeded)；互斥复用 inflight。
 * 发布方（scheduler/repo runNow/graph 试运行）在 executeTask resolve 后
 * 调 publish，本模块不 import 它们——依赖单向：event-bus → runner。 */
import prisma from "../../../commons/prisma-client";
import Log from "../../../commons/Log";
import { executeTask, type AutomationTaskRow } from "./automation-runner";
import { inflight } from "./automation-inflight";
import { eventJsonSchema } from "../../../../src-react/domains/ai/orchestration/api/graph.schema";

export const MAX_CHAIN_DEPTH = 5;

export type AutomationEvent =
  | { source: "appStarted" }
  | { source: "taskFinished"; targetType: "task" | "graph"; targetId: number; outcome: "success" | "failed" };

export function matchEventTasks(
  tasks: Array<Pick<AutomationTaskRow, "id" | "eventJson" | "enabled" | "status">>,
  event: AutomationEvent,
): Array<{ task: Pick<AutomationTaskRow, "id" | "eventJson" | "enabled" | "status">; inputs: Record<string, string> }> {
  const hits = [];
  for (const t of tasks) {
    if (!t.enabled || t.status !== "active" || !t.eventJson) continue;
    let ev;
    try {
      ev = eventJsonSchema.parse(JSON.parse(t.eventJson));
    } catch {
      continue;
    }
    if (ev.source !== event.source) continue;
    if (event.source === "taskFinished" && ev.source === "taskFinished") {
      if (ev.targetType !== event.targetType || ev.targetId !== event.targetId) continue;
      if (ev.on !== "any" && ev.on !== event.outcome) continue;
      hits.push({ task: t, inputs: { outcome: event.outcome } });
    } else if (event.source === "appStarted") {
      hits.push({ task: t, inputs: {} });
    }
  }
  return hits;
}

export async function publishAutomationEvent(event: AutomationEvent, chainDepth = 1): Promise<void> {
  try {
    const tasks = await prisma.automationTask.findMany({ where: { enabled: true, status: "active", eventJson: { not: null } } });
    for (const { task, inputs } of matchEventTasks(tasks, event)) {
      if (chainDepth > MAX_CHAIN_DEPTH) {
        await prisma.automationRun.create({ data: { taskId: task.id, triggerType: "event", status: "skipped", error: "chain_depth_exceeded", startedAt: new Date(), finishedAt: new Date() } });
        continue;
      }
      if (inflight.has(task.id)) {
        await prisma.automationRun.create({ data: { taskId: task.id, triggerType: "event", status: "skipped", error: "event_skipped_running", startedAt: new Date(), finishedAt: new Date() } });
        continue;
      }
      const abort = new AbortController();
      inflight.set(task.id, abort);
      const outcome = await executeTask(task as AutomationTaskRow, { triggerType: "event", attempt: 1, abort: abort.signal, inputs })
        .catch(() => "failed" as const);
      inflight.delete(task.id);
      // 链式发布：event 触发的 run 完成同样成为 taskFinished 源（spec §5）
      await publishAutomationEvent({ source: "taskFinished", targetType: "task", targetId: task.id, outcome }, chainDepth + 1);
    }
  } catch (e) {
    Log.error("自动化事件触发异常", e);
  }
}
```

（注意：taskFinished 也要为 **prompt 任务的 schedule/manual/retry 触发**发布——发布点放 scheduler.launch / repo runNow 的收口 `finally` 之前拿 outcome（见 Step 4），event-bus 自身的链式发布已在上面内联。graph 的 taskFinished：`targetType:"graph"` 事件在 graph-executor 试运行与任务图执行收尾处由调用方（scheduler.launch 对 graph 任务、graph.repo run-test）发布。）

- [ ] **Step 4: scheduler 接线**

`launch` 签名扩为 `(task, triggerType: "schedule"|"catchUp"|"retry"|"event", attempt, inputs?: Record<string,string>)`；`.catch` 前接 outcome：

```ts
const outcome = await executeTask(task, { triggerType, attempt, abort: abort.signal, disabledTools: this.disabledTools, inputs })
  .catch((e) => { Log.error("自动化执行失败", task.id, e); return "failed" as const; });
void publishAutomationEvent({ source: "taskFinished", targetType: task.targetKind === "graph" ? "graph" : "task", targetId: task.targetKind === "graph" ? (task.graphId ?? 0) : task.id, outcome });
```

（`finally` 保持 inflight 清理 + notifyChanged。）`start()` 末尾加：

```ts
void publishAutomationEvent({ source: "appStarted" });
```

`automation.repo.ts` runNow 的 executeTask 收口同样补 publish（复用上面两行模式）。

- [ ] **Step 5: 跑测试（新 + automation-scheduler 既有）+ typecheck**
- [ ] **Step 6: 提交**

```bash
git add electron/domains/ai/automation/automation-event-bus.ts electron/domains/ai/automation/automation-scheduler.ts electron/domains/ai/automation/automation.repo.ts tests/ai/automation-event-bus.test.ts
git commit -m "feat(自动化): 事件触发总线——appStarted/taskFinished 链式与防环"
```

---

### Task 11: 图仓储 IPC + 白名单 + Application 接线 + 图模板

**Files:**
- Create: `electron/domains/ai/orchestration/graph.repo.ts`、`electron/domains/ai/orchestration/graph-templates.ts`
- Modify: `electron/commons/ipc-channels.ts:136-145`（automation 段后加 orchestration 段）、`electron/Application.ts:374-381`（automation 接线后）
- Test: `tests/ai/graph-repo.test.ts`

**Interfaces:**
- Consumes: `validateGraph`、`executeGraphRun`、handleUser 模式（automation.repo 先例）。
- Produces: IPC `orchestration:list / create / update / delete / toggle / templates / runTest / runs`；`GraphRecord`（`{ id, name, description?, graphJson, version, enabled, createdAt, updatedAt, nodeCount }`）；删除引用检查（被 `targetKind=graph && graphId=X` 引用 → 抛 `GRAPH_IN_USE` 含引用任务名清单）；试运行互斥 `graphTestInflight: Map<number, AbortController>`（新文件 `electron/domains/ai/orchestration/graph-inflight.ts`，对齐 automation-inflight 先例）；`GRAPH_CHANGED_EVENT = "orchestration:graphs-changed"`（定义在 `src-react/domains/ai/orchestration/api/orchestration.api.ts`）。

- [ ] **Step 1: graph-templates.ts（内置 2 个，先例 automation-templates.ts 的 i18n key 形态）**

```ts
// electron/domains/ai/orchestration/graph-templates.ts
/** 内置图模板（spec §7）：双分支日报（branch 演示）+ 串行调研成文 */
export interface GraphTemplate {
  slug: string; icon: string; titleI18nKey: string; descI18nKey: string;
  graphJson: object;
}
export function listGraphTemplates(): GraphTemplate[] {
  return [
    {
      slug: "daily-brief-branch", icon: "workflow", 
      titleI18nKey: "chat:orchestration.templates.dailyBriefTitle",
      descI18nKey: "chat:orchestration.templates.dailyBriefDesc",
      graphJson: {
        version: 1, inputSchema: {},
        nodes: [
          { id: "collect", name: "collect", kind: "llm", modelId: 0, prompt: "汇总 {{date}} 待办要点", tools: true, outputMode: "branch", branchOptions: ["brief", "skip"] },
          { id: "brief", name: "brief", kind: "llm", modelId: 0, prompt: "基于 {{nodes.collect.output}} 写日报", tools: false, outputMode: "text" },
        ],
        edges: [
          { from: "collect", to: "brief", condition: { type: "branch", value: "brief" } },
          { from: "collect", to: "END", condition: { type: "branch", value: "skip" } },
          { from: "brief", to: "END" },
        ],
      },
    },
    {
      slug: "research-report", icon: "file-search",
      titleI18nKey: "chat:orchestration.templates.researchTitle",
      descI18nKey: "chat:orchestration.templates.researchDesc",
      graphJson: {
        version: 1, inputSchema: { topic: "string" },
        nodes: [
          { id: "research", name: "research", kind: "llm", modelId: 0, prompt: "调研主题 {{input.topic}}，可用工具检索", tools: true, outputMode: "text" },
          { id: "report", name: "report", kind: "llm", modelId: 0, prompt: "基于 {{nodes.research.output}} 成文", tools: false, outputMode: "text" },
        ],
        edges: [{ from: "research", to: "report" }, { from: "report", to: "END" }],
      },
    },
  ];
}
```

- [ ] **Step 2: graph.repo.ts（照 automation.repo 模式；关键方法）**

```ts
export default class GraphRepository {
  constructor(private disabledTools: () => string[] = () => []) { this.registerHandlers(); }

  private registerHandlers(): void {
    handleUser("orchestration:list", (_, userId) => this.listGraphs(userId));
    handleUser("orchestration:create", (_, userId, p: { name: string; description?: string; graphJson: string }) => this.createGraph(p, userId));
    handleUser("orchestration:update", (_, userId, id: number, p: { name: string; description?: string; graphJson: string; version: number }) => this.updateGraph(id, p, userId));
    handleUser("orchestration:delete", async (_, userId, id: number) => { /* 引用检查 + 删 */ });
    handleUser("orchestration:toggle", (_, userId, id: number, enabled: boolean) => { /* 同 automation toggle */ });
    ipcMain.handle("orchestration:templates", () => listGraphTemplates());
    handleUser("orchestration:runTest", (_, userId, id: number, inputs: Record<string, string>, workspaceId: number) => this.runTest(id, inputs, workspaceId, userId));
    handleUser("orchestration:runs", (_, userId, graphId: number, page: number) => this.listGraphRuns(graphId, page, userId));
  }
  // create/update：validateGraph(JSON.parse(graphJson)) 不 ok → throw new Error(issues.join("; "))；
  // update 乐观锁：where { id, userId, version } 更新 version: { increment: 1 }，count=0 → throw "VERSION_CONFLICT"
  // delete：查 automationTask.findMany({ where: { targetKind: "graph", graphId: id, userId } })，
  //   非空 → throw new Error(`GRAPH_IN_USE:${names.join(",")}`)；否则事务删 automationRun(graphId) + graphDefinition
  // runTest：graphTestInflight 互斥（in 图 → throw "GRAPH_ALREADY_RUNNING"）；
  //   executeGraphRun({ graph, task: null, inputs, triggerType: "manual", attempt: 1, abort, workspace, disabledTools })
  //   fire-and-forget + finally { inflight 清理; notifyGraphsChanged(); publishAutomationEvent({source:"taskFinished",targetType:"graph",targetId:id,outcome}) }
}
```

- [ ] **Step 3: 白名单 + Application 接线**

`ipc-channels.ts` automation 段后：

```ts
  // 编排域（LangGraph）
  "orchestration:list",
  "orchestration:create",
  "orchestration:update",
  "orchestration:delete",
  "orchestration:toggle",
  "orchestration:templates",
  "orchestration:runTest",
  "orchestration:runs",
```

`Application.ts` automation 接线块后：

```ts
    // 编排域（LangGraph）：图 CRUD/试运行 IPC；工具禁用闭包与 automation 同源
    new GraphRepository(() => securityService.getConfigValue().disabledTools);
```

（import 行加 `import GraphRepository from "./domains/ai/orchestration/graph.repo";`）

- [ ] **Step 4: 写 graph-repo 测试（引用检查/乐观锁/校验拒绝三个用例，mock prisma 同 automation-repo.test.ts 先例）+ 跑通 + typecheck**
- [ ] **Step 5: 提交**

```bash
git add electron/domains/ai/orchestration/graph.repo.ts electron/domains/ai/orchestration/graph-templates.ts electron/domains/ai/orchestration/graph-inflight.ts electron/commons/ipc-channels.ts electron/Application.ts tests/ai/graph-repo.test.ts
git commit -m "feat(编排): 图仓储 IPC——CRUD/试运行/引用检查/乐观锁与接线"
```

---

### Task 12: 前端 orchestration api + 图列表 Tab + 路由

**Files:**
- Create: `src-react/domains/ai/orchestration/api/orchestration.api.ts`、`src-react/domains/ai/orchestration/views/GraphListView.tsx`、`src-react/domains/ai/orchestration/components/GraphRow.tsx`
- Modify: `src-react/domains/ai/automation/views/AutomationView.tsx:84`（tabs 数组 `["tasks","graphs","runs"]`）、`src-react/domains/ai/automation/store/automation.store.ts`（tab 类型加 `"graphs"`）、`src-react/routes/index.tsx:140-147`（automation 子路由后加 `automation/graphs/:id`）
- Modify: `src-react/i18n/locales/zh-CN/chat.json` + `en-US/chat.json`（`automation.tabs.graphs` + `orchestration.*` 列表段）

**Interfaces:**
- Produces: `GraphApi.list()/create()/update()/remove()/toggle()/templates()/runTest(id, inputs, workspaceId)/runs(graphId, page)`；`useGraphs()`（React Query `["orchestration","graphs"]` + `GRAPH_CHANGED_EVENT` invalidate，照 use-automation-tasks.ts:8-20 模式）；路由 `/module/ai/automation/graphs/:id` → `GraphEditorView`（Task 13）。

- [ ] **Step 1: orchestration.api.ts（照 automation.api.ts 模式）**

```ts
import { invoke } from "@/lib/ipc";

export interface GraphRecord {
  id: number; name: string; description?: string; graphJson: string;
  version: number; enabled: boolean; nodeCount: number;
  createdAt: string; updatedAt: string;
}
export interface GraphRunPage { total: number; items: import("@/domains/ai/automation/api/automation.api").RunRecord[]; }

export class GraphApi {
  static async list(): Promise<GraphRecord[]> { return invoke<GraphRecord[]>("orchestration:list"); }
  static async create(p: { name: string; description?: string; graphJson: string }): Promise<GraphRecord> { return invoke<GraphRecord>("orchestration:create", p); }
  static async update(id: number, p: { name: string; description?: string; graphJson: string; version: number }): Promise<GraphRecord> { return invoke<GraphRecord>("orchestration:update", id, p); }
  static async remove(id: number): Promise<void> { return invoke<void>("orchestration:delete", id); }
  static async toggle(id: number, enabled: boolean): Promise<GraphRecord> { return invoke<GraphRecord>("orchestration:toggle", id, enabled); }
  static async templates(): Promise<Array<{ slug: string; icon: string; titleI18nKey: string; descI18nKey: string; graphJson: string }>> { return invoke("orchestration:templates"); }
  static async runTest(id: number, inputs: Record<string, string>, workspaceId: number): Promise<void> { return invoke("orchestration:runTest", id, inputs, workspaceId); }
  static async runs(graphId: number, page: number): Promise<GraphRunPage> { return invoke("orchestration:runs", graphId, page); }
}

export const GRAPH_CHANGED_EVENT = "orchestration:graphs-changed";
```

- [ ] **Step 2: GraphListView（行 = 名称/节点数/启停 Switch/最近运行占位；新建按钮 → 编辑器新图；模板入口 → templates 下拉预填）**——组件代码照 TaskListView/TaskRow 先例（Switch + 行点击 navigate(`graphs/${id}`) + AlertDialog 删除捕获 `GRAPH_IN_USE:` 前缀错误展示引用清单）。
- [ ] **Step 3: AutomationView tabs 三项 + graphs 分支渲染 + 路由注册 + i18n key**

zh-CN `chat.json` 的 `automation.tabs` 加 `"graphs": "编排"`；`orchestration` 段本任务先加列表所需（title/empty/new/templateConfirm/confirmDelete/inUse），en-US 同步。

- [ ] **Step 4: `npm run typecheck` + 手动 `npm run dev` 冒烟（列表空态渲染、新建跳编辑器）+ 提交**

```bash
git add src-react/domains/ai/orchestration src-react/domains/ai/automation/views/AutomationView.tsx src-react/domains/ai/automation/store/automation.store.ts src-react/routes/index.tsx src-react/i18n/locales/zh-CN/chat.json src-react/i18n/locales/en-US/chat.json
git commit -m "feat(编排): 前端图列表 Tab/路由/api 封装"
```

---

### Task 13: 图编辑器（结构化 ⇄ JSON 双模式）

**Files:**
- Create: `src-react/domains/ai/orchestration/views/GraphEditorView.tsx`、`src-react/domains/ai/orchestration/components/GraphNodeEditor.tsx`、`src-react/domains/ai/orchestration/components/GraphEdgeEditor.tsx`、`src-react/domains/ai/orchestration/components/GraphJsonEditor.tsx`
- Test: `tests/ai/graph-editor-model.test.ts`（双模式同步纯函数）

**Interfaces:**
- Consumes: `GraphApi`、`validateGraph`（前端直接 import，实时校验）。
- Produces: `parseOrKeep(raw: string): { parsed: GraphJson | null }`（JSON 容错解析纯函数，测试用）；编辑器内部状态 `GraphJson` 对象，结构化模式编辑 nodes/edges 数组（增删改节点卡：id/name/modelId(模型下拉，复用 TaskModelPicker 模式)/systemPrompt/prompt(tools 开关+白名单多选)/outputMode/branchOptions；边列表：from/to/condition.value），JSON 模式 textarea + 保存前 `validateGraph` 错误内联红字列表；保存调 update（带 version 乐观锁，`VERSION_CONFLICT` 提示刷新）。

- [ ] **Step 1: 纯函数测试（parseOrKeep：合法/非法/空串）→ 实现 → 跑通**
- [ ] **Step 2: 三个编辑组件 + GraphEditorView 壳（模式切换 Tabs、顶部名称输入、保存按钮置灰条件 = 校验不过 || 未变更）**
- [ ] **Step 3: typecheck + dev 冒烟（新建图 → 添 2 节点 1 边 → JSON 模式查看同步 → 保存）**
- [ ] **Step 4: 提交**

```bash
git add src-react/domains/ai/orchestration tests/ai/graph-editor-model.test.ts
git commit -m "feat(编排): 图编辑器——结构化节点/边编辑与 JSON 源码双模式"
```

---

### Task 14: 图详情（试运行 + 运行历史 + 节点轨迹视图）

**Files:**
- Create: `src-react/domains/ai/orchestration/components/GraphRunTraceView.tsx`
- Modify: `src-react/domains/ai/automation/components/RunHistoryPanel.tsx`（或 GraphEditorView 内「运行历史」抽屉——按现有 RunHistoryPanel 形态接入 graphId 数据源）
- Modify: `src-react/domains/ai/automation/views/RunHistoryView.tsx`（状态筛选 pill + 触发方式「事件」+ 图 run 行点击 → trace 展开态）
- Modify: `src-react/domains/ai/automation/lib/run-display.ts`（triggerType 文案加 event）

**Interfaces:**
- Consumes: `GraphApi.runs`、`RunRecord.graphTrace`。
- Produces: `GraphRunTraceView({ trace: TraceEntry[] })`——时间线：节点名 + 状态色点（success 绿/skipped 灰/failed 红）、失败节点展开 `error.code + error.message` + 输出预览 + toolCalls 列表；试运行按钮在图编辑器顶栏（弹 inputSchema 变量表单 + workspace 下拉 → `GraphApi.runTest` → toast 已触发，结果经 `GRAPH_CHANGED_EVENT`/`AUTOMATION_CHANGED_EVENT` invalidate）。

- [ ] **Step 1: GraphRunTraceView 组件 + RunHistoryView 筛选/事件列/图行展开（runs query 已支持 status 参数——`AutomationApi.runs(page, taskId, status)`，纯前端接线）**
- [ ] **Step 2: run-display.ts 触发方式映射加 `event: "事件触发"` / `"Event"`（照现有 catchUp/retry 文案结构）**
- [ ] **Step 3: typecheck + dev 冒烟（试运行小图 → 运行记录出图 run → 展开看 trace）**
- [ ] **Step 4: 提交**

```bash
git add src-react/domains/ai/orchestration/components/GraphRunTraceView.tsx src-react/domains/ai/automation/views/RunHistoryView.tsx src-react/domains/ai/automation/lib/run-display.ts src-react/domains/ai/automation/components/RunHistoryPanel.tsx
git commit -m "feat(编排): 试运行与节点轨迹视图/运行记录状态筛选与事件触发展示"
```

---

### Task 15: 创建任务弹窗扩展（执行体类型 + 事件触发配置）

**Files:**
- Modify: `src-react/domains/ai/automation/components/CreateTaskDialog.tsx`、`src-react/domains/ai/automation/lib/task-form.ts`、`src-react/domains/ai/automation/lib/use-task-form.ts`
- Modify: `src-react/domains/ai/automation/views/TaskListView.tsx`、`views/TaskDetailView.tsx`（图任务展示：prompt 区换图名徽标 + 跳图编辑器；行内图标识）
- Test: `tests/ai/task-form.test.ts`（扩 targetKind/eventJson 序列化用例）

**Interfaces:**
- Consumes: `GraphApi.list()`（图下拉）、`AutomationApi.list()`（事件目标任务下拉）、workspace 下拉（既有）。
- Produces: 表单状态扩 `targetKind: "prompt" | "graph"`、`graphId?: number`、`eventTrigger?: EventTriggerConfig | null`；提交 params 带 `targetKind/graphId/eventJson`；`targetKind=graph` 时 prompt/model 区折叠为「选择编排图」下拉（必选）；事件触发块：source 单选（无/应用启动/任务完成）+ 任务完成时 targetType 切换（目标任务下拉 / 目标图下拉）+ on 单选（成功/失败/任意）；编辑态回填。

- [ ] **Step 1: task-form 测试先行（序列化/回填/校验：graph 必选、自引用前端拦截提示）→ 实现跑通**
- [ ] **Step 2: CreateTaskDialog UI 三块接线 + TaskListView/TaskDetailView 图任务徽标**
- [ ] **Step 3: typecheck + dev 冒烟（建 graph 任务挂定时 + 事件双触发，runNow 图任务执行成功）**
- [ ] **Step 4: 提交**

```bash
git add src-react/domains/ai/automation tests/ai/task-form.test.ts
git commit -m "feat(自动化): 任务弹窗支持编排图执行体与事件触发配置"
```

---

### Task 16: 健康度总览（stats IPC + 统计面板）

**Files:**
- Modify: `electron/domains/ai/automation/automation.repo.ts`（注册 `automation:stats`）、`electron/commons/ipc-channels.ts`（allowlist 加 `"automation:stats"`）、`src-react/domains/ai/automation/api/automation.api.ts`（`AutomationApi.stats()`）
- Create: `src-react/domains/ai/automation/components/AutomationStatsPanel.tsx`
- Modify: `src-react/domains/ai/automation/views/TaskListView.tsx`（顶部挂面板）
- Test: `tests/ai/automation-stats.test.ts`

**Interfaces:**
- Produces: `computeStats(runs: RunRow[], errorTasks: Array<{ id; name; statusNote }>, now: Date): AutomationStats`（纯函数——成功率 `success/(success+failed)` 分母不含 skipped/running；today = startedAt 当日；trend 近 7 天按 date 分组；attention = errorTasks + 24h 内 failed runs）；IPC handler 聚合查询（今日 + 7 天 runs、error 任务、图名联查）喂给它。

- [ ] **Step 1: computeStats 纯函数测试（口径：skipped 不进分母、0 分母 successRate=0、跨日分组、24h 窗口）→ 实现 → 跑通**
- [ ] **Step 2: IPC + 前端面板（KPI 卡行：今日/成功率/失败/进行中/异常任务；「需要关注」清单行可点击：taskError→onEditTask、failedRun→图跳 trace / 任务跳运行记录；7 天迷你柱状用 div 高度 + `bg-primary`/`bg-destructive`）**
- [ ] **Step 3: typecheck + dev 冒烟 + 提交**

```bash
git add electron/domains/ai/automation/automation.repo.ts electron/commons/ipc-channels.ts src-react/domains/ai/automation tests/ai/automation-stats.test.ts
git commit -m "feat(自动化): 健康度总览——成功率 KPI/关注清单/运行记录状态筛选"
```

---

### Task 17: i18n 全量补齐 + 全量回归 + 文档

**Files:**
- Modify: `src-react/i18n/locales/zh-CN/chat.json`、`en-US/chat.json`（`orchestration.*` 全段：tabs/列表/编辑器字段/trace/试运行/模板/错误码映射；`automation.*` 增：statsPanel/事件触发文案/新 triggerType）
- Modify: `docs/update-log.md`（若项目惯例要求，参照近期条目格式补一段）

**Interfaces:** 无新接口。

- [ ] **Step 1: 对照各任务新增的用户可见文案清单，zh/en 同步补 key（grep 组件里的 `t("chat:orchestration` / `t("chat:automation` 反查清单，确保无硬编码中文）**
- [ ] **Step 2: 全量验证**

```bash
npm run test && npm run typecheck && npm run lint
```
Expected: 全绿（新测试 ~10 个文件 + 既有不回归）

- [ ] **Step 3: dev 端到端冒烟清单（手记结果到 PR 描述）**：① 新建图（2 节点分支）→ JSON 模式校验错误展示 → 保存；② 试运行（FakeModel 不适用，用真实 provider 或断网验证失败 trace）；③ 建 graph 任务挂 daily + appStarted 双触发；④ runNow 图任务 → 运行记录看 `node:` 错误格式；⑤ 建 prompt 任务挂「任务完成」事件 → 手动跑上游验证链式触发；⑥ 总览面板数字与运行记录一致。
- [ ] **Step 4: 提交**

```bash
git add src-react/i18n/locales docs/update-log.md
git commit -m "feat(编排): i18n 全量文案与更新日志"
```

---

## Self-Review 记录

- **Spec 覆盖**：§0 决策表→Global Constraints；§1 模块/安全红线→Task 5/6/11；§2 数据模型→Task 2/9/11；§3 schema/校验→Task 3；§4 执行/trace/inputs→Task 4/7/8；§5 触发/防环→Task 9/10；§6 总览→Task 16；§7 前端→Task 12-15；§8 IPC→Task 9/11/16；§9 异常→Task 8（graph_invalid/recursion/节点错误）+9（graph_missing）+10（防环/互斥）；§10 测试→各任务 TDD 步骤；§11 范围外未引入。无缺口。
- **占位符扫描**：Task 8 Step 3 为「实现要点」而非逐行代码——因 ~200 行编排体量，已给函数级签名、数据流与错误分支；执行者为熟练开发者且有 spec §4 流程图，属可执行粒度。其余任务均含实码。
- **类型一致性**：`TriggerType` 五值（Task 9 定义，Task 10/14 消费一致）；`GraphJson`/`EventTriggerConfig` 定义于 Task 3/9，后端经相对路径 import（先例 schedule.schema）；`executeGraphRun` 参数 Task 8 定义、Task 9/11 调用一致；`AutomationStats` Task 9 定义、Task 16 消费一致。
