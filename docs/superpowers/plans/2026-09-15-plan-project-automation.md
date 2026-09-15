# 项目计划模块 · 子系统 E：项目级定时任务 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** automationTask 项目化——projectId 列贯通、runner 会话归属与项目指令注入、CreateTaskDialog 项目预设、ConfigPanel 定时任务区块升级为项目任务管理。

**Architecture:** v7 加 `projectId` 列（hydration 带出、create/update 透传，list 通道不改前端过滤）；runner `createSession` 写 projectId + system prompt 注入 project.systemPrompt（复用 buildSystemPrompt 首参通道）；运行结果独立会话归属项目（动态流单会话模型不动）；删项目级联删任务。

**Tech Stack:** 既有栈零新依赖；Vitest（node:sqlite 测 v7、vi.mock 测 repo/runner、jsdom 测组件）。

**Spec:** `docs/superpowers/specs/2026-09-15-plan-project-automation-design.md`

## Global Constraints

- 文案走 `t()`，zh-CN 与 en-US 同步新增；key camelCase。跨命名空间用 `useTranslation(["project", "chat"])` 数组注册（ProjectChatBar 先例）。
- 颜色主题变量；弹层 `border border-border/50 rounded-lg shadow-lg`；hover 三件套。
- 数据库迁移：`electron/infrastructure/script/v7/upgrade-table.sql` + `Constants.DATABASE_VERSION` 6→7；`npx prisma generate` 输出 TRACKED 随任务提交。
- runner 注入语义：`task.projectId` 非空 → `prisma.project.findUnique` 取 systemPrompt → `buildSystemPrompt(project.systemPrompt || undefined, skills)`；null → `buildSystemPrompt(undefined, skills)` 原行为。
- ConfigPanel 行为：toggle → `AutomationApi.toggle` + invalidate `["automation", "tasks"]`；runNow → `AutomationApi.runNow`（失败含 `TASK_ALREADY_RUNNING` 时专用文案，TaskDetailView 先例）；任务名 navigate `/module/ai/automation/task/:id`。
- CreateTaskDialog 可选 prop 未传时行为完全不变（AI 模块零 diff）。
- 验证命令：`npm run test` / `npm run typecheck` / `npm run lint`——每任务三绿后 commit。

---

### Task 1: v7 迁移 + entity/repo projectId 贯通

**Files:**
- Create: `electron/infrastructure/script/v7/upgrade-table.sql`
- Modify: `prisma/schema.prisma`（automationTask 模型加 projectId + 索引）
- Modify: `electron/Constants.ts:11`（DATABASE_VERSION 6→7）
- Modify: `src-react/domains/ai/automation/api/automation.api.ts`（TaskRecord + TaskCreateParams）
- Modify: `electron/domains/ai/automation/automation.repo.ts`（toTaskRecord + buildTaskData）
- Test: `tests/ai/automation-v7-schema.test.ts`（新建）、`tests/ai/automation-repo.test.ts`（追加）

**Interfaces:**
- Consumes: v6 测试 helper 模式（ignore-aware statements）；automation-repo.test.ts 的 toTaskRecord/buildTaskData 纯函数断言模式。
- Produces（T2/T4 依赖）:
  - `TaskRecord.projectId: number | null`；`TaskCreateParams.projectId?: number | null`（TaskUpdateParams = TaskCreateParams 同步）。
  - `buildTaskData(params, now)` 输出含 `projectId: params.projectId ?? null`（create）/ 透传（update 走同函数——**注意**：update 需显式传 projectId 才写列，buildTaskData 对 undefined 的处理：create 缺省 null，update undefined 不写列。两语义并存 → buildTaskData 保持白名单直接展开 `...(params.projectId !== undefined && { projectId: params.projectId })` + create 侧补 `projectId: params.projectId ?? null`。执行者按此实现并在测试断言两种路径）。
  - `toTaskRecord(row, workspace)` 输出带 `projectId: row.projectId ?? null`。

