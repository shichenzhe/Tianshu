# 图编排三项改进实施计划（试运行异步化 / 节点超时修复 / 开始节点）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `run_workflow` 工具异步化 + 手工中断；修复 agent 工具步与向量节点超时失效；新增 start 节点承载图输入变量。

**Architecture:** 工具触发改 launch 型 fire-and-forget，配套 `get_workflow_run` 查询工具与 `orchestration:cancelTestRun` 中断 IPC；超时修复走既有 signal 链路补挂；start 节点为 schema 新 kind，`graph.inputSchema` 保持单一事实源（start 节点编辑时同步回写）。

**Tech Stack:** Electron 主进程 IPC（handleUser）、zod schema、LangGraph 执行内核、React 19 + React Query、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-08-graph-run-timeout-start-node-design.md`

## Global Constraints

- i18n：所有用户可见文案走 `t()`，zh-CN/en-US 同步加 key；key 嵌套 camelCase；禁止顶层 key 与嵌套对象重名
- 测试框架 Vitest；生产代码禁 `console`（用 `Log`）；Prettier 双引号分号
- `create-workflow.ts` 为纯 Node 模块（禁 import electron）；prisma 经接口注入可测
- 提交信息 conventional commit（feat/test/docs 前缀）
- 每任务收尾跑该任务相关测试；Task 9 全量验证

---

### Task 1: `run_workflow` 异步化 + `get_workflow_run` 工具

**Files:**
- Modify: `electron/domains/ai/orchestration/create-workflow.ts`（`makeRunWorkflowTool` 350-405 行区域；新增 `makeGetWorkflowRunTool`）
- Modify: `electron/domains/ai/orchestration/graph.repo.ts`（185-192 行 `makeRunWorkflowTool` 注入处；`launchTestRun` 745 行 private → public）
- Test: `tests/ai/create-workflow.test.ts`（"run_workflow 工具" describe 297 行起）

**Interfaces:**
- Consumes: `graphTestInflight`（`graph-inflight.ts`，纯模块可 import）；`ToolDefinition`/`ToolContext`（`../agent/file-tools`）
- Produces:
  - `export type LaunchTestRunFn = (params: { graph: WorkflowGraphRow; inputs: Record<string, string>; workspace: { id: number; directoryPath: string | null } }) => void`
  - `export interface WorkflowRunPrismaLike { findFirst(args: { where: { graphId: number }; orderBy: { startedAt: "desc" } }): Promise<{ id: number; status: string; error: string | null; graphTrace: string | null; startedAt: Date } | null> }`
  - `makeRunWorkflowTool(deps: { graphDefinition; session; workspace; launch: LaunchTestRunFn })`
  - `makeGetWorkflowRunTool(deps: { graphDefinition; session; runs: WorkflowRunPrismaLike })`
  - `GraphRepository.launchTestRun(graph, inputs, workspace): void`（原 private 提公共）

- [ ] **Step 1: 写失败测试（替换 create-workflow.test.ts 的 run_workflow describe 块）**

```ts
describe("run_workflow 工具（异步触发）", () => {
  it("触发即返回「已启动」，launch 恰好一次且不等待结果", async () => {
    const stubs = createStubs();
    const create = makeCreateWorkflowTool(stubs as never);
    await create.execute(CTX, { name: "r-flow", graphJson: VALID_GRAPH });
    const launch = vi.fn();
    const run = makeRunWorkflowTool({ ...stubs, launch } as never);
    const result = await run.execute(CTX, { id: 1, inputs: { topic: "x" } });
    expect(result).toContain("已启动");
    expect(result).toContain("get_workflow_run");
    expect(launch).toHaveBeenCalledTimes(1);
    const params = launch.mock.calls[0][0];
    expect(params.inputs).toEqual({ topic: "x" });
    expect(params.workspace).toEqual({ id: 9, directoryPath: "/ws" });
  });

  it("在途互斥 GRAPH_ALREADY_RUNNING 前置拦截", async () => {
    const stubs = createStubs();
    const create = makeCreateWorkflowTool(stubs as never);
    await create.execute(CTX, { name: "m-flow", graphJson: VALID_GRAPH });
    graphTestInflight.set(1, new AbortController());
    try {
      const launch = vi.fn();
      const run = makeRunWorkflowTool({ ...stubs, launch } as never);
      const result = await run.execute(CTX, { id: 1 });
      expect(result).toContain("正在运行");
      expect(launch).not.toHaveBeenCalled();
    } finally {
      graphTestInflight.delete(1);
    }
  });

  it("图不存在 / 无 workspacePath / workspace 记录缺失 → 明确错误", async () => {
    const stubs = createStubs();
    const create = makeCreateWorkflowTool(stubs as never);
    await create.execute(CTX, { name: "w-flow", graphJson: VALID_GRAPH });
    const launch = vi.fn();
    const run = makeRunWorkflowTool({ ...stubs, launch } as never);
    expect(await run.execute(CTX, { id: 99 })).toContain("不存在");
    expect(await run.execute({ ...CTX, workspacePath: "" }, { id: 1 })).toContain("未绑定工作空间");
    expect(await run.execute({ ...CTX, workspacePath: "/other" }, { id: 1 })).toContain("工作空间记录");
    expect(launch).not.toHaveBeenCalled();
  });
});

describe("get_workflow_run 工具", () => {
  it("查最近一条 run：状态/耗时/终点输出预览", async () => {
    const stubs = createStubs();
    const runs = {
      findFirst: vi.fn(async () => ({
        id: 9,
        status: "success",
        error: null,
        graphTrace: JSON.stringify([
          { nodeId: "a", status: "success", output: "hello" },
          { nodeId: "b", status: "success", output: "world" },
        ]),
        startedAt: new Date("2026-10-08T10:00:00Z"),
      })),
    };
    const tool = makeGetWorkflowRunTool({ ...stubs, runs } as never);
    const result = await tool.execute(CTX, { id: 1 });
    expect(result).toContain("success");
    expect(result).toContain("world");
  });

  it("失败 run 带 error；无记录明示", async () => {
    const stubs = createStubs();
    const runs = {
      findFirst: vi.fn(async () => ({
        id: 10,
        status: "failed",
        error: "llm_timeout: 模型调用超时",
        graphTrace: null,
        startedAt: new Date(),
      })),
    };
    const tool = makeGetWorkflowRunTool({ ...stubs, runs } as never);
    expect(await tool.execute(CTX, { id: 1 })).toContain("llm_timeout");
    runs.findFirst.mockResolvedValue(null);
    expect(await tool.execute(CTX, { id: 1 })).toContain("暂无运行记录");
  });
});
```

测试文件头部补 import：`import { graphTestInflight } from "../../electron/domains/ai/orchestration/graph-inflight";` 与 `makeGetWorkflowRunTool`。`createStubs` 里若已含 graphDefinition/session/workspace（沿用现有 stub 形态，见文件 240 行附近）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/create-workflow.test.ts`
Expected: FAIL——`launch is not a function` / `makeGetWorkflowRunTool is not a function`

