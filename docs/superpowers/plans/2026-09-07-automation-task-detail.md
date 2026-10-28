# 自动化任务编辑/详情模块 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增自动化任务详情/编辑页(左右分栏:配置区 + 该任务运行历史),支持测试运行、任务级权限(accessMode)、频率弹窗编辑。

**Architecture:** 数据层加 `accessMode` 列与 `automation:runNow` IPC;runner 权限回调按 accessMode 分流;表单逻辑从 CreateTaskDialog 抽成纯函数 + `useTaskForm` 薄壳,详情页与弹窗共享;TaskRow 点击改路由跳转,弹窗删除编辑模式。

**Tech Stack:** Electron IPC / Prisma(SQLite) / React 19 + React Router 7 / React Query / zustand / vitest(内存断言)

**Spec:** `docs/superpowers/specs/2026-09-07-automation-task-detail-design.md`

## Global Constraints

- **本地库必须重建**:Task 1 给 `automationTask` 加列后,本地旧 `database/local.db`(db_version=10 > DATABASE_VERSION=1,不再跑迁移)缺列会使 Prisma 查询崩溃。开发自测前删除 `database/local.db` 重新注册账号。
- UI 样式:主题变量(禁硬编码色)、浮层 `border border-border/50 rounded-lg shadow-lg`、触发器 hover `hover:bg-primary-subtle hover:text-primary hover:border-primary/30`。
- 文案一律 i18n `t()`,zh-CN 与 en-US 同步加 key,禁止硬编码;key 前缀 `chat:automation.detail.*`。
- 代码风格:Prettier 双引号/分号/80 列;文件名 kebab-case;函数 ≤20 行优先。
- 测试:`npm run test`(vitest);每个 Task 后跑 `npm run lint && npm run typecheck`。
- 命令在仓库根目录 `/Users/hjx/workspace/mirror` 执行。

---

### Task 1: 数据层——accessMode 列与 runs 状态过滤

**Files:**
- Modify: `electron/infrastructure/script/v1/upgrade-table.sql`(automationTask 表)
- Modify: `prisma/schema.prisma`(automationTask model)
- Modify: `src-react/domains/ai/automation/api/automation.api.ts`
- Modify: `electron/domains/ai/automation/automation.repo.ts`
- Test: `tests/ai/automation-repo.test.ts`

**Interfaces:**
- Consumes: 现有 `buildTaskData`/`toTaskRecord` 导出、`AutomationApi.runs(page, taskId?)`
- Produces: `AccessMode` 类型(`"default" | "full"`,automation.api.ts 导出);`TaskRecord.accessMode: AccessMode`;`TaskCreateParams.accessMode?: AccessMode`;`AutomationApi.runs(page, taskId?, status?)`;repo `listRuns(page, taskId?, status?)`

- [ ] **Step 1: 写失败测试**(追加到 `tests/ai/automation-repo.test.ts`,文件已有 mock 三件套与 `row` fixture)

```ts
describe("accessMode 落库与派生", () => {
  it("buildTaskData 未传 accessMode 时默认 default", () => {
    const data = buildTaskData(baseParams, new Date("2026-09-07T00:00:00"));
    expect(data.accessMode).toBe("default");
  });

  it("buildTaskData 透传 full", () => {
    const data = buildTaskData(
      { ...baseParams, accessMode: "full" },
      new Date("2026-09-07T00:00:00"),
    );
    expect(data.accessMode).toBe("full");
  });

  it("toTaskRecord 归一非法值为 default", () => {
    const rec = toTaskRecord({ ...row, accessMode: "full" }, null);
    expect(rec.accessMode).toBe("full");
  });
});
```

`baseParams` 若文件尚无,在该 describe 上方定义(与现有用例的创建参数 fixture 对齐,至少含 name/prompt/workspaceId/modelId/schedule/scheduleText/missedPolicy)。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/automation-repo.test.ts`
Expected: FAIL,`accessMode` 属性不存在(TS 报错或断言失败)。

- [ ] **Step 3: 实现**

1. `v1/upgrade-table.sql` automationTask 表 `missedPolicy` 行后加:
```sql
    accessMode TEXT NOT NULL DEFAULT 'default',
```
2. `prisma/schema.prisma` automationTask model `missedPolicy` 字段后加:
```prisma
  accessMode      String        @default("default")