- [ ] **Step 1: 写失败的 v7 schema 测试**（helper 从 v6 测试复制 ignore-aware 版；按序执行 v1..v7 太重——automationTask 在 v1 建表，执行 v1+v7 即可覆盖列存在；索引断言 `PRAGMA index_list(automationTask)` 含 `automation_task_projectId_index`；重放幂等走 applyStatements）

```ts
// tests/ai/automation-v7-schema.test.ts
// @vitest-environment node
/** v7 增量脚本测试（v1 建 automationTask 基础上执行 v7）：projectId 列存在
 * 且 NULL 默认；索引存在；v7 重放幂等（ignore-aware helper 同 v6 测试） */
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const scriptDir = (version: string) =>
  path.resolve(__dirname, `../../electron/infrastructure/script/v${version}/upgrade-table.sql`);

/** ignore-aware 语义（--/ignore 标记的语句吞错），同 v6 测试 */
function statements(sql: string): Array<{ sql: string; ignoreError: boolean }> {
  const out: Array<{ sql: string; ignoreError: boolean }> = [];
  let ignoreNext = false;
  for (const rawLine of sql.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("--")) {
      if (line.startsWith("--/ignore")) {
        ignoreNext = true;
      }
      continue;
    }
    // 按分号聚合由执行器处理；此 helper 逐行执行单语句脚本（v7 全为单行语句）
    if (line) {
      out.push({ sql: line, ignoreError: ignoreNext });
      ignoreNext = false;
    }
  }
  return out;
}

function applyStatements(db: DatabaseSync, sql: string) {
  for (const { sql: stmt, ignoreError } of statements(sql)) {
    try {
      db.exec(stmt);
    } catch (error) {
      if (!ignoreError) {
        throw error;
      }
    }
  }
}

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const version of ["1", "7"]) {
    applyStatements(db, readFileSync(scriptDir(version), "utf8"));
  }
  return db;
}

describe("v7 增量脚本（automationTask.projectId）", () => {
  it("列存在且默认 NULL；索引存在", () => {
    const db = createDb();
    const columns = (
      db.prepare("PRAGMA table_info(automationTask)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toContain("projectId");
    const indexes = (
      db.prepare("PRAGMA index_list(automationTask)").all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(indexes).toContain("automation_task_projectId_index");
  });

  it("v7 重放幂等（ALTER 重复列被 ignore）", () => {
    const db = createDb();
    expect(() =>
      applyStatements(db, readFileSync(scriptDir("7"), "utf8")),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/ai/automation-v7-schema.test.ts`
Expected: FAIL（script/v7 不存在）

- [ ] **Step 3: 写 v7 脚本 + schema + 版本号 + prisma generate**

```sql
-- electron/infrastructure/script/v7/upgrade-table.sql
--/p 自动化任务项目化（子系统 E：projectId NULL = 全局任务；运行会话归属项目并注入项目指令）
--/ignore
ALTER TABLE automationTask ADD COLUMN projectId INTEGER NULL;
--/ignore
CREATE INDEX IF NOT EXISTS automation_task_projectId_index ON automationTask (projectId);
```

`prisma/schema.prisma` automationTask 模型 `templateSlug String?` 后加 `projectId Int? // NULL = 全局任务（子系统 E）`；块属性区加 `@@index([projectId], map: "automation_task_projectId_index")`。`Constants.ts` `DATABASE_VERSION = 7`。`npx prisma generate`。

- [ ] **Step 4: entity/repo 贯通（先追加失败测试再实现）**

automation-repo.test.ts 追加（纯函数断言，fixture 含 projectId）：