- [ ] **Step 3: 实现（create-workflow.ts）**

删除 `RunGraphFn` 类型与 `makeRunWorkflowTool` 中的 `await deps.runGraph(...)` 同步等待，替换为：

```ts
/** 试运行发射器注入（run_workflow 用；repo 的 launchTestRun 包装，
 * fire-and-forget；测试注 stub 免拉 executor 重依赖） */
export type LaunchTestRunFn = (params: {
  graph: WorkflowGraphRow;
  inputs: Record<string, string>;
  workspace: { id: number; directoryPath: string | null };
}) => void;

/** run_workflow：异步触发（触发即返回；结果落运行历史，AI 可用
 * get_workflow_run 查询——长图勿高频轮询，建议隔轮再查） */
export function makeRunWorkflowTool(deps: {
  graphDefinition: WorkflowGraphPrismaLike;
  session: SessionPrismaLike;
  workspace: WorkspacePrismaLike;
  launch: LaunchTestRunFn;
}): ToolDefinition<z.infer<typeof runWorkflowSchema>> {
  return {
    name: "run_workflow",
    description:
      "异步试运行一个已保存的工作流（写操作，需用户批准——会真实执行模型调用/文件读写等）。触发后立即返回，结果落「工作流」页运行历史；长任务请隔一轮对话再用 get_workflow_run 查询，勿高频轮询",
    parameters: runWorkflowSchema,
    kind: "write",
    execute: async (ctx, args) => {
      const userId = await userIdOf(ctx, deps.session);
      if (userId === null) {
        return "错误: 会话不存在，无法确定当前用户";
      }
      if (!ctx.workspacePath) {
        return "错误: 当前会话未绑定工作空间目录，无法运行";
      }
      const row = await deps.graphDefinition.findFirst({
        where: { id: args.id, userId },
      });
      if (!row) {
        return "错误: 工作流不存在（可先用 list_workflows 核对 id）";
      }
      const ws = await deps.workspace.findFirst({
        where: { directoryPath: ctx.workspacePath, userId },
      });
      if (!ws) {
        return `错误: 未找到目录 ${ctx.workspacePath} 对应的工作空间记录`;
      }
      if (graphTestInflight.has(args.id)) {
        return "错误: 该工作流正在运行中（同一图同时至多一个试运行），请稍后用 get_workflow_run 查询";
      }
      deps.launch({ graph: row, inputs: args.inputs ?? {}, workspace: { id: ws.id, directoryPath: ws.directoryPath } });
      return "已启动试运行（异步执行中）。结果可在「工作流」页运行历史查看，或稍后调用 get_workflow_run 查询最近一次运行结果";
    },
  };
}
```

文件头部补 `import { graphTestInflight } from "./graph-inflight";`。

新增（放在 makeRunWorkflowTool 之后）：

```ts
/** automationRun 查询注入（get_workflow_run 用） */
export interface WorkflowRunPrismaLike {
  findFirst(args: {
    where: { graphId: number };
    orderBy: { startedAt: "desc" };
  }): Promise<{
    id: number;
    status: string;
    error: string | null;
    graphTrace: string | null;
    startedAt: Date;
  } | null>;
}

const getWorkflowRunSchema = z.object({
  id: z.number().int().positive().describe("工作流 id"),
});

/** get_workflow_run：查该工作流最近一次运行（status/耗时/终点输出
 * 预览/失败原因）；graphTrace 缺失时只报状态 */
export function makeGetWorkflowRunTool(deps: {
  graphDefinition: WorkflowGraphPrismaLike;
  session: SessionPrismaLike;
  runs: WorkflowRunPrismaLike;
}): ToolDefinition<z.infer<typeof getWorkflowRunSchema>> {
  return {
    name: "get_workflow_run",
    description:
      "查询一个工作流最近一次运行的结果（状态/耗时/终点输出预览/失败原因）。长任务请间隔查询，勿连续轮询",
    parameters: getWorkflowRunSchema,
    kind: "read",
    execute: async (ctx, args) => {
      const userId = await userIdOf(ctx, deps.session);
      if (userId === null) {
        return "错误: 会话不存在，无法确定当前用户";
      }
      const graph = await deps.graphDefinition.findFirst({
        where: { id: args.id, userId },
      });
      if (!graph) {
        return "错误: 工作流不存在（可先用 list_workflows 核对 id）";
      }
      const run = await deps.runs.findFirst({
        where: { graphId: args.id },
        orderBy: { startedAt: "desc" },
      });
      if (!run) {
        return "暂无运行记录（run_workflow 触发后此处可查）";
      }
      const lines = [
        `运行 ${run.status}（runId=${run.id}，开始于 ${run.startedAt.toISOString()}）`,
      ];
      if (run.error) {
        lines.push(`失败原因: ${run.error}`);
      }
      const preview = lastTraceOutput(run.graphTrace);
      if (preview !== null) {
        lines.push(
          preview.length > 500 ? `输出: ${preview.slice(0, 500)}…` : `输出: ${preview}`,
        );
      }
      return lines.join("\n");
    },
  };
}

/** graphTrace JSON → 最后一个 success 节点的 output 预览（无则 null） */
function lastTraceOutput(graphTrace: string | null): string | null {
  if (!graphTrace) {
    return null;
  }
  try {
    const entries = JSON.parse(graphTrace) as Array<{
      status?: string;
      output?: string;
    }>;
    const hit = [...entries].reverse().find((e) => e.status === "success");
    return hit?.output ?? null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 改 graph.repo.ts 注入**

`launchTestRun` 的 `private` 修饰去掉（745 行）。工具注册块（185-192 行）改为：

```ts
      makeRunWorkflowTool({
        graphDefinition: graphDelegate,
        session: sessionDelegate,
        workspace: prisma.workspace as unknown as WorkspacePrismaLike,
        // 异步发射（fire-and-forget）：互斥/收尾在 launchTestRun 内
        launch: (p) => this.launchTestRun(p.graph as never, p.inputs, p.workspace),
      }),
      makeGetWorkflowRunTool({
        graphDefinition: graphDelegate,
        session: sessionDelegate,
        runs: prisma.automationRun as unknown as WorkflowRunPrismaLike,
      }),
```

import 行同步补 `makeGetWorkflowRunTool`、`WorkflowRunPrismaLike`、删除不再使用的 `RunGraphFn`（若 `runGraphToResult` 仍被别处用则保留其 import）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/ai/create-workflow.test.ts tests/ai/graph-repo.test.ts`
Expected: PASS（graph-repo.test.ts 若有 runTest 相关既有用例须保持绿）

- [ ] **Step 6: Commit**

```bash
git add electron/domains/ai/orchestration/create-workflow.ts electron/domains/ai/orchestration/graph.repo.ts tests/ai/create-workflow.test.ts
git commit -m "feat(workflow): run_workflow 工具异步化并新增 get_workflow_run 查询"
```

---

### Task 2: `cancelTestRun` IPC + 中断 run 终态归一