```
3. `automation.api.ts`:`AutomationStatus` 定义附近加 `export type AccessMode = "default" | "full";`;`TaskRecord` 加 `accessMode: AccessMode;`(missedPolicy 行后);`TaskCreateParams` 加 `accessMode?: AccessMode;`。
4. `automation.repo.ts`:
   - `buildTaskData` 返回对象加 `accessMode: params.accessMode ?? "default",`
   - `toTaskRecord` 返回对象加 `accessMode: row.accessMode === "full" ? "full" : "default",`
   - `listRuns` 改签名与 where:
```ts
async listRuns(
  page: number,
  taskId?: number,
  status?: RunRecord["status"],
): Promise<RunPage> {
  const where = {
    ...(taskId ? { taskId } : {}),
    ...(status ? { status } : {}),
  };
```
   - IPC handler 改:`ipcMain.handle("automation:runs:page", (_, page: number, taskId?: number, status?: RunRecord["status"]) => this.listRuns(page, taskId, status))`
   - 文件顶部 import 类型加 `RunRecord` 已有,无需新 import。
5. `automation.api.ts` 的 `runs` 方法:
```ts
static async runs(
  page: number,
  taskId?: number,
  status?: RunStatus,
): Promise<RunPage> {
  return invoke<RunPage>("automation:runs:page", page, taskId, status);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ai/automation-repo.test.ts` → PASS;`npm run typecheck && npm run lint` → 无错。

- [ ] **Step 5: Commit**

```bash
git add electron/infrastructure/script/v1/upgrade-table.sql prisma/schema.prisma src-react/domains/ai/automation/api/automation.api.ts electron/domains/ai/automation/automation.repo.ts tests/ai/automation-repo.test.ts
git commit -m "feat(automation): accessMode 字段落库与 runs 状态过滤"
```

---

### Task 2: runner 权限分流 + runNow IPC

**Files:**
- Modify: `electron/domains/ai/automation/automation-runner.ts`
- Modify: `electron/domains/ai/automation/automation.repo.ts`
- Modify: `src-react/domains/ai/automation/api/automation.api.ts`
- Test: `tests/ai/automation-permissions.test.ts`(新建)

**Interfaces:**
- Consumes: Task 1 的 `AccessMode`;现有 `executeTask(task, opts)`、`AutomationTaskRow`
- Produces: `resolveAutomationPermissions(accessMode)`(runner 导出);`TriggerType` 含 `"manual"`;`AutomationApi.runNow(id): Promise<void>`

- [ ] **Step 1: 写失败测试**(新文件,mock 头复制自 `tests/ai/automation-repo.test.ts` 的三段 `vi.mock`)

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../electron/commons/prisma-client", () => ({ default: {} }));

import { resolveAutomationPermissions } from "../../electron/domains/ai/automation/automation-runner";

describe("resolveAutomationPermissions", () => {
  it("default:完全访问与写审批均拒绝(只读执行)", async () => {
    const p = resolveAutomationPermissions("default");
    expect(p.fullAccess()).toBe(false);
    expect(await p.requestApproval()).toBe(false);
  });

  it("full:无人值守全放行(与现状一致)", async () => {
    const p = resolveAutomationPermissions("full");
    expect(p.fullAccess()).toBe(true);
    expect(await p.requestApproval()).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/automation-permissions.test.ts`
Expected: FAIL,`resolveAutomationPermissions` 未导出。

- [ ] **Step 3: 实现**

1. `automation-runner.ts`:
   - `ExecuteTaskOptions.triggerType` 类型改 `("schedule" | "catchUp" | "retry" | "manual")[]` 的单值:`triggerType: "schedule" | "catchUp" | "retry" | "manual"`
   - 新导出(放在 `ExecuteTaskOptions` 前):
```ts
export interface AutomationPermissions {
  fullAccess: () => boolean;
  isToolAllowed: (toolName: string) => Promise<boolean>;
  requestApproval: () => Promise<boolean>;
}

/** 无人值守权限分流:full=完全访问+审批放行(原行为);default=只读执行,
 * 写类审批被拒但任务继续(agent 收到拒绝反馈),与会话 default 语义对齐 */
export function resolveAutomationPermissions(
  accessMode: "default" | "full",
): AutomationPermissions {
  const full = accessMode === "full";
  return {
    fullAccess: () => full,
    isToolAllowed: async () => true,
    requestApproval: async () => full,
  };
}
```
   - `streamAndRecord` 内 agent 配置(现 205-212 行)改:
```ts
    agent: {
      sessionId: ctx.sessionId,
      workspacePath: ctx.workspacePath,
      // 权限按任务持久化 accessMode 分流(spec §2.3),不再无条件放行
      ...resolveAutomationPermissions(
        task.accessMode === "full" ? "full" : "default",
      ),
    },
```
2. `automation.api.ts`:`TriggerType` 改 `export type TriggerType = "schedule" | "catchUp" | "retry" | "manual";`,类内加:
```ts
/** 手动触发一次执行(返回即触发完成,结果经 tasks-changed 事件刷新) */
static async runNow(id: number): Promise<void> {
  return invoke<void>("automation:runNow", id);
}
```
3. `automation.repo.ts`:
   - 顶部 import 加 `import { executeTask } from "./automation-runner";`
   - registerHandlers 内 `automation:toggle` 之后加:
```ts
ipcMain.handle("automation:runNow", async (_, id: number): Promise<void> => {
  const task = await prisma.automationTask.findUnique({ where: { id } });
  if (!task) {
    throw new Error(`automation task ${id} not found`);
  }
  // 不 await:单次执行可达分钟级,触发即返回;落库/推送走 executeTask 既有链路
  void executeTask(task, {
    triggerType: "manual",
    attempt: 1,
    abort: new AbortController().signal,
  });
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ai/automation-permissions.test.ts tests/ai/automation-runner.test.ts` → 全 PASS(既有 runner 测试不回归);`npm run typecheck` → 无错。

- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/automation/automation-runner.ts electron/domains/ai/automation/automation.repo.ts src-react/domains/ai/automation/api/automation.api.ts tests/ai/automation-permissions.test.ts
git commit -m "feat(automation): runNow 手动执行与 accessMode 权限分流"
```

---

### Task 3: 表单纯函数库 + useTaskForm 抽取(弹窗行为不变)

**Files:**
- Create: `src-react/domains/ai/automation/lib/task-form.ts`
- Create: `src-react/domains/ai/automation/lib/use-task-form.ts`
- Modify: `src-react/domains/ai/automation/components/CreateTaskDialog.tsx`
- Test: `tests/ai/task-form.test.ts`(新建)

**Interfaces:**
- Consumes: `TaskRecord`/`TemplateRecord`/`TaskCreateParams`/`ScheduleConfig`;`describeSchedule`/`describeValidity`/`validateSchedule`(schedule-text.ts)
- Produces:
  - `buildInitialValues(source, t): TaskFormValues`
  - `serializeForm(v: TaskFormValues): string`
  - `buildTaskParams(v: TaskFormValues, t): TaskCreateParams`
  - `canSubmitForm(v: TaskFormValues, now: Date): boolean`
  - `useTaskForm({ task?, template? }): UseTaskFormResult`(字段:setter 群 + `isDirty` + `canSubmit` + `buildParams()` + `resetSnapshot()` + `pickerKey`)

```ts
export interface TaskFormValues {
  name: string;
  prompt: string;
  modelId: number | null;
  temperature: number;
  workspaceId: number | null;
  missedPolicy: "skip" | "catchUpOnce";
  schedule: ScheduleConfig | null;
  validity: { startAt?: string; endAt?: string };
  accessMode: AccessMode;
  templateSlug?: string;
}
```

- [ ] **Step 1: 写失败测试**(新文件 `tests/ai/task-form.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import {
  buildInitialValues,
  serializeForm,
  buildTaskParams,
} from "../../src-react/domains/ai/automation/lib/task-form";
import type { TaskRecord } from "../../src-react/domains/ai/automation/api/automation.api";

const t = (key: string) => key; // 文案占位,仅验证透传给 describeSchedule
const task = {
  id: 1, name: "早报", prompt: "总结", workspaceId: 2, workspaceName: "w",
  source: "local", modelId: 3, temperature: 0.5,
  scheduleJson: JSON.stringify({ mode: "periodic", kind: "daily", time: "09:00" }),
  scheduleText: "每天 09:00", missedPolicy: "skip", enabled: true,
  status: "active", accessMode: "full",
  createdAt: "2026-09-07T00:00:00Z", updatedAt: "2026-09-07T00:00:00Z",
} as TaskRecord;

describe("task-form 纯函数", () => {
  it("buildInitialValues 按 task 回填并本地化日期", () => {
    const v = buildInitialValues(
      { task: { ...task, startAt: "2026-09-10T00:00:00Z" } },
      t,
    );
    expect(v.name).toBe("早报");
    expect(v.accessMode).toBe("full");
    expect(v.validity.startAt).toBe("2026-09-10"); // 本地时区格式化,不 slice(0,10)
  });

  it("serializeForm 相同值同串、改值变串(脏检测依据)", () => {
    const v = buildInitialValues({ task }, t);
    expect(serializeForm(v)).toBe(serializeForm({ ...v }));
    expect(serializeForm(v)).not.toBe(serializeForm({ ...v, name: "x" }));
  });

  it("buildTaskParams 组装含 accessMode 与本地零点日期", () => {
    const v = buildInitialValues({ task }, t);
    v.validity = { startAt: "2026-09-10", endAt: "2026-09-20" };
    const p = buildTaskParams(v, t);
    expect(p.accessMode).toBe("full");
    expect(p.startAt).toBe(
      new Date("2026-09-10T00:00:00").toISOString(),
    );
    expect(p.endAt).toBe(
      new Date("2026-09-20T23:59:59").toISOString(),
    );
  });

  it("buildInitialValues 无源给默认 schedule", () => {
    const v = buildInitialValues({}, t);
    expect(v.schedule).toEqual({
      mode: "periodic", kind: "daily", time: "09:00",
    });
    expect(v.accessMode).toBe("default");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ai/task-form.test.ts` → FAIL,模块不存在。

- [ ] **Step 3: 实现 `lib/task-form.ts`**

```ts
/** 任务表单纯函数(弹窗/详情页共享):初值/脏检测/参数组装/可提交判定 */
import { format } from "date-fns";
import type { AccessMode, TaskCreateParams, TaskRecord, TemplateRecord } from "../api/automation.api";
import type { ScheduleConfig } from "../api/schedule.schema";
import { scheduleSchema } from "../api/schedule.schema";
import { describeSchedule, describeValidity } from "./schedule-text";

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

export interface TaskFormValues { /* 上方 Interfaces 块所列 10 字段 */ }

const DEFAULT_SCHEDULE: ScheduleConfig = { mode: "periodic", kind: "daily", time: "09:00" };

export function buildInitialValues(
  source: { task?: TaskRecord; template?: TemplateRecord },
  t: TFunc,
): TaskFormValues {
  if (source.task) {
    const e = source.task;
    return {
      name: e.name, prompt: e.prompt, modelId: e.modelId,
      temperature: e.temperature ?? 0.7, workspaceId: e.workspaceId,
      missedPolicy: e.missedPolicy,
      schedule: JSON.parse(e.scheduleJson) as ScheduleConfig,
      validity: {
        startAt: e.startAt ? format(new Date(e.startAt), "yyyy-MM-dd") : undefined,
        endAt: e.endAt ? format(new Date(e.endAt), "yyyy-MM-dd") : undefined,
      },
      accessMode: e.accessMode, templateSlug: e.templateSlug,
    };
  }
  const base: TaskFormValues = {
    name: "", prompt: "", modelId: null, temperature: 0.7, workspaceId: null,
    missedPolicy: "skip", schedule: DEFAULT_SCHEDULE, validity: {},
    accessMode: "default",
  };
  if (source.template) {
    return {
      ...base,
      name: t(`chat:automation.templateData.${source.template.slug.replace(/-(\w)/g, (_, c) => c.toUpperCase())}.title`),
      prompt: source.template.prompt,
      temperature: source.template.temperature,
      schedule: JSON.parse(source.template.scheduleJson) as ScheduleConfig,
      templateSlug: source.template.slug,
    };
  }
  return base;
}

export function serializeForm(v: TaskFormValues): string {
  return JSON.stringify([
    v.name.trim(), v.prompt, v.modelId, v.temperature, v.workspaceId,
    v.missedPolicy, v.schedule, v.validity, v.accessMode, v.templateSlug,
  ]);
}

export function buildTaskParams(v: TaskFormValues, t: TFunc): TaskCreateParams {
  const schedule = v.schedule as ScheduleConfig;
  return {
    name: v.name.trim(), prompt: v.prompt, workspaceId: v.workspaceId!,
    modelId: v.modelId!, temperature: v.temperature, schedule,
    scheduleText: `${describeSchedule(schedule, t)} · ${describeValidity(v.validity, t)}`,
    // DatePicker 日期串按本地零点解析(new Date("YYYY-MM-DD") 按 UTC 解析会时区错位)
    startAt: v.validity.startAt
      ? new Date(`${v.validity.startAt.slice(0, 10)}T00:00:00`).toISOString()
      : undefined,
    endAt: v.validity.endAt
      ? new Date(`${v.validity.endAt.slice(0, 10)}T23:59:59`).toISOString()
      : undefined,
    missedPolicy: v.missedPolicy, accessMode: v.accessMode,
    templateSlug: v.templateSlug,
  };
}
```

`canSubmitForm(v, now)`:校验 `name/prompt` trim 非空、`modelId/workspaceId` 非空、`scheduleSchema.safeParse` 成功、`validateSchedule(...)` 为 `"ok"`(startAt 未改不校验倒流的逻辑由调用方在 values 组装前处理,保持与现弹窗一致——把 `startAtUnchanged` 作为第 4 参数传入)。签名:`canSubmitForm(v: TaskFormValues, now: Date, startAtUnchanged: boolean): boolean`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ai/task-form.test.ts` → PASS。

- [ ] **Step 5: 实现 `lib/use-task-form.ts` 薄壳并接入弹窗**

```ts
/** useTaskForm:TaskFormValues 的受控状态 + 脏检测快照 + 工作空间默认模型联动 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { buildInitialValues, serializeForm, type TaskFormValues } from "./task-form";
import type { TaskRecord, TemplateRecord, AccessMode } from "../api/automation.api";
import type { ScheduleConfig } from "../api/schedule.schema";
import type { WorkspaceRecord } from "../../api/workspace.api";

export function useTaskForm(source: {
  task?: TaskRecord;
  template?: TemplateRecord;
  /** 源变化信号(弹窗 open 或路由 id):变化时重置表单与脏快照 */
  resetKey: string | number;
  workspaces: WorkspaceRecord[];
}) {
  const { t } = useTranslation(["chat"]);
  const [values, setValues] = useState<TaskFormValues>(() =>
    buildInitialValues({}, t),
  );
  const snapshot = useRef("");
  const reset = (src: typeof source) => {
    const next = buildInitialValues({ task: src.task, template: src.template }, t);
    setValues(next);
    snapshot.current = serializeForm(next);
  };
  useEffect(() => {
    reset(source); // resetKey 变化时由调用方改 source 引用触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.resetKey]);
  // 工作空间默认模型联动(迁移自弹窗 useEffect)
  useEffect(() => {
    if (values.workspaceId) {
      const ws = source.workspaces.find((w) => w.id === values.workspaceId);
      if (ws?.defaultModelId) {
        setValues((prev) =>
          prev.modelId ? prev : { ...prev, modelId: ws.defaultModelId! },
        );
      }
    }
  }, [values.workspaceId, source.workspaces]);

  const isDirty = serializeForm(values) !== snapshot.current;
  return {
    values, setValues, isDirty,
    patch: (p: Partial<TaskFormValues>) => setValues((prev) => ({ ...prev, ...p })),
    resetSnapshot: () => {
      snapshot.current = serializeForm(values);
    },
    t,
  };
}
```

`CreateTaskDialog` 改造:删除原有 useState 群(name/prompt/modelId/temperature/workspaceId/missedPolicy/schedule/validity + pickerKey + initialStartAtRef)、`open` 初始化 useEffect、工作空间联动 useEffect、`canSubmit` 计算与 `handleSubmit` 中的 params 组装,全部换 `useTaskForm`(弹窗内 `source = { task: editTask, template, resetKey: pickerKey, workspaces }`);`accessMode`/`patch` 在弹窗 UI 不暴露(详情页才编辑)。提交逻辑保留 stat/toast/invalidate,仅 params 来自 `buildTaskParams`。**此 Task 不改弹窗对外行为**(编辑分支留给 Task 6 删)。

- [ ] **Step 6: 验证**

Run: `npx vitest run && npm run typecheck && npm run lint` → 全过。

- [ ] **Step 7: Commit**

```bash
git add src-react/domains/ai/automation/lib/task-form.ts src-react/domains/ai/automation/lib/use-task-form.ts src-react/domains/ai/automation/components/CreateTaskDialog.tsx tests/ai/task-form.test.ts
git commit -m "refactor(automation): 表单逻辑抽 task-form 纯函数与 useTaskForm"
```

---

### Task 4: TaskDetailView——路由、顶栏、左侧配置区

**Files:**
- Create: `src-react/domains/ai/automation/views/TaskDetailView.tsx`
- Create: `src-react/domains/ai/automation/components/ScheduleDialog.tsx`
- Modify: `src-react/routes/index.tsx`(automation 路由后加子路由)
- Modify: `src-react/i18n/locales/zh-CN/chat.json`、`en-US/chat.json`(automation 节加 `detail` 子对象)

**Interfaces:**
- Consumes: Task 2 `AutomationApi.runNow`;Task 3 `useTaskForm`/`buildTaskParams`/`canSubmitForm`;`TaskPromptInput`/`PermissionCapsule`/`FullAccessModal`/`SchedulePicker` 现有 props
- Produces: 路由 `/module/ai/automation/task/:id`;`TaskDetailView`(默认导出);`ScheduleDialog`(props: `open/onOpenChange/schedule/validity/onConfirm(schedule, validity)`)

- [ ] **Step 1: i18n key**(两语言文件 automation 节内加 `"detail": {...}`)

zh-CN:
```json
"detail": {
  "back": "返回",
  "play": "测试运行",
  "playing": "已触发,运行中…",
  "save": "保存",
  "cancel": "取消",
  "deleteTitle": "删除任务",
  "deleteDesc": "将删除任务「{{name}}」及其全部运行记录,此操作无法撤销。",
  "discardTitle": "放弃未保存的修改?",
  "discardDesc": "返回将丢弃当前所有修改。",
  "discard": "放弃修改",
  "keepEditing": "继续编辑",
  "notFound": "任务不存在或已删除",
  "saved": "已保存",
  "runTriggered": "已触发执行,请稍候在运行历史查看",
  "name": "任务名称",
  "namePlaceholder": "输入任务名称",
  "prompt": "提示词",
  "workspace": "工作空间",
  "permission": "执行权限",
  "schedule": "执行频率",
  "scheduleEdit": "修改",
  "runNowFailed": "触发失败"
}
```
en-US 对应:`Back`/`Test run`/`Triggered, running…`/`Save`/`Cancel`/`Delete task`/`This will delete "{{name}}" and all its run history. This cannot be undone.`/`Discard unsaved changes?`/`Going back will discard all current changes.`/`Discard`/`Keep editing`/`Task not found or deleted`/`Saved`/`Run triggered, check run history shortly`/`Task name`/`Enter task name`/`Prompt`/`Workspace`/`Execution permission`/`Schedule`/`Edit`/`Failed to trigger`。

- [ ] **Step 2: 路由**(`src-react/routes/index.tsx`)

顶部 lazy 区 `AutomationView` 行后加:
```tsx
const TaskDetailView = lazyRouter(() =>
  import("@/domains/ai/automation/views/TaskDetailView"),
);
```
(`lazyRouter` 为该文件既有 lazy 封装,照抄 AutomationView 的写法;若实际是别的名字以文件现状为准。)
children 中 `automation` 路由对象后加:
```tsx
{
  path: "automation/task/:id",
  element: (
    <LazyWrapper>
      <TaskDetailView />
    </LazyWrapper>
  ),
},
```

- [ ] **Step 3: ScheduleDialog 组件**

```tsx
/** 频率编辑弹窗:内嵌 SchedulePicker(受控实时回写),footer 完成即关闭 */
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SchedulePicker } from "./SchedulePicker";
import type { ScheduleConfig } from "../api/schedule.schema";

interface ScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schedule: ScheduleConfig | null;
  validity: { startAt?: string; endAt?: string };
  onChange: (schedule: ScheduleConfig | null, validity: { startAt?: string; endAt?: string }) => void;
}

export function ScheduleDialog({ open, onOpenChange, schedule, validity, onChange }: ScheduleDialogProps) {
  const { t } = useTranslation(["chat"]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl border border-border/50 rounded-lg shadow-lg">
        <DialogHeader>
          <DialogTitle>{t("chat:automation.detail.schedule")}</DialogTitle>
        </DialogHeader>
        <SchedulePicker value={schedule} onChange={(cfg) => onChange(cfg, validity)} validity={validity} onValidityChange={(v) => onChange(schedule, v)} />
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>{t("common:ok")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: TaskDetailView(左侧配置 + 顶栏;右侧运行历史以占位容器渲染 `<div className="w-[38%] border-l border-border/50" />`,Task 5 填充)**

结构(关键代码,样式遵循全局约束):
```tsx
/** 任务详情/编辑:顶栏(返回/标题/播放/删除/取消/保存) + 左配置右历史分栏 */
export default function TaskDetailView() {
  const { id } = useParams<{ id: string }>();
  const taskId = Number(id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation(["chat", "common"]);
  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ["automation", "tasks"],
    queryFn: () => AutomationApi.list(),
  });
  const { data: workspaces = [] } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => WorkspaceApi.list(),
  });
  const task = tasks.find((x) => x.id === taskId);
  // 未找到:非加载态自动回列表(交给 useEffect,避免渲染期导航)
  const form = useTaskForm({ task, resetKey: task ? `task-${task.id}` : "none", workspaces });
  const [running, setRunning] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const notFoundRef = useRef(false);
  useEffect(() => {
    if (!isLoading && !task && !notFoundRef.current) {
      notFoundRef.current = true;
      toast.error(t("chat:automation.detail.notFound"));
      navigate("/module/ai/automation", { replace: true });
    }
  }, [isLoading, task, navigate, t]);
  if (!task) return null;
  const invalidateTasks = () =>
    queryClient.invalidateQueries({ queryKey: ["automation", "tasks"] });
  // …保存/播放/删除/离开 的 handler 见下
}
```
handlers(完整实现进组件):
- `handleSave`:校验 `canSubmitForm(form.values, new Date(), startAtUnchanged)`(第 3 参 = `form.values.validity.startAt === (task.startAt ? format(new Date(task.startAt), "yyyy-MM-dd") : undefined)`,维持原生命周期不校验倒流,逻辑同原弹窗)→ `AutomationApi.update(taskId, buildTaskParams(form.values, t))` → `invalidateTasks()` → `form.resetSnapshot()` → `toast.success(t("chat:automation.detail.saved"))`;catch → `toast.error(mapIpcError(e))`(mapIpcError 从 `../../chat/lib/error-message` import)。
- `handlePlay`:`setRunning(true)` → 若 `form.isDirty` 先 `handleSave`(失败则中止并复位 running)→ `AutomationApi.runNow(taskId)` → `invalidateQueries({ queryKey: ["automation", "runs"] })` → `toast.success(t("chat:automation.detail.playing"))`;catch → `toast.error(t("chat:automation.detail.runNowFailed"))`;finally `setRunning(false)`。
- `handleDelete`:`AutomationApi.remove([taskId])` → `invalidateTasks()` → navigate 列表(AlertDialog 确认文案 `deleteTitle`/`deleteDesc`,插值 `{ name: task.name }`)。
- `handleLeave`:`form.isDirty ? setDiscardOpen(true) : navigate(-1)`;discard 对话框确认 → `navigate(-1)`。
JSX 顶栏:`<` 返回按钮(ghost size icon,`handleLeave`)、`truncate text-base font-semibold` 任务名、右侧按钮组:播放(variant outline,size sm,`running` 时 disabled + Loader2 `animate-spin` 图标)、删除(ghost size icon Trash2 `text-muted-foreground`)、取消(variant ghost size sm)、保存(variant default size sm,`disabled={!form.isDirty || !canSubmit…}`)。
左侧配置区(`w-[62%] space-y-5 overflow-y-auto p-4`):
1. 名称:`<Input value={form.values.name} onChange={(e) => form.patch({ name: e.target.value })} placeholder={t("…detail.namePlaceholder")} />`
2. 提示词:`<TaskPromptInput value={form.values.prompt} onChange={(prompt) => form.patch({ prompt })} workspaceId={form.values.workspaceId} modelId={form.values.modelId ?? undefined} onModelChange={(modelId) => form.patch({ modelId })} onOpenMcp={() => navigate("/module/ai/experts")} placeholder={t("chat:automation.create.promptPlaceholder")} />`(该 placeholder key 若不存在,复用弹窗现用的提示词 placeholder key,以 CreateTaskDialog JSX 为准)
3. 工作空间:`Select`(shadcn)遍历 `workspaces`,value 为 `String(form.values.workspaceId)`,onChange `form.patch({ workspaceId: Number(v) })`
4. 权限:`<PermissionCapsule sessionId={task.id} accessMode={form.values.accessMode} onChange={(accessMode) => form.patch({ accessMode })} />`(import 自 `../../chat/components/PermissionCapsule`,full 确认弹窗内置于该组件)
5. 频率:只读卡片显示 `task.scheduleText`(标签 `detail.schedule`)+「修改」按钮(variant ghost size sm)开 `ScheduleDialog`;`onChange={(schedule, validity) => form.patch({ schedule, validity })}`

- [ ] **Step 5: 验证**

Run: `npm run typecheck && npm run lint && npx vitest run` → 全过;`npm run dev` 手测:直接访问 `#/module/ai/automation/task/1`(需先删 `database/local.db` 重建,见 Global Constraints)确认顶栏/配置区渲染、脏检测与保存生效。

- [ ] **Step 6: Commit**

```bash
git add src-react/domains/ai/automation/views/TaskDetailView.tsx src-react/domains/ai/automation/components/ScheduleDialog.tsx src-react/routes/index.tsx src-react/i18n/locales/zh-CN/chat.json src-react/i18n/locales/en-US/chat.json
git commit -m "feat(automation): 任务详情页(路由/顶栏/左侧配置区)"
```

---

### Task 5: 右侧运行历史面板

**Files:**
- Create: `src-react/domains/ai/automation/lib/run-display.ts`
- Create: `src-react/domains/ai/automation/components/RunHistoryPanel.tsx`
- Modify: `src-react/domains/ai/automation/views/RunHistoryView.tsx`(改 import 共享函数)
- Modify: `src-react/domains/ai/automation/views/TaskDetailView.tsx`(占位容器换 RunHistoryPanel)
- Modify: `src-react/i18n/locales/{zh-CN,en-US}/chat.json`(history keys)

**Interfaces:**
- Consumes: Task 1 `AutomationApi.runs(page, taskId, status)`;`AUTOMATION_CHANGED_EVENT`
- Produces: `RunHistoryPanel({ taskId }: { taskId: number })`;`localizeRunError`/`formatDuration`/`formatDateTime`(run-display.ts 导出)

- [ ] **Step 1: 抽 run-display.ts**

把 `RunHistoryView.tsx` 内部私有 `localizeRunError`/`formatDuration`/`formatDateTime`(现 26-52 行)整体迁至 `lib/run-display.ts`(同签名导出,文件头注释「运行记录展示工具(全局 Tab 与详情页共享)」),`RunHistoryView` 改 import 并删除原实现。

- [ ] **Step 2: i18n key**(automation 节加)

zh-CN `"history": { "title": "运行历史 ({{count}})", "filterAll": "全部", "filterSuccess": "成功", "filterFailed": "失败", "filterRunning": "运行中", "empty": "暂无运行记录", "errorDetail": "错误详情", "triggerManual": "手动", "viewSession": "查看会话" }`;en-US 对应 `Run history ({{count}})`/`All`/`Success`/`Failed`/`Running`/`No runs yet`/`Error detail`/`Manual`/`Open session`。

- [ ] **Step 3: RunHistoryPanel 组件**

```tsx
/** 任务运行历史(详情页右栏):状态筛选 + 20/页分页 + 失败展开报错 + 行点击跳会话 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, ChevronRight, CircleAlert, Filter, History, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AutomationApi, AUTOMATION_CHANGED_EVENT, type RunStatus } from "../api/automation.api";
import { formatDateTime, formatDuration, localizeRunError } from "../lib/run-display";

type StatusFilter = "all" | RunStatus;
const PAGE_SIZE = 20;

export default function RunHistoryPanel({ taskId }: { taskId: number }) {
  const { t } = useTranslation(["chat", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["automation", "runs", taskId, page, status],
    queryFn: () => AutomationApi.runs(page, taskId, status === "all" ? undefined : status),
  });
  // 执行完成事件 → 刷新列表与首屏
  useEffect(() => {
    const cb = () => {
      void queryClient.invalidateQueries({ queryKey: ["automation", "runs", taskId] });
      void queryClient.invalidateQueries({ queryKey: ["automation", "tasks"] });
    };
    window.ipcRenderer.on(AUTOMATION_CHANGED_EVENT, cb);
    return () => window.ipcRenderer.removeListener(AUTOMATION_CHANGED_EVENT, cb);
  }, [taskId, queryClient]);
  // status 变化重置页码
  useEffect(() => setPage(1), [status]);
  // …渲染:标题行(总数十漏斗 DropdownMenu)、空态、行列表、分页
}
```
行渲染规则:
- 状态徽标:`running` → 灰字 `text-muted-foreground` + `Loader2 className="h-3.5 w-3.5 animate-spin text-primary"`;`success` → `text-primary Check`(项目用主题色承载"成功绿",PRD 的绿即默认蓝主题下的主色,不硬编码绿色);`failed` → `text-destructive CircleAlert`;`skipped` → `text-muted-foreground CircleAlert`
- 副行:`formatDateTime(startedAt)` · `formatDuration(durationMs)` · triggerType 为 manual 时缀 `t("…history.triggerManual")`
- 失败行可点击展开:`expandedId === run.id` 时渲染 `<pre className="mt-1 whitespace-pre-wrap rounded-md bg-muted/60 p-2 text-xs text-destructive">{localizeRunError(run.error, t) || t("…history.errorDetail")}</pre>`
- `sessionId` 存在时行主体点击 `navigate(\`/module/ai?session=${run.sessionId}\`)`
- 分页:`ChevronLeft/Right` ghost icon 按钮,`page > 1`/`page < Math.ceil(total / PAGE_SIZE)` 控制禁用
- 空态:`History` 图标 + `history.empty` 文案
- TaskDetailView 右栏占位替换:`<RunHistoryPanel taskId={task.id} />`(容器 `w-[38%] min-w-0 border-l border-border/50`)

- [ ] **Step 4: 验证**

Run: `npm run typecheck && npm run lint && npx vitest run` → 全过;dev 手测:播放触发后右栏出现「运行中」→ 状态流转、筛选/翻页、失败展开。

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/automation/lib/run-display.ts src-react/domains/ai/automation/components/RunHistoryPanel.tsx src-react/domains/ai/automation/views/RunHistoryView.tsx src-react/domains/ai/automation/views/TaskDetailView.tsx src-react/i18n/locales/zh-CN/chat.json src-react/i18n/locales/en-US/chat.json
git commit -m "feat(automation): 任务运行历史面板(筛选/分页/报错展开)"
```

---

### Task 6: 入口切换 + 弹窗瘦身 + 验收

**Files:**
- Modify: `src-react/domains/ai/automation/views/TaskListView.tsx`(TaskRow onClick 改 navigate)
- Modify: `src-react/domains/ai/automation/components/CreateTaskDialog.tsx`(删 editTask 分支)

**Interfaces:**
- Consumes: Task 4 路由 `/module/ai/automation/task/:id`
- Produces: 无(行为切换)

- [ ] **Step 1: TaskListView 入口切换**

`useNavigate` 引入;`TaskRow onClick` 由 `setEditing(task); setDialogOpen(true)` 改为:
```tsx
onClick={() => navigate(`/module/ai/automation/task/${task.id}`)}
```
删除 `editing` state 与相关 `setEditing` 调用(保留 `dialogOpen` 供新建/模板)。

- [ ] **Step 2: CreateTaskDialog 删除编辑模式**

- props 删 `editTask?: TaskRecord`(Task 3 接入时若 hook source 还传 task,同步删)
- 初始化/回填中 `editTask` 分支与 `startAtUnchanged` 特判删除(编辑期防倒流逻辑随详情页走:详情页保存调 `canSubmitForm` 时第 3 参按 Task 4 公式计算)
- `handleSubmit` 删 update 分支与「已更新」toast;`templateSlug` 仅取 `template?.slug`
- i18n `create.titleEdit` key 保留无害,不删(避免牵连);文件头注释同步

- [ ] **Step 3: 全量验证 + 手动验收**

Run: `npm run lint && npm run typecheck && npx vitest run` → 全过。

手动验收(spec §6,删库重建后执行):
1. 列表点任务 → 详情页,五项配置回填正确
2. 改名称/提示词/空间/权限/频率 → 保存 → 重进,值保持
3. 播放(带脏改动)→ 自动保存 → 右栏出现 运行中→成功/失败;失败可展开 error
4. 筛选漏斗(成功/失败/运行中)+ 翻页正常
5. 取消(脏)→ 确认丢弃 → 回列表,值未变
6. 删除 → 确认 → 回列表,任务消失
7. accessMode=default 的任务执行时写类工具被拒(agent 收到拒绝反馈,任务继续);full 全放行

- [ ] **Step 4: Commit**

```bash
git add src-react/domains/ai/automation/views/TaskListView.tsx src-react/domains/ai/automation/components/CreateTaskDialog.tsx
git commit -m "feat(automation): 任务行点击进详情页,弹窗移除编辑模式"
```