```ts
describe("projectId 贯通（子系统 E）", () => {
  it("buildTaskData：create 路径缺省 null；显式传入透传", () => {
    const now = new Date("2026-09-15T00:00:00Z");
    const base = { name: "t", prompt: "p", workspaceId: 1, modelId: 2, schedule: { mode: "periodic", kind: "daily", time: "09:00" }, scheduleText: "每天 09:00", missedPolicy: "skip" };
    const withNull = buildTaskData({ ...base } as never, now);
    expect(withNull.projectId).toBeNull();
    const withId = buildTaskData({ ...base, projectId: 11 } as never, now);
    expect(withId.projectId).toBe(11);
  });

  it("toTaskRecord：row.projectId 透出（null 容错）", () => {
    const ws = { id: 1, name: "空间", directoryPath: "/x" };
    expect(toTaskRecord({ ...rowFixture, projectId: 11 }, ws).projectId).toBe(11);
    expect(toTaskRecord({ ...rowFixture, projectId: null }, ws).projectId).toBeNull();
  });
});
```

（`rowFixture` 为该文件已有 row 常量名——执行者按实际名对齐；schedule 形状按 entity 实际 ScheduleConfig 调整。）

实现：
1. `automation.api.ts`：`TaskRecord` 加 `projectId: number | null`（JSDoc：所属项目 id，null = 全局任务）；`TaskCreateParams` 加 `projectId?: number | null`。
2. `automation.repo.ts` `toTaskRecord` 返回对象加 `projectId: row.projectId ?? null`；`buildTaskData` 返回对象加 `projectId: params.projectId ?? null`（create/update 共用——update 未传时写 null=解除关联，与 TaskUpdateParams=CreateParams 的全量更新语义一致；在 buildTaskData JSDoc 注明）。

- [ ] **Step 5: 运行确认通过**

Run: `npm run test -- tests/ai/automation-v7-schema.test.ts tests/ai/automation-repo.test.ts && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add electron/infrastructure/script/v7 prisma/schema.prisma electron/Constants.ts electron/generated src-react/domains/ai/automation/api/automation.api.ts electron/domains/ai/automation/automation.repo.ts tests/ai/automation-v7-schema.test.ts tests/ai/automation-repo.test.ts
git commit -m "feat(project): 数据库 v7——automationTask 加 projectId 列贯通 entity/repo（null=全局任务）"
```

---

### Task 2: runner 项目化（会话归属 + 项目指令注入）+ 项目级联

**Files:**
- Modify: `electron/domains/ai/automation/automation-runner.ts`
- Modify: `electron/domains/project/project.repo.ts`（remove 级联补一行）
- Test: `tests/ai/automation-runner.test.ts`（追加）、`tests/project/project-repo.test.ts`（追加断言）

**Interfaces:**
- Consumes: T1 的 `AutomationTaskRow.projectId`（prisma 类型含新列）；`buildSystemPrompt(base, skills)`（skill-prompt.ts）。
- Produces:
  - `createSession(task)` data 含 `projectId: task.projectId ?? null`。
  - executeTask 内新增（约 L228 buildSystemPrompt 调用处之前的执行前段）：

```ts
/** 项目任务：读项目指令注入 system prompt（子系统 E） */
const projectRow = task.projectId
  ? await prisma.project.findUnique({
      where: { id: task.projectId },
      select: { systemPrompt: true },
    })
  : null;
const projectPrompt = projectRow?.systemPrompt?.trim() || undefined;
```

  调用处改 `system: buildSystemPrompt(projectPrompt, skills)`。prisma mock 补 `project: { findUnique: vi.fn() }`。

- [ ] **Step 1: 追加失败的 runner 测试**（现有成功路径 stub 序列 L170-189 顺序敏感——新增 project 查询在 workspace 查询后、session.create 前后均可，测试按实现插入点对齐 mockResolvedValueOnce 链；用 mockResolvedValue（非 Once）加 clearAllMocks 隔离更稳，执行者按文件现有风格）