**Files:**
- Modify: `electron/domains/ai/orchestration/graph.repo.ts`（`runTest` IPC 注册区 227-236 行附近加通道；新增 `cancelTestRun` 方法）
- Modify: `electron/domains/ai/orchestration/graph-executor.ts`（`runGraph` catch 350 行 error 归一）
- Test: `tests/ai/graph-repo.test.ts`（新增 describe）；`tests/ai/graph-executor.test.ts`（中断归一用例）

**Interfaces:**
- Consumes: `graphTestInflight`（`Map<number, AbortController>`）
- Produces: IPC 通道 `orchestration:cancelTestRun`（渲染端 invoke 参数 `graphId: number`，无在途抛 `GRAPH_NOT_RUNNING`，图不存在抛 `GRAPH_NOT_FOUND`）；run.error 归一值 `{ code: "user_aborted", message: "已被用户中断" }`

- [ ] **Step 1: 写失败测试（graph-repo.test.ts 新增）**

```ts
describe("cancelTestRun", () => {
  it("有在途 → abort 且 inflight 清理由执行收尾负责", async () => {
    const abort = new AbortController();
    graphTestInflight.set(5, abort);
    const before = vi.fn();
    abort.signal.addEventListener("abort", before);
    await repo.cancelTestRun(5, UID);
    expect(before).toHaveBeenCalled();
  });

  it("无在途 → GRAPH_NOT_RUNNING", async () => {
    await expect(repo.cancelTestRun(5, UID)).rejects.toThrow("GRAPH_NOT_RUNNING");
  });

  it("图不属于该用户 → GRAPH_NOT_FOUND（不触碰他人 inflight）", async () => {
    (prisma.graphDefinition.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(repo.cancelTestRun(404, UID)).rejects.toThrow("GRAPH_NOT_FOUND");
  });
});
```

（沿用该文件既有的 prisma/ipc mock 三件套与 `UID`、`repo` 布局；`graphTestInflight` import 自 `../../electron/domains/ai/orchestration/graph-inflight`；`cancelTestRun(5, UID)` 第一个用例需 mock `graphDefinition.findFirst` 返回 `{ id: 5 }` 形状行。）

- [ ] **Step 2: 写失败测试（graph-executor.test.ts 中断归一）**

```ts
it("图中止（ctx.abort 触发）→ run 落 failed 且 error 归一 user_aborted", async () => {
  const abort = new AbortController();
  const graphJson = JSON.stringify({
    version: 1,
    inputSchema: {},
    nodes: [llmNode()],
    edges: [],
  });
  const p = runGraphToResult(baseParams(graphJson, { abort: abort.signal }), depsWithModelThatHangs(abort));
  await new Promise((r) => setTimeout(r, 20));
  abort.abort();
  const result = await p;
  expect(result.status).toBe("failed");
  // finishRun 落库断言：error.code 为 user_aborted（按该测试文件既有
  // finishRun/prisma stub 捕获方式断言）
});
```

（`baseParams`/`llmNode`/模型挂起 stub 参照该文件既有用例的构造模式——找到现有「超时落库」或「失败落库」用例复用其 prisma stub 与模型 stub 写法；模型 stub 的 `invoke` 返回一个 `ctx.abort` 触发时 reject 的 Promise：`new Promise((_, rej) => abort.signal.addEventListener("abort", () => rej(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }))))`。）

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/ai/graph-repo.test.ts tests/ai/graph-executor.test.ts`
Expected: FAIL——`repo.cancelTestRun is not a function`；中断用例 error 断言不匹配

- [ ] **Step 4: 实现**

graph.repo.ts（`runTest` 方法之后新增，IPC 注册区加通道）：

```ts
  /** 手工中断试运行：归属校验后 abort 在途控制器；run 终态由执行
   *  收尾落 failed（error 归一见 executor user_aborted） */
  async cancelTestRun(id: number, userId: number): Promise<void> {
    const graph = await prisma.graphDefinition.findFirst({
      where: { id, userId },
    });
    if (!graph) {
      throw new Error("GRAPH_NOT_FOUND");
    }
    const abort = graphTestInflight.get(id);
    if (!abort) {
      throw new Error("GRAPH_NOT_RUNNING");
    }
    abort.abort();
  }
```

IPC 注册（`orchestration:runTest` 之后）：

```ts
    handleUser("orchestration:cancelTestRun", (_, userId, id: number) =>
      this.cancelTestRun(id, userId),
    );