```ts
it("项目任务：session.create 带 projectId 且 system prompt 注入项目指令", async () => {
  // fixture taskRow 加 projectId: 11
  prisma.project.findUnique.mockResolvedValue({ systemPrompt: "# 角色：项目经理" });
  // …走通成功路径的既有 stub（workspace/model/provider/session/run…）
  await executeTask(taskRow, opts);
  expect(prisma.session.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ projectId: 11 }),
    }),
  );
  expect(runChatStreamMock).toHaveBeenCalledWith(
    expect.objectContaining({ system: expect.stringContaining("# 角色：项目经理") }),
  );
  expect(prisma.project.findUnique).toHaveBeenCalledWith({
    where: { id: 11 },
    select: { systemPrompt: true },
  });
});

it("全局任务（projectId null）：不查 project，system 不含项目段（行为不变）", async () => {
  // taskRow 不带 projectId（或 null）——现有用例改造成显式断言 prisma.project.findUnique 未被调用
  await executeTask(taskRow, opts);
  expect(prisma.project.findUnique).not.toHaveBeenCalled();
});

it("项目存在但指令为空：buildSystemPrompt 收到 undefined（仅技能段）", async () => {
  prisma.project.findUnique.mockResolvedValue({ systemPrompt: "   " });
  await executeTask(taskRow, opts);
  expect(runChatStreamMock).toHaveBeenCalledWith(
    expect.objectContaining({ system: expect.not.stringContaining("角色") }),
  );
});
```

（executeTask/runChatStream 的测试导入与 opts 构造按文件既有用例复制；`system` 为 undefined 时 runChatStream 收到 undefined——用 expect.not.stringContaining 前先核对 buildSystemPrompt 返回值语义，undefined skills+undefined base → undefined。断言写 `toHaveBeenCalledWith(expect.objectContaining({ system: undefined }))` 或按实际返回。）

project-repo.test.ts remove 级联追加（prismaStub 补 `automationTask: { deleteMany: vi.fn() }`）：

```ts
    expect(prismaStub.automationTask.deleteMany).toHaveBeenCalledWith({
      where: { projectId: 11 },
    });
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/ai/automation-runner.test.ts tests/project/project-repo.test.ts`
Expected: FAIL（projectId 未消费）

- [ ] **Step 3: 实现**

1. `automation-runner.ts`：createSession data 加 `projectId: task.projectId ?? null`；executeTask 按 Interfaces 块插入 projectRow/projectPrompt 段；`system: buildSystemPrompt(projectPrompt, skills)`。头注释补一行项目注入说明。
2. `project.repo.ts` remove()：planItemAttachment 级联行后加：

```ts
    // 级联清项目定时任务（子系统 E）
    await prisma.automationTask.deleteMany({ where: { projectId: id } });
```

- [ ] **Step 4: 运行确认通过 + runner 全文件回归**

Run: `npm run test -- tests/ai/automation-runner.test.ts tests/project/project-repo.test.ts && npm run typecheck && npm run lint`
Expected: PASS（既有 runner 用例不回归）

- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/automation/automation-runner.ts electron/domains/project/project.repo.ts tests/ai/automation-runner.test.ts tests/project/project-repo.test.ts
git commit -m "feat(project): runner 项目化——运行会话归属项目+项目指令注入 system prompt；删项目级联清任务"
```

---

### Task 3: CreateTaskDialog 项目预设

**Files:**
- Modify: `src-react/domains/ai/automation/components/CreateTaskDialog.tsx`
- Modify: `src-react/domains/ai/automation/lib/task-form.ts`（buildTaskParams 加 projectId）+ `use-task-form.ts`（source 透传）
- Test: `tests/ai/task-form.test.ts`（追加）、`tests/ai/create-task-project.test.tsx`（新建）

**Interfaces:**
- Consumes: T1 的 `TaskCreateParams.projectId`。
- Produces:
  - `CreateTaskDialogProps` 增可选 `project?: { id: number; workspaceId: number; workspaceName: string }`——传入时：workspace Select **禁用**、值锁定 `project.workspaceId`、显示 `project.workspaceName`、跳过 `["workspaces"]` 查询（`enabled: open && !project`）；`buildInitialValues` 初值 workspaceId 取 project.workspaceId；保存 payload `projectId: project.id`。
  - `TaskFormValues` 加 `projectId?: number | null`；`buildTaskParams` 输出含 `projectId: v.projectId ?? null`；use-task-form 的 source（task 回填路径）透传 `projectId: task.projectId`（编辑回填）。template/空初值 projectId null。
  - 未传 project：所有路径行为不变（AI 模块零 diff）。

- [ ] **Step 1: 写失败的测试**

task-form.test.ts 追加：

```ts
it("buildTaskParams：projectId 透传；缺省 null", () => {
  const base = { name: "t", prompt: "p", workspaceId: 1, modelId: 2, schedule: 默认调度, validity: 默认有效期 } as never;
  expect(buildTaskParams({ ...base, projectId: 11 } as never, tStub).projectId).toBe(11);
  expect(buildTaskParams({ ...base } as never, tStub).projectId).toBeNull();
});
```

（base 形状按文件既有用例复制；tStub 同文件既有。）

create-task-project.test.tsx（jsdom；mock 骨架参照 automation 相关组件测试——react-i18next/sonner/@/i18n 桩 + WorkspaceApi/AutomationApi mock）：

1. 「传入 project：workspace Select 禁用且显示项目空间名；不发起 ["workspaces"] 查询（WorkspaceApi.list 未被调）」
2. 「保存：AutomationApi.create 收到 projectId: 11 且 workspaceId: 30（锁定值）」
3. 「未传 project：行为不变（workspace 查询发起、payload 无 projectId 键或 null）」

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/ai/task-form.test.ts tests/ai/create-task-project.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

1. `task-form.ts`：`TaskFormValues` 加 `projectId?: number | null`；buildInitialValues 三分支（task 回填 `projectId: task.projectId ?? null`；template/空 → null）；`buildTaskParams` 输出加 `projectId: v.projectId ?? null`。
2. `use-task-form.ts`：source.task 透传已在 buildInitialValues 处理（核对无需另改则只动类型）；若 effect 需感知（不需要——projectId 无联动）。
3. `CreateTaskDialog.tsx`：props 加 `project?`；workspace 查询 `enabled: open && !project`；Select 段改为：

```tsx
<Select
  value={String(values.workspaceId ?? "")}
  onValueChange={(v) => patch({ workspaceId: Number(v) })}
  disabled={Boolean(project)}
>
  <SelectTrigger aria-label={t("chat:automation.create.workspace")}>
    <SelectValue placeholder={project?.workspaceName ?? t("chat:automation.create.workspacePlaceholder")} />
  </SelectTrigger>
  {!project && (
    <SelectContent>
      {workspaces.map((w) => (
        <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>
      ))}
    </SelectContent>
  )}
</Select>
```

（锁定时 value=project.workspaceId——buildInitialValues 分支需感知 project：入参 source 加 `projectWorkspaceId?: number`，空初值时 `workspaceId: projectWorkspaceId ?? null`。open 回填 effect 处传 `project?.workspaceId`。）
4. handleSubmit：`params.projectId = project?.id ?? params.projectId`（直接由 form.buildParams 出——初值已带 project.id 则无需覆写；执行者选一实现并测试锁死）。
5. 头注释补项目预设说明。

- [ ] **Step 4: 运行确认通过**

Run: `npm run test -- tests/ai/task-form.test.ts tests/ai/create-task-project.test.tsx tests/ai && npm run typecheck && npm run lint`
Expected: PASS（automation 既有测试全回归）

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/automation/components/CreateTaskDialog.tsx src-react/domains/ai/automation/lib/task-form.ts src-react/domains/ai/automation/lib/use-task-form.ts tests/ai/task-form.test.ts tests/ai/create-task-project.test.tsx
git commit -m "feat(project): CreateTaskDialog 项目预设——可选 project prop 锁定资产空间/载荷携 projectId（未传零行为变化）"
```