```

graph-executor.ts `runGraph` catch（350 行）改为：

```ts
  } catch (e) {
    Log.error("图节点执行失败", params.graph.id, e);
    appendSkippedEntries(json, ctx.trace);
    // 图中止（cancelTestRun）→ error 归一 user_aborted（节点超时路径
    // ctx.abort 未触发，不受影响）
    const userAborted = params.abort?.aborted === true;
    await finishRun({
      ...base,
      status: "failed",
      error: userAborted
        ? { code: "user_aborted", message: "已被用户中断" }
        : toRunError(e),
    });
```

（`RunError` 若是 `{ code; message; nodeId? }` 结构字面量直接满足；若 `finishRun` error 参数为序列化 string，则按现有 `toRunError` 返回值的存放方式对齐——先读 `finishRun` 实现再落笔，保持同构。）

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/ai/graph-repo.test.ts tests/ai/graph-executor.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add electron/domains/ai/orchestration/graph.repo.ts electron/domains/ai/orchestration/graph-executor.ts tests/ai/graph-repo.test.ts tests/ai/graph-executor.test.ts
git commit -m "feat(workflow): cancelTestRun 手工中断通道与 user_aborted 终态归一"
```

---

### Task 3: 运行历史弹窗中断按钮

**Files:**
- Modify: `src-react/domains/ai/orchestration/api/orchestration.api.ts`（GraphApi 加 `cancelTestRun`）
- Modify: `src-react/domains/ai/orchestration/components/GraphRunHistoryDialog.tsx`（running 行加中断按钮）
- Modify: `src-react/i18n/locales/zh-CN/chat.json`、`src-react/i18n/locales/en-US/chat.json`（orchestration.testRun 段）
- Test: `tests/ai/graph-run-trace-view.test.tsx` 同目录新增 `tests/ai/graph-run-history-cancel.test.tsx`

**Interfaces:**
- Consumes: IPC `orchestration:cancelTestRun`（Task 2）；弹窗既有 `graphs-changed` 失效链（63 行 useEffect）
- Produces: `GraphApi.cancelTestRun(graphId: number): Promise<void>`

- [ ] **Step 1: 写失败测试**

```tsx
// @vitest-environment jsdom
// GraphRunHistoryDialog：running 行渲染中断按钮，点击 → cancelTestRun；
// 失败（GRAPH_NOT_RUNNING）toast 错误
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const runs = vi.fn();
const cancel = vi.fn();
vi.mock("../../src-react/domains/ai/orchestration/api/orchestration.api", () => ({
  GraphApi: {
    runs: (...a: unknown[]) => runs(...a),
    cancelTestRun: (...a: unknown[]) => cancel(...a),
    GRAPH_CHANGED_EVENT: "orchestration:graphs-changed",
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import GraphRunHistoryDialog from "../../src-react/domains/ai/orchestration/components/GraphRunHistoryDialog";

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <GraphRunHistoryDialog open onOpenChange={() => {}} graphId={1} graphName="g" />
    </QueryClientProvider>,
  );
}

describe("运行历史中断", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    cancel.mockResolvedValue(undefined);
  });

  it("running 行显示中断按钮，点击调用 cancelTestRun(1)", async () => {
    runs.mockResolvedValue({ total: 1, items: [{ id: 9, status: "running", triggerType: "manual", startedAt: "2026-10-08T10:00:00Z", durationMs: null, sessionId: null }] });
    renderDialog();
    const btn = await screen.findByRole("button", { name: /中断|cancelRun/ });
    fireEvent.click(btn);
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(1));
  });

  it("成功/失败行不显示中断按钮；取消失败 toast", async () => {
    runs.mockResolvedValue({ total: 1, items: [{ id: 10, status: "success", triggerType: "manual", startedAt: "2026-10-08T10:00:00Z", durationMs: 100, sessionId: null }] });
    renderDialog();
    await screen.findByText(/2026-10-08|10:00/);
    expect(screen.queryByRole("button", { name: /中断|cancelRun/ })).toBeNull();

    cancel.mockRejectedValue(new Error("GRAPH_NOT_RUNNING"));
    runs.mockResolvedValue({ total: 1, items: [{ id: 11, status: "running", triggerType: "manual", startedAt: "2026-10-08T10:00:00Z", durationMs: null, sessionId: null }] });
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: /中断|cancelRun/ }));
    await waitFor(() => expect(cancel).rejects.toBeTruthy);
  });
});
```

（`RunRecord` 字段以 `automation.api.ts` 实际形状为准——先读该类型再对齐 mock 对象；组件 props 名以 GraphRunHistoryDialog 现有签名为准。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/graph-run-history-cancel.test.tsx`
Expected: FAIL——无中断按钮 / `cancelTestRun is not a function`

- [ ] **Step 3: 实现**

orchestration.api.ts（GraphApi 类内）：

```ts
  /** 手工中断试运行（无在途抛 GRAPH_NOT_RUNNING；收尾推 graphs-changed 自动刷新） */
  static async cancelTestRun(graphId: number): Promise<void> {
    return invoke<void>("orchestration:cancelTestRun", graphId);
  }
```

GraphRunHistoryDialog.tsx：组件顶部加 `const [cancelling, setCancelling] = useState(false);` 与：

```tsx
  async function handleCancelRun() {
    if (cancelling) return;
    setCancelling(true);
    try {
      await GraphApi.cancelTestRun(graphId);
      toast.success(t("chat:orchestration.testRun.cancelSent"));
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setCancelling(false);
    }
  }
```

（`toast`/`mapIpcError` import 参照 GraphTestRunDialog 头部写法。）表格 running 分支（144-146 行 Badge 处）同行状态格后加操作列按钮——放在状态 Badge 同一 `<td>` 内右侧：

```tsx
{run.status === "running" && (
  <Badge variant="secondary">{t("chat:automation.runs.statusRunning")}</Badge>
)}
```

改为：

```tsx
{run.status === "running" && (
  <span className="flex items-center gap-1.5">
    <Badge variant="secondary">{t("chat:automation.runs.statusRunning")}</Badge>
    <Button
      variant="ghost"
      size="sm"
      className="h-6 px-1.5 hover:bg-primary-subtle hover:text-destructive"
      disabled={cancelling}
      aria-label={t("chat:orchestration.testRun.cancelRun")}
      title={t("chat:orchestration.testRun.cancelRun")}
      onClick={(e) => {
        e.stopPropagation();
        void handleCancelRun();
      }}
    >
      <Square className="h-3 w-3" />
    </Button>
  </span>
)}
```

（`Square` 加进 lucide import；`Button` 加进 ui import；`stopPropagation` 防触发行展开。）

i18n（zh-CN / en-US 的 `orchestration.testRun` 段同时加）：

```json
"cancelRun": "中断运行",
"cancelSent": "已发出中断请求，状态稍后自动刷新"
```

en-US：`"Interrupt Run"` / `"Interrupt request sent; status will refresh shortly"`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ai/graph-run-history-cancel.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/orchestration/api/orchestration.api.ts src-react/domains/ai/orchestration/components/GraphRunHistoryDialog.tsx src-react/i18n/locales/zh-CN/chat.json src-react/i18n/locales/en-US/chat.json tests/ai/graph-run-history-cancel.test.tsx
git commit -m "feat(workflow): 运行历史弹窗 running 行手工中断按钮"
```

---

### Task 4: agent 工具步超时修复

**Files:**
- Modify: `electron/domains/ai/orchestration/graph-executor.ts`（`runToolNode` 777 行工具注入 abortSignal）
- Test: `tests/ai/graph-executor.test.ts`（或 tools 节点既有 describe 内）

**Interfaces:**
- Consumes: `runToolNode(node, ctx, model, prompt, signal)` 的既有 `signal` 参数（`runNodeWithRetry` 传入的 `AbortSignal.any([ctx.abort, 超时])`）
- Produces: 工具执行受节点超时约束（中断传播）

- [ ] **Step 1: 写失败测试**

```ts
it("agent 工具步的 abortSignal 含节点超时（timeoutMs 到即中断工具）", async () => {
  // 构造 tools=true、timeoutMs=1000 的 llm 节点，模型 stub 立即返回，
  // 工具 stub 挂起并监听注入的 abortSignal；断言 ~1s 后 signal.aborted
  // 且节点以失败收尾（llm_timeout 或 abort 族错误均可——本用例只锚
  // 「工具步收到超时信号」这一行为）
  let toolSignal: AbortSignal | undefined;
  const deps = baseDeps();
  deps.toLangChainTools = vi.fn((_defs, _agent, opts) => {
    toolSignal = opts.abortSignal;
    return [];
  }) as never;
  const node = llmNode({ tools: true, timeoutMs: 1_000 });
  const ctx = nodeContext();
  const attempt = runNodeWithRetry(node, ctx, "hi");
  await new Promise((r) => setTimeout(r, 1_400));
  expect(toolSignal?.aborted).toBe(true);
  await expect(attempt).rejects.toThrow();
});
```

（`baseDeps`/`llmNode`/`nodeContext` 按该测试文件既有用例的构造 helper 对齐；若 `runNodeWithRetry` 未导出，则改走导出的单节点测试入口或经 `runGraphToResult` 全链路断言 finishRun 的 error——以文件内现成的「工具节点」用例为模板改造。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/graph-executor.test.ts -t "工具步"`
Expected: FAIL——`toolSignal.aborted` 为 false（当前只挂 ctx.abort）

- [ ] **Step 3: 实现（一行改动）**

`runToolNode` 内 777 行：

```ts
  const tools = ctx.deps.toLangChainTools(defs, ctx.agent, {
    // 工具步同样受节点超时约束（正在执行的工具随 signal 中断），
    // 与 LLM 调用同口径
    abortSignal: AbortSignal.any([ctx.abort, signal]),
    onToolCall: (call) => trackToolCall(toolCalls, call, mark),
  });
```

- [ ] **Step 4: 跑测试确认通过（含全文件回归）**

Run: `npx vitest run tests/ai/graph-executor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/orchestration/graph-executor.ts tests/ai/graph-executor.test.ts
git commit -m "fix(workflow): agent 工具步纳入节点超时（abortSignal 合并超时信号）"
```

---

### Task 5: vectorize/vectorSearch 节点超时

**Files:**
- Modify: `src-react/domains/ai/orchestration/api/graph.schema.ts`（两个向量节点 schema 加 `timeoutMs`）
- Modify: `electron/domains/ai/orchestration/graph-executor.ts`（`embedTexts` 加 signal 参数；两个 handler 组装 signal）
- Modify: `src-react/domains/ai/orchestration/lib/graph-editor-model.ts`（新增纯函数 `timeoutSecToMs`）
- Modify: `src-react/domains/ai/orchestration/components/GraphNodeEditor.tsx`（VectorizeNodeFields / VectorSearchNodeFields 加超时字段；http 字段区的 `patchTimeoutSec` 改用公共函数）
- Modify: `src-react/i18n/locales/{zh-CN,en-US}/chat.json`（`orchestration.editor.vectorTimeoutHint`）
- Test: `tests/ai/graph-schema.test.ts`；`tests/ai/graph-nodes-extra.test.ts`（embedTexts signal 用例）；`tests/ai/graph-editor-model.test.ts`（timeoutSecToMs）

**Interfaces:**
- Consumes: `VectorizeNode`/`VectorSearchNode`（schema 类型）
- Produces:
  - schema 字段 `timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000)`（两个向量节点）
  - `embedTexts(modelId: number, texts: string[], signal?: AbortSignal): Promise<number[][]>`
  - `export function timeoutSecToMs(raw: string, fallbackMs: number): number`

- [ ] **Step 1: 写失败测试**

graph-schema.test.ts：

```ts
it("vectorize/vectorSearch 节点 timeoutMs 默认 120s、下限 1s", () => {
  const g1 = parseGraphJson(JSON.stringify({
    version: 1, inputSchema: {},
    nodes: [{ id: "v1", name: "向量化", kind: "vectorize", collection: "c", sourceName: "s", text: "t", modelId: 2 }],
    edges: [],
  }));
  expect(g1.nodes[0].timeoutMs).toBe(120_000);
  const bad = parseGraphJson(JSON.stringify({
    version: 1, inputSchema: {},
    nodes: [{ id: "v1", name: "向量化", kind: "vectorize", collection: "c", sourceName: "s", text: "t", modelId: 2, timeoutMs: 500 }],
    edges: [],
  }));
  expect(bad.ok).toBe(false);
});
```

graph-editor-model.test.ts：

```ts
describe("timeoutSecToMs", () => {
  it("空串回退默认；合法秒转毫秒；非法回退默认", () => {
    expect(timeoutSecToMs("", 120_000)).toBe(120_000);
    expect(timeoutSecToMs("30", 120_000)).toBe(30_000);
    expect(timeoutSecToMs("abc", 120_000)).toBe(120_000);
    expect(timeoutSecToMs("-5", 120_000)).toBe(120_000);
  });
});
```

graph-nodes-extra.test.ts（embedTexts 现有 describe 内）：

```ts
it("embedTexts 将 signal 传入 fetch（向量化超时通道）", async () => {
  const ac = new AbortController();
  const seen: unknown[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    seen.push(init?.signal);
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1] }] }), { status: 200 });
  }) as typeof fetch;
  try {
    await embedTexts(1, ["hi"], ac.signal);
    expect(seen[0]).toBe(ac.signal);
  } finally {
    globalThis.fetch = original;
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/graph-schema.test.ts tests/ai/graph-editor-model.test.ts tests/ai/graph-nodes-extra.test.ts`
Expected: FAIL——timeoutMs 未定义 / timeoutSecToMs 未导出 / signal 未传

- [ ] **Step 3: 实现**

graph.schema.ts——`vectorizeNodeSchema` 与 `vectorSearchNodeSchema` 各加一行（`modelId` 之后）：

```ts
  /** embedding 调用整体超时（缺省 120s，上限 10 分钟） */
  timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
```

graph-executor.ts——`embedTexts`（2989 行）签名与 fetch：

```ts
export async function embedTexts(
  modelId: number,
  texts: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
```

```ts
      response = await fetch(`${base}/embeddings`, {
        method: "POST",
        headers: { /* 既有 headers */ },
        body: JSON.stringify({ model: runtime.sdkId, input: batch }),
        signal,
      });
```

两个 handler（`makeVectorizeNodeHandler` 3079 行 `embedTexts(node.modelId, chunks)` 与 `makeVectorSearchNodeHandler` 3122 行）改为：

```ts
      const embedSignal = AbortSignal.any([
        ctx.abort,
        AbortSignal.timeout(node.timeoutMs ?? 120_000),
      ]);
      const vectors = await embedTexts(node.modelId, chunks, embedSignal);
```

（vectorSearch 同款替换其 `embedTexts(node.modelId, [query])` 调用。）

graph-editor-model.ts 新增纯函数（文件函数区）：

```ts
/** 超时秒输入 → timeoutMs（空/非法回退默认值；四处节点字段区共用） */
export function timeoutSecToMs(raw: string, fallbackMs: number): number {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return fallbackMs;
  }
  const sec = Number(trimmed);
  return Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : fallbackMs;
}
```

GraphNodeEditor.tsx：
- import `timeoutSecToMs`
- HttpNodeFields 内 `patchTimeoutSec`（1131 行）删除，两处 `onChange={(e) => patchTimeoutSec(e.target.value)}` 改 `onChange={(e) => onPatch({ timeoutMs: timeoutSecToMs(e.target.value, 120_000) })}`
- `VectorizeNodeFields` / `VectorSearchNodeFields` 的 `modelId` Field 之后各加：

```tsx
      <Field
        label={t("chat:orchestration.editor.timeoutSec")}
        hint={t("chat:orchestration.editor.vectorTimeoutHint")}
      >
        <Input
          className="h-8"
          type="number"
          min={1}
          max={600}
          step={1}
          value={Math.round((node.timeoutMs ?? 120_000) / 1000)}
          onChange={(e) =>
            onPatch({ timeoutMs: timeoutSecToMs(e.target.value, 120_000) })
          }
        />
      </Field>
```

i18n：zh-CN `"vectorTimeoutHint": "embedding 调用超时（秒），超时节点失败"`；en-US `"vectorTimeoutHint": "Embedding call timeout in seconds"`。

- [ ] **Step 4: 跑测试确认通过（含受影响回归）**

Run: `npx vitest run tests/ai/graph-schema.test.ts tests/ai/graph-editor-model.test.ts tests/ai/graph-nodes-extra.test.ts tests/ai/graph-editor-view.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/orchestration/api/graph.schema.ts electron/domains/ai/orchestration/graph-executor.ts src-react/domains/ai/orchestration/lib/graph-editor-model.ts src-react/domains/ai/orchestration/components/GraphNodeEditor.tsx src-react/i18n/locales/zh-CN/chat.json src-react/i18n/locales/en-US/chat.json tests/ai/graph-schema.test.ts tests/ai/graph-editor-model.test.ts tests/ai/graph-nodes-extra.test.ts
git commit -m "feat(workflow): 向量节点 timeoutMs 超时通道与公共秒转换函数"
```

---

### Task 6: start 节点 schema 与校验

**Files:**
- Modify: `src-react/domains/ai/orchestration/api/graph.schema.ts`（`startNodeSchema` + union + `validateGraph` 规则）
- Test: `tests/ai/graph-schema.test.ts`

**Interfaces:**
- Produces:
  - `export const startNodeSchema = z.object({ ...nodeBase, kind: z.literal("start"), variables: z.array(z.string().min(1)).default([]) })`
  - `export type StartNode = z.infer<typeof startNodeSchema>`
  - 校验错误码：`duplicateStartNode`（全图 >1 个 start）、`startIncomingEdge`（start 有入边）；i18n `chat:orchestration.validation.duplicateStartNode` / `startIncomingEdge`

- [ ] **Step 1: 写失败测试（graph-schema.test.ts）**

```ts
describe("start 节点", () => {
  const startNode = { id: "start", name: "开始", kind: "start", variables: ["topic"] };

  it("合法：variables 默认 []，inputSchema 同步由编辑器维护", () => {
    const g = parseGraphJson(JSON.stringify({
      version: 1, inputSchema: { topic: "string" },
      nodes: [startNode, llmNodeOf("node-1", "start")],
      edges: [{ source: "start", target: "node-1" }],
    }));
    expect(g.ok).toBe(true);
  });

  it("缺 variables 补默认 []", () => {
    const g = parseGraphJson(JSON.stringify({
      version: 1, inputSchema: {},
      nodes: [{ id: "start", name: "开始", kind: "start" }, llmNodeOf("node-1", "start")],
      edges: [{ source: "start", target: "node-1" }],
    }));
    expect(g.ok && g.value.nodes[0].variables).toEqual([]);
  });

  it("两个 start → duplicateStartNode；start 有入边 → startIncomingEdge", () => {
    const dup = validateGraph(JSON.stringify({
      version: 1, inputSchema: {},
      nodes: [startNode, { ...startNode, id: "start-2" }, llmNodeOf("node-1", "start")],
      edges: [{ source: "start", target: "node-1" }],
    }));
    expect(dup.ok).toBe(false);
    expect(dup.issues.some((i) => i.code === "duplicateStartNode")).toBe(true);

    const incoming = validateGraph(JSON.stringify({
      version: 1, inputSchema: {},
      nodes: [startNode, llmNodeOf("node-1", "start"), llmNodeOf("node-2", "node-1")],
      edges: [
        { source: "start", target: "node-1" },
        { source: "node-1", target: "start" },
      ],
    }));
    expect(incoming.ok).toBe(false);
    expect(incoming.issues.some((i) => i.code === "startIncomingEdge")).toBe(true);
  });
});
```

（`llmNodeOf(id, source)` 为本文件已有的 llm 节点构造 helper 名——按现有测试的节点工厂函数名对齐；没有则内联完整 llm 节点对象。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/graph-schema.test.ts -t start`
Expected: FAIL——kind "start" 不被 union 接受

- [ ] **Step 3: 实现（graph.schema.ts）**

`codeNodeSchema` 之前加：

```ts
/** 开始节点（kind:start）：图输入变量定义载体（编辑回写
 *  graph.inputSchema，单一事实源不变）；执行直通、无输出 */
export const startNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("start"),
  variables: z.array(z.string().min(1)).default([]),
});
export type StartNode = z.infer<typeof startNodeSchema>;
```

`graphNodeSchema` union 首位插 `startNodeSchema,`；union 推导类型处若按 kind 收窄的 type guard 需补（搜 `isLlmNode` 等 guard，若存在 `isStartNode` 需要则加：`export const isStartNode = (n: GraphNode): n is StartNode => n.kind === "start";`）。

`validateGraph`（结构校验函数体内，参照现有规则追加）：

```ts
  const startNodes = value.nodes.filter((n) => n.kind === "start");
  if (startNodes.length > 1) {
    issues.push({ code: "duplicateStartNode" });
  }
  if (value.edges.some((e) => startNodes.some((s) => s.id === e.target))) {
    issues.push({ code: "startIncomingEdge" });
  }
```

（塞进 `validateGraph` 现有 issues 收集流程；GraphIssue 结构以现有 push 形态对齐，可带 params.nodeId 定位首个违规。）

i18n（zh-CN / en-US 同步，`orchestration.validation` 段）：

```json
"duplicateStartNode": "开始节点至多一个",
"startIncomingEdge": "开始节点不允许有入边"
```

en-US：`"At most one start node"` / `"Start node cannot have incoming edges"`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ai/graph-schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/orchestration/api/graph.schema.ts src-react/i18n/locales/zh-CN/chat.json src-react/i18n/locales/en-US/chat.json tests/ai/graph-schema.test.ts
git commit -m "feat(workflow): start 节点 schema 与唯一性/入边校验"
```

---

### Task 7: start 节点执行直通 + 编辑器模型接入

**Files:**
- Modify: `electron/domains/ai/orchestration/graph-executor.ts`（`makeNodeHandler` 加 start 分支）
- Modify: `src-react/domains/ai/orchestration/lib/graph-editor-model.ts`（`NodeKind`、`FACTORY`、`emptyGraph`、`newNode` 默认 kind 语义）
- Test: `tests/ai/graph-executor.test.ts`；`tests/ai/graph-editor-model.test.ts`

**Interfaces:**
- Consumes: `StartNode`（Task 6）
- Produces:
  - `FACTORY.start = (id: string) => ({ id, name: "开始", kind: "start", variables: [] })`（name 用 i18n 无关的中文名常量，画布展示由 name 承载）
  - `emptyGraph(): GraphJson` 返回 `nodes: [FACTORY.start("start"), FACTORY.llm("node-1")]`、`edges: [{ source: "start", target: "node-1" }]`
  - `NodeKind` 联合含 `"start"`

- [ ] **Step 1: 写失败测试**

graph-executor.test.ts：

```ts
it("start 节点执行直通：不写 output、不产生失败", async () => {
  const graphJson = JSON.stringify({
    version: 1,
    inputSchema: { topic: "string" },
    nodes: [
      { id: "start", name: "开始", kind: "start", variables: ["topic"] },
      llmNodeOf("node-1", "start"),
    ],
    edges: [{ source: "start", target: "node-1" }],
  });
  const result = await runGraphToResult(baseParams(graphJson), baseDeps());
  expect(result.status).toBe("success");
  expect(result.nodeOutputs["start"]).toBeUndefined();
  expect(result.nodeOutputs["node-1"]).toBeDefined();
});
```

graph-editor-model.test.ts：

```ts
it("emptyGraph 默认带 start 节点并连线到首个 llm", () => {
  const g = emptyGraph();
  expect(g.nodes[0].kind).toBe("start");
  expect(g.nodes[0].id).toBe("start");
  expect(g.edges).toEqual([{ source: "start", target: "node-1" }]);
});

it("FACTORY.start 生成空变量开始节点", () => {
  expect(FACTORY.start("s1")).toEqual({ id: "s1", name: "开始", kind: "start", variables: [] });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/graph-executor.test.ts tests/ai/graph-editor-model.test.ts -t "start|emptyGraph"`
Expected: FAIL

- [ ] **Step 3: 实现**

graph-executor.ts `makeNodeHandler` 首分支前加：

```ts
  if (node.kind === "start") {
    // start 无执行语义：直通（不写 state.nodes，引用其 output 的
    // 模板会抛未定义——正确引导从 input 取值）
    return async () => ({ nodes: {} });
  }
```

graph-editor-model.ts：
- `NodeKind` 联合（120 行）加 `"start"`
- `FACTORY`（241 行 Record）加 `start: (id) => ({ id, name: "开始", kind: "start", variables: [] })`
- `emptyGraph`（283 行）改为：

```ts
export function emptyGraph(): GraphJson {
  return {
    version: 1,
    inputSchema: {},
    nodes: [FACTORY.start("start"), newNode("node-1")],
    edges: [{ source: "start", target: "node-1" }],
  };
}
```

- 全文件 TS 编译会指出 `Record<NodeKind, ...>` 缺 start 的位置（AddNodeMenu 的 `KIND_NAME_KEY`、NodeCard 的 `KindIcon`/`KindSummary` 等 Record）——本任务只补 graph-editor-model 内与编译必须项（KindIcon 加 `Play` 图标映射、KIND_NAME_KEY 加 `start: "chat:orchestration.editor.kindStart"`），其余 UI 交互留 Task 8。

i18n：`orchestration.editor.kindStart` zh `"开始"` / en `"Start"`；`nodeDesc.start` zh `"定义图输入变量（原画布参数）"` / en `"Define graph input variables"`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ai/graph-executor.test.ts tests/ai/graph-editor-model.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/orchestration/graph-executor.ts src-react/domains/ai/orchestration/lib/graph-editor-model.ts src-react/i18n/locales/zh-CN/chat.json src-react/i18n/locales/en-US/chat.json tests/ai/graph-executor.test.ts tests/ai/graph-editor-model.test.ts
git commit -m "feat(workflow): start 节点执行直通与空图默认骨架"
```

---

### Task 8: start 编辑 UI（字段区/回写 inputSchema/菜单禁用/图级变量区移除）

**Files:**
- Modify: `src-react/domains/ai/orchestration/lib/graph-editor-model.ts`（新增 `patchStartVariables`）
- Modify: `src-react/domains/ai/orchestration/views/GraphEditorView.tsx`（`patchNode` 分流 start 变量）
- Modify: `src-react/domains/ai/orchestration/components/GraphNodeEditor.tsx`（`nodeFieldsOf` 加 start 分支 + `StartNodeFields`）
- Modify: `src-react/domains/ai/orchestration/components/NodePropertiesPanel.tsx`（GraphBranch 变量区移除）
- Modify: `src-react/domains/ai/orchestration/components/AddNodeMenu.tsx`（start 菜单项 + 已存在禁用）
- Modify: `src-react/domains/ai/orchestration/components/nodes/NodeCard.tsx`（start 专用描边样式；`KindIcon` 若未在 Task 7 补 Play 映射则此处补）
- Test: `tests/ai/graph-editor-model.test.ts`；`tests/ai/graph-editor-view.test.tsx`

**Interfaces:**
- Consumes: `StartNode`、`StringListInput`
- Produces: `export function patchStartVariables(graph: GraphJson, variables: string[]): GraphJson`

- [ ] **Step 1: 写失败测试**

graph-editor-model.test.ts：

```ts
describe("patchStartVariables", () => {
  it("节点 variables 与 inputSchema 同步写（单一提交）", () => {
    const g = emptyGraph();
    const next = patchStartVariables(g, ["topic", "lang"]);
    expect(next.nodes[0].variables).toEqual(["topic", "lang"]);
    expect(next.inputSchema).toEqual({ topic: "string", lang: "string" });
  });

  it("清空变量 → inputSchema 置空", () => {
    const g = patchStartVariables(emptyGraph(), ["a"]);
    const next = patchStartVariables(g, []);
    expect(next.inputSchema).toEqual({});
  });
});
```

graph-editor-view.test.tsx（新增用例，沿用该文件既有 render/交互模式）：

```tsx
it("start 节点编辑变量 → 图 inputSchema 同步（试运行变量来源）", async () => {
  // 渲染编辑器（该文件既有 helper），选中 start 节点，
  // 在变量输入框输入 "topic,lang" 提交（StringListInput 逗号提交），
  // 断言内部草稿 graph.inputSchema 键为 [topic, lang]——经保存按钮
  // 落库后的 graphJson 断言（mock GraphApi.update 捕获参数解析）
});
```

（该用例主体按 `graph-editor-view.test.tsx` 现有「编辑节点字段 → 保存」用例的模式展开：mock `GraphApi.update`，选中节点经 `data-node-row` 点击，StringListInput 输入框 change + blur/回车提交，最后 `JSON.parse(update.mock.calls[0][0]?.graphJson ?? ...)` 断言 `inputSchema`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/graph-editor-model.test.ts tests/ai/graph-editor-view.test.tsx`
Expected: FAIL——`patchStartVariables` 未导出 / StartNodeFields 缺失

- [ ] **Step 3: 实现**

graph-editor-model.ts：

```ts
/** start 节点变量编辑：节点与 inputSchema 同一次提交同步写
 *  （inputSchema 仍为执行/试运行/AI 协议的读取单一事实源） */
export function patchStartVariables(
  graph: GraphJson,
  variables: string[],
): GraphJson {
  return {
    ...graph,
    inputSchema: Object.fromEntries(variables.map((key) => [key, "string"])),
    nodes: graph.nodes.map((node) =>
      node.kind === "start" ? { ...node, variables } : node,
    ),
  };
}
```

GraphEditorView.tsx `patchNode`（找到现有节点 patch 函数，start 分流）：

```ts
  function patchNode(next: GraphNode) {
    if (next.kind === "start") {
      commitGraph((current) => patchStartVariables(current, next.variables));
      return;
    }
    commitGraph((current) => patchNodeOf(current, next)); // 原有更新调用
  }
```

（`patchNodeOf` 即原 patchNode 内部的 editor-model 更新函数名，保持原名。）

GraphNodeEditor.tsx：
- `nodeFieldsOf` 分发加 `if (node.kind === "start") return <StartNodeFields node={node} onPatch={onPatch} />;`
- 新组件（放 VectorizeNodeFields 之前）：

```tsx
/** 开始节点字段区：变量列表（回写 inputSchema 由编辑器层收口）；
 *  字段初始值从 inputSchema 读（JSON 手改/AI 生成的图保持一致） */
export function StartNodeFields({
  node,
  inputSchemaKeys,
  onPatch,
}: {
  node: StartNode;
  inputSchemaKeys: string[];
  onPatch: (patch: GraphNodePatch) => void;
}) {
  const { t } = useTranslation(["chat"]);
  const values = node.variables.length > 0 ? node.variables : inputSchemaKeys;
  return (
    <>
      <Field
        label={t("chat:orchestration.editor.variablesLabel")}
        hint={t("chat:orchestration.editor.variablesHint")}
        className="col-span-full"
      >
        <StringListInput
          values={values}
          placeholder={t("chat:orchestration.editor.variablePlaceholder")}
          onChange={(variables) => onPatch({ variables } as GraphNodePatch)}
        />
      </Field>
    </>
  );
}
```

（`GraphNodePatch` 若是 `Partial<GraphNode>` 联合，`{ variables }` 直接合法；`inputSchemaKeys` 由 GraphEditorView 从 `Object.keys(graph.inputSchema)` 传入 `nodeFieldsOf`——查 `nodeFieldsOf` 现有参数并扩一个可选参 `inputSchemaKeys: string[] = []`。）

NodePropertiesPanel.tsx `GraphBranch`：删除变量 Label/hint/`StringListInput` 块（173-184 行），保留名称/描述；若 `onGraphMeta` 的 `variables` 分支仅剩 GraphEditorView 一侧使用，同步删掉 `patchGraphMeta` 的 variables 分支与 props 类型（`onGraphMeta` 保留 name/description）。

AddNodeMenu.tsx：
- `GROUPS` 首组前加一组 `{ key: "flow", kinds: [{ kind: "start", icon: Play }] }`（`Play` 进 lucide import）
- 菜单项渲染处（搜索结果/分组网格 map）：对 start 加禁用条件——组件需要知道图里是否已有 start：AddNodeMenu props 加 `hasStart: boolean`（GraphEditorView 传 `graph.nodes.some((n) => n.kind === "start")`），start 项 `disabled={hasStart}` 且样式 `disabled:opacity-40 disabled:cursor-not-allowed`
- `KIND_NAME_KEY`/`descKey` 已在 Task 7 补过 key

NodeCard.tsx（卡片容器 className，29-33 行三元链扩一支）：

```tsx
      className={`relative w-[220px] rounded-lg border bg-card p-2 shadow-sm ${
        selected
          ? "border-primary ring-1 ring-primary/40"
          : node.kind === "start"
            ? "border-emerald-300 dark:border-emerald-800"
            : "border-border"
      }`}
```

（start 入口视觉：emerald 描边；`KindIcon` 的 Play 映射若 Task 7 未覆盖则在此补。）

- [ ] **Step 4: 跑测试确认通过（含画布回归）**

Run: `npx vitest run tests/ai/graph-editor-model.test.ts tests/ai/graph-editor-view.test.tsx tests/ai/graph-canvas.test.tsx tests/ai/graph-canvas-model.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/orchestration/lib/graph-editor-model.ts src-react/domains/ai/orchestration/views/GraphEditorView.tsx src-react/domains/ai/orchestration/components/GraphNodeEditor.tsx src-react/domains/ai/orchestration/components/NodePropertiesPanel.tsx src-react/domains/ai/orchestration/components/AddNodeMenu.tsx tests/ai/graph-editor-model.test.ts tests/ai/graph-editor-view.test.tsx
git commit -m "feat(workflow): start 节点编辑 UI 与 inputSchema 同步回写"
```

---

### Task 9: 模板与 workflow-creator 技能更新 + 全量验证

**Files:**
- Modify: `electron/domains/ai/orchestration/graph-templates.ts`（每模板图加 start 节点）
- Modify: `electron/resources/builtin-skills/workflow-creator/SKILL.md`（节点规范加 start）
- Test: `tests/ai/graph-templates.test.ts`（快照/结构断言更新）

**Interfaces:**
- Consumes: `FACTORY.start` 形状（Task 7）；模板 `GraphTemplate` 结构

- [ ] **Step 1: 写失败测试（graph-templates.test.ts）**

```ts
it("全部模板首节点为 start 且 variables 与 inputSchema 键一致", () => {
  for (const template of listGraphTemplates()) {
    const graph = JSON.parse(template.graphJson) as {
      inputSchema: Record<string, string>;
      nodes: Array<{ id: string; kind: string; variables?: string[] }>;
    };
    const starts = graph.nodes.filter((n) => n.kind === "start");
    expect(starts.length, template.name).toBe(1);
    expect(Object.keys(graph.inputSchema).sort(), template.name).toEqual(
      [...(starts[0].variables ?? [])].sort(),
    );
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/graph-templates.test.ts`
Expected: FAIL——模板无 start 节点

- [ ] **Step 3: 实现模板改造**

`graph-templates.ts` 每个模板的 `graphJson` 对象：`nodes` 数组头部插

```ts
{ id: "start", name: "开始", kind: "start", variables: [/* 与该模板 inputSchema 的键同名列表 */] },
```

并把原入口节点（若有 `edges` 指向它）加边 `{ source: "start", target: "<原入口节点 id>" }`；`variables` 与该模板 `inputSchema` 的键逐一对应（保持原 inputSchema 键不变——执行语义零变化）。逐模板核对 inputSchema 键后填入。

SKILL.md（`electron/resources/builtin-skills/workflow-creator/SKILL.md`）节点规范区加一节：

```markdown
## 开始节点（kind: "start"）

- 每张图有且仅有一个 start 节点（id 惯例 "start"），不允许入边。
- `variables` 定义图的输入变量（字符串数组）；生成 graphJson 时
  `inputSchema` 必须与 variables 保持一致（`{ "<变量名>": "string" }`）。
- start 节点不执行任何操作，其余节点经 `{{input.<变量名>}}` 引用输入。
```

（插入位置参照该文件现有节点小节的编排；同时在「graphJson 结构」示例里补 start 节点样例。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ai/graph-templates.test.ts tests/ai/builtin-skills.test.ts`
Expected: PASS

- [ ] **Step 5: 全量验证**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: 全绿（lint 仅允许既有 `.claude/worktrees/` 下报错）

- [ ] **Step 6: Commit**

```bash
git add electron/domains/ai/orchestration/graph-templates.ts electron/resources/builtin-skills/workflow-creator/SKILL.md tests/ai/graph-templates.test.ts
git commit -m "feat(workflow): 模板与 workflow-creator 技能纳入 start 节点规范"
```