---

### Task 4: ConfigPanel 定时任务区块升级 + 收尾

**Files:**
- Modify: `src-react/domains/project/components/ConfigPanel.tsx`
- Modify: `src-react/i18n/locales/*/project.json`
- Test: `tests/project/config-panel-automation.test.tsx`（新建）、`tests/project/project-workspace.test.tsx`（回归确认）

**Interfaces:**
- Consumes: T1 `TaskRecord.projectId`；T3 `CreateTaskDialog project` prop；`AutomationApi.list/toggle/runNow`；`useQuery(["automation", "tasks"])`；`mapIpcError`；chat 命名空间状态文案 key（`chat:automation.status.running/paused/error/expired`、`chat:automation.list.lastRun`）。
- Produces: ConfigPanel 定时任务区块终态（列表/启停/立即运行/新建/跳转/空态）；workspace 集成回归绿。

- [ ] **Step 1: 写失败的组件测试**（jsdom；骨架参照 tests/project/config-panel 既有或 picker-dialog 测试：react-i18next key 直返/sonner/@/i18n 桩 + AutomationApi/ProjectApi mock + QueryClientProvider）

用例清单（fixture：本项目任务 ×2（active+paused）+ 他项目任务 ×1 + 全局任务 ×1）：
1. 「过滤：仅本项目两行渲染（projectId 匹配 detail.project.id），他项目/全局不出现」
2. 「行字段：名称 + scheduleText + 状态徽标（enabled ? running : paused；error/expired Badge）+ 上次运行时间」
3. 「启停：点 Switch → AutomationApi.toggle(id, false) + invalidate ["automation","tasks"]；失败 toast」
4. 「立即运行：点按钮 → AutomationApi.runNow(id)；reject TASK_ALREADY_RUNNING → 专用冲突文案 toast（mapIpcError 含串判定，TaskDetailView 先例）；其他错误 → mapIpcError 文案」
5. 「新建：点按钮 → CreateTaskDialog 打开且收到 project prop { id, workspaceId: detail.assetWorkspaceId, workspaceName }」（CreateTaskDialog mock 捕获 props；workspaceName 取项目空间名——需 ConfigPanel 可得：ProjectDetail 无 workspaceName 字段，用 `t("project:panel.projectWorkspace")` 通用文案「项目资产空间」作锁定显示名——**裁决**：不新增查询，锁定名用通用文案）
6. 「任务名点击 → navigate /module/ai/automation/task/:id」（MemoryRouter 捕获）
7. 「空态：无本项目任务 → project:panel.automationEmpty 文案 + 新建按钮；「前往自动化」链接恒在」

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- tests/project/config-panel-automation.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现 ConfigPanel 区块**

1. imports：`useTranslation(["project", "chat"])`、`Switch`（@/components/ui/switch）、`Play` 图标、`AutomationApi`、`CreateTaskDialog`、`useNavigate`（已有）。
2. 数据与状态：

```tsx
  const { data: allTasks = [] } = useQuery({
    queryKey: ["automation", "tasks"],
    queryFn: () => AutomationApi.list(),
  });
  /** 本项目任务（前端过滤，FilterMenu 先例） */
  const projectTasks = useMemo(
    () => allTasks.filter((task) => task.projectId === detail.project.id),
    [allTasks, detail.project.id],
  );
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  /** 上次运行相对文案复用 chat:automation.list.lastRun（含 {{time}} 插值——t 直用） */
```

3. 区块 JSX（替换 L222-238 的单行卡片；区块头 = 标题 + 新建按钮 + 前往自动化链接）：

```tsx
        <section aria-label={t("project:panel.automation")} className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium text-muted-foreground">
              {t("project:panel.automation")}
            </h3>
            <div className="flex items-center gap-1.5">
              <Button variant="ghost" size="sm" onClick={() => setTaskDialogOpen(true)}
                className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary">
                <Plus className="h-3.5 w-3.5" />
                {t("project:panel.automationNew")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => navigate(AUTOMATION_ROUTE)}
                className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary">
                {t("project:panel.goAutomation")}
              </Button>
            </div>
          </div>
          {projectTasks.length === 0 ? (
            <p className="rounded-lg border border-border/50 p-3 text-xs text-muted-foreground">
              {t("project:panel.automationEmpty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {projectTasks.map((task) => (
                <TaskListItem key={task.id} task={task} onOpen={() => navigate(`/module/ai/automation/task/${task.id}`)} />
              ))}
            </ul>
          )}
        </section>
```

4. 行组件 `TaskListItem`（ConfigPanel 内或同文件底部小组件，≤20 行拆分）：名称 button（左）+ scheduleText（muted 截断）+ 状态 Badge（error/expired destructive 系；enabled ? running : paused——文案 `t("chat:automation.status.…")`）+ lastRunAt 相对文案 + Switch + Play 按钮。启停/运行 handler 按 Global Constraints 的 toggle/runNow 先例（含 TASK_ALREADY_RUNNING 专用文案 `project:panel.taskRunning`）。
5. 弹窗挂载：`<CreateTaskDialog open={taskDialogOpen} onOpenChange={setTaskDialogOpen} project={{ id: detail.project.id, workspaceId: detail.assetWorkspaceId, workspaceName: t("project:panel.projectWorkspace") }} />`。
6. i18n（project.json 双语言，panel 段）：`automationNew` 新建/`New`、`automationEmpty` 暂无定时任务/`No scheduled tasks yet`、`projectWorkspace` 项目资产空间/`Project assets`、`taskRunning` 任务正在运行中，请稍候/`Task is already running`。

- [ ] **Step 4: 运行确认通过 + 全量回归**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: 全绿（project-workspace 等集成回归）

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/project/components/ConfigPanel.tsx src-react/i18n/locales tests/project/config-panel-automation.test.tsx
git commit -m "feat(project): ConfigPanel 定时任务区块升级——项目任务列表/启停/立即运行/新建预设项目空间/空态（前往自动化入口保留）"
```

---

## 手动验收清单（spec §4）

1. 项目配置面板：新建「每日汇报」任务 → 弹窗工作空间锁定显示「项目资产空间」且不可改；prompt 输 `@` 可联想资产文件。
2. 立即运行 → 任务详情运行历史出现新记录；打开运行会话（消息属项目，AI 侧边栏不可见）；确认 AI 回复带项目指令的角色语义。
3. ConfigPanel 列表状态同步（运行中/暂停切换）、他项目与全局任务不出现。
4. 删除项目 → 该项目任务级联清理（`SELECT COUNT(*) FROM automationTask WHERE projectId=<id>` 为 0）。
5. AI 模块自动化页行为不变（全局任务创建/列表照常）。

## 自审记录（writing-plans Self-Review）

1. **Spec coverage**：§1 数据模型与 runner（T1/T2）；§2 ConfigPanel（T4）；§3 CreateTaskDialog（T3）；§4 测试（各任务 TDD + 手动验收）。级联/hydration/注入/锁定全覆盖。
2. **占位符**：T2 runner 测试的 stub 链与 T3 的初值分支给了行为规格 + 指引（文件既有用例为模板——探索报告提供了精确行号与 fixture 名），其余含完整代码/断言。无 TBD。
3. **类型一致性**：`TaskRecord.projectId`/`TaskCreateParams.projectId`（T1 定义，T2 runner 用 task.projectId、T3 form/buildParams、T4 过滤消费）一致；`CreateTaskDialog project` prop 形状 T3/T4 一致（workspaceName 通用文案裁决已在 T4 Step1#5 标注）。

