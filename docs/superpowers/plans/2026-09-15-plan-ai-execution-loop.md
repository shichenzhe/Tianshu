# 项目计划模块 · 子系统 F：AI 执行闭环 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** plan-item agent 工具组（建/流转/追加进展）+ aiSummary 数据层 + `#待办` 引用携带进展 + 任务行「AI 推进」双入口——计划清单从人工台账转为「AI 驱动为主，人维护为辅」。

**Architecture:** 三个 `plan_*` 工具走既有 ToolDefinition/registry/权限框架（kind:"write" 自动进审批门禁），`ToolContext` 扩 `projectId?` + collectToolDefinitions 非项目会话过滤双保险；v8 加 `planItem.aiSummary`（只经 append 工具写入，人路径负向排除）；预填走新 zustand store（create-skill.store 读后即清先例 + ChatInput 常驻底栏的运行期消费）。

**Tech Stack:** 既有栈零新依赖（zod 工具 schema、date-fns format、zustand）；Vitest（node:sqlite/vi.mock/jsdom）。

**Spec:** `docs/superpowers/specs/2026-09-15-plan-ai-execution-loop-design.md`

## Global Constraints

- 工具契约：`ToolDefinition`（electron/domains/ai/agent/file-tools.ts L17-25）——`execute(ctx, args): Promise<string>` **方法签名**（非属性）；错误**返回** `"错误: <中文>"` 前缀字符串（不抛，state 判定依赖此前缀）；schema 字段名 `parameters`（zod，`.describe()` 中文参数说明）；`kind: "write"` 三工具全部。
- 注册/过滤：工具经工厂 `makePlanTools(deps)` 产出数组，静态注册进 tool-registry（skill.repo.ts L63-71 先例，deps 在装配层注入）；chat.service `collectToolDefinitions`（L1199）加过滤——**非项目会话（allowedMcpServers === null）剔除 `plan_` 前缀工具**。
- ToolContext 扩展：`{ workspacePath; sessionId; fullAccess?; projectId?: number | null }`——chat.service 组装 agent（resolveAgentOptions L1160-1189 附近的 stream options 构造处）带上 `session.projectId`；工具内 `ctx.projectId == null` 返回 `"错误: 当前会话未关联项目"`（双保险兜底）。
- aiSummary 语义：`(旧值 ? 旧值 + "\n" : "") + \`[${format(new Date(), "yyyy-MM-dd")}] ${text}\``（date-fns，automation-runner.ts L33 先例）；append 后失效 `PLAN_ITEMS_KEY(projectId)` + `PLAN_ITEMS_MINE_KEY(userId)`（ctx 只有 sessionId——追加摘要后失效 tasks 主 key 即可，mine key 由下次自然刷新；**裁决简化**：工具内不失效 mine，主 key 失效即驱动五视图，mine 在任务 Tab 挂载时自愈）。
- 文案 t() 双语言；主题变量；execute 纯 Node 禁 import electron（read-skill.ts 头注释惯例——工具文件必须可被 vitest 直接测试）。
- 验证命令：`npm run test` / `npm run typecheck` / `npm run lint`——每任务三绿后 commit。

---

### Task 1: v8 迁移 + entity aiSummary 贯通（人路径负向）

**Files:**
- Create: `electron/infrastructure/script/v8/upgrade-table.sql`
- Modify: `prisma/schema.prisma`（planItem 加 aiSummary）+ `electron/Constants.ts`（DATABASE_VERSION 7→8）+ `npx prisma generate`
- Modify: `electron/domains/project/plan-item.entity.ts`（PlanItemRecord.aiSummary）+ `electron/domains/project/plan-item.repo.ts`（toRecord 归一空串）
- Test: `tests/project/plan-item-v8-schema.test.ts`（新建）、`tests/project/plan-item-repo.test.ts`（追加）

**Interfaces:**
- Consumes: v7 测试 helper（ignore-aware statements/applyStatements——从 v6/v7 测试复制）。
- Produces（T2/T3/T4 依赖）: `PlanItemRecord.aiSummary: string`（null→"" 归一）；DB 列 `aiSummary TEXT NULL`。**Create/Update 参数不加该键**——负向断言锁定（buildUpdateData 输出无 aiSummary 键）。

- [ ] **Step 1: 写失败的 v8 schema 测试**（v4+v5+v8 按序执行——planItem 在 v4 建；列存在 + 默认 NULL + 重放幂等；helper 从 v7 测试复制 ignore-aware 版）

```ts
// tests/project/plan-item-v8-schema.test.ts —— 结构同 v7 测试：
// createDb 执行 ["4","5","8"]；断言 PRAGMA table_info(planItem) 含 "aiSummary"；
// INSERT 后 SELECT aiSummary → null；applyStatements 重放 v8 不抛（ALTER 重复列被 ignore）
```

- [ ] **Step 2: 运行确认失败**（script/v8 不存在 ENOENT）

```sql
-- electron/infrastructure/script/v8/upgrade-table.sql
--/p 计划事项 AI 进展摘要（子系统 F：只经 plan_append_summary 工具追加写入，人路径不可编辑）
--/ignore
ALTER TABLE planItem ADD COLUMN aiSummary TEXT NULL;
```

prisma planItem 模型 description 后加 `aiSummary String? // AI 进展摘要（只经工具追加）`；Constants 8；prisma generate。

- [ ] **Step 3: repo 贯通（先失败测试）**

plan-item-repo.test.ts 追加：

```ts
it("toRecord：aiSummary null 容错归一空串", async () => {
  prismaStub.planItem.findMany.mockResolvedValue([{ ...projectRow, aiSummary: "[2026-09-15] 完成" }]);
  expect((await repo.list(11))[0].aiSummary).toBe("[2026-09-15] 完成");
  prismaStub.planItem.findMany.mockResolvedValue([{ ...projectRow, aiSummary: null }]);
  expect((await repo.list(11))[0].aiSummary).toBe("");
});

it("人路径负向：buildUpdateData/create 输出永不含 aiSummary 键", async () => {
  prismaStub.planItem.create.mockResolvedValue({ ...projectRow, id: 9 });
  await repo.create({ createdById: 1, projectId: 11, title: "t" } as never);
  const data = prismaStub.planItem.create.mock.calls[0][0].data;
  expect("aiSummary" in data).toBe(false);
  prismaStub.planItem.findUnique.mockResolvedValue(projectRow);
  await repo.update({ id: 1, title: "x", aiSummary: "hack" } as never);
  expect("aiSummary" in prismaStub.planItem.update.mock.calls[0][0].data).toBe(false);
});
```

实现：entity `PlanItemRecord` 加 `aiSummary: string`（JSDoc：AI 进展摘要，空串=无，只经 plan_append_summary 工具写入）；toRecord 加 `aiSummary: row.aiSummary ?? ""`；**buildUpdateData/create 不动**（负向天然成立，测试锁定防回归）。repo 另加工具专用方法（T2 消费）：

```ts
  /** AI 追加进展（工具专用通道；只增不改） */
  async appendAiSummary(id: number, text: string): Promise<string | null> {
    const row = await prisma.planItem.findUnique({ where: { id } });
    if (!row) {
      return null;
    }
    const next = `${row.aiSummary ? row.aiSummary + "\n" : ""}[${format(new Date(), "yyyy-MM-dd")}] ${text}`;
    await prisma.planItem.update({ where: { id }, data: { aiSummary: next } });
    return next;
  }
```

（import { format } from "date-fns"，automation-runner 先例。）

- [ ] **Step 4-5: 三绿 → Commit**

```bash
git add electron/infrastructure/script/v8 prisma/schema.prisma electron/Constants.ts electron/generated electron/domains/project/plan-item.entity.ts electron/domains/project/plan-item.repo.ts tests/project
git commit -m "feat(project): 数据库 v8——planItem 加 aiSummary 列（只经工具追加，人路径负向锁定）"
```

---

### Task 2: plan-item 工具组（三工具 + 注册门槛 + 权限）

**Files:**
- Create: `electron/domains/ai/agent/plan-tools.ts`
- Modify: `electron/domains/ai/agent/file-tools.ts:10-15`（ToolContext 加 `projectId?: number | null`）
- Modify: `electron/domains/ai/chat/chat.service.ts`（agent 组装带 projectId；collectToolDefinitions 非 null 分支含 plan_* 工具；装配处静态注册）
- Test: `tests/ai/plan-tools.test.ts`（新建，零 mock 工具级——read-skill.test.ts 先例）、`tests/ai/permissions-integration.test.ts`（追加工具暴露断言）

**Interfaces:**
- Consumes: T1 的 `appendAiSummary`；既有 `prisma.planItem`/`prisma.session`；`registerTools`（tool-registry）。
- Produces（T3/T4 无依赖，运行时契约）:
  - `makePlanTools(): ToolDefinition[]`——三工具定义（deps 零参：prisma/PlanItemRepository 通道逻辑内联或直接 prisma 调用；工厂无参最简，测试直调 execute）。
  - 工具名 `plan_create_item` / `plan_update_status` / `plan_append_summary`；description 中文含闭环教学（「推进后应调用 plan_append_summary 记录进展；任务以 #<id> 引用」）。
  - execute 错误统一 `"错误: ..."`；成功返回人类可读中文摘要字符串。

- [ ] **Step 1: 写失败的工具级测试**（tests/ai/plan-tools.test.ts，read-skill.test.ts 骨架：vi.mock prisma-client 一次——工具内联 prisma 调用；或 deps 注入版工厂 `makePlanTools({ prisma })` 测试传 stub——**采用 deps 注入**：`makePlanTools(deps: { prisma: Pick<PrismaClient, "planItem"|"session"|"project"> })`，生产装配传真 prisma，测试传 stub，零 vi.mock）

```ts
// 用例清单（ctx = { workspacePath: "", sessionId: 1, projectId: 11 }）：
// 1. projectId 缺失 → "错误: 当前会话未关联项目"（三工具各断言一次，任一即可）
// 2. plan_create_item：prisma.planItem.create 收到 source:"ai"/projectId:11/assignee 查 session 归属 →
//    （assignee：查 session.findUnique({select:{createdById? 现有字段}})——简化裁决：assigneeId 留 null=未指派，
//     AI 建的任务默认未指派，人可后续指派；工具结果含新 id）
// 3. plan_update_status：校验 findUnique 属本项目（row.projectId===11）→ prisma.planItem.update；
//    跨项目/不存在 → "错误: 任务不存在或不属于当前项目"
// 4. plan_append_summary：走 deps.planRepo.appendAiSummary（或 prisma 内联）→ 追加两行断言；
//    不存在 → "错误: 任务不存在或不属于当前项目"
// 5. zod schema：title 空串拒绝（execute 层校验 return "错误: 标题不能为空"）
```

- [ ] **Step 2: 运行确认失败 → Step 3: 实现 plan-tools.ts**

```ts
// electron/domains/ai/agent/plan-tools.ts 结构（read-skill.ts 风格，文件头注释「纯 Node、可被 vitest 直接测试」）：
export function makePlanTools(deps: PlanToolsDeps): ToolDefinition[] {
  return [
    {
      name: "plan_create_item",
      description: "在当前项目的计划清单中创建任务（AI 驱动）。推进任务后应调用 plan_append_summary 记录进展；任务以 #<id> 引用。",
      parameters: z.object({ title: z.string().describe("任务标题"), priority: z.enum(PLAN_PRIORITIES).optional(), dueDate: z.string().describe("yyyy-MM-dd").optional(), tags: z.array(z.string()).optional() }),
      kind: "write",
      async execute(ctx, args) { /* ctx.projectId 校验→prisma.planItem.create({source:"ai",...})→`已创建任务 #${id}《${title}》` */ },
    },
    plan_update_status: { parameters: z.object({ id: z.number(), status: z.enum(PLAN_STATUSES) }) /* findUnique 属地校验→update→"已流转为：进行中" */ },
    plan_append_summary: { parameters: z.object({ id: z.number(), text: z.string().describe("一行进展描述") }) /* 属地校验→appendAiSummary→返回追加后摘要末行 */ },
  ];
}
```

（duedate yyyy-MM-dd → dateKeyToIso 语义 `${v}T00:00:00.000Z`；tags JSON 列。PLAN_STATUSES/PLAN_PRIORITIES import 自 project 域 entity——跨域类型 import 在 electron 侧已有先例。）

- [ ] **Step 4: 接线 chat.service**

1. `file-tools.ts` ToolContext 加 `projectId?: number | null`（一行）。
2. chat.service：agent/stream options 构造处（resolveAgentOptions 内构造的对象）加 `projectId: session.projectId`——核对 L1160-1189 现有字段注入点照抄。
3. 装配注册：chat.service.ts 顶部（或 Application.ts 装配处，就近 skill.repo 先例选 chat.service 模块级）`registerTools(makePlanTools({ prisma }))`（模块加载一次注册）。
4. `collectToolDefinitions`（L1199-1217）：项目会话（`allowedMcpServers !== null`）保留 `plan_` 前缀工具；非项目会话剔除（一行 filter，注释「项目专属工具，全局会话无计划上下文」）。
5. permissions-integration.test.ts 追加：「项目会话 tools 含 plan_create_item；全局会话（projectId null）tools 数组无 plan_ 前缀」（该测试经 MockModel 捕获 doStream 的 tools，照既有断言模式）。

- [ ] **Step 5: 三绿 → Commit**

```bash
git add electron/domains/ai/agent/plan-tools.ts electron/domains/ai/agent/file-tools.ts electron/domains/ai/chat/chat.service.ts tests/ai/plan-tools.test.ts tests/ai/permissions-integration.test.ts
git commit -m "feat(project): plan-item agent 工具组——建/流转/追加进展（write 权限门禁，仅项目会话暴露）"
```

---

### Task 3: #待办引用增强 + 预填 store

**Files:**
- Create: `src-react/domains/project/store/plan-advance.store.ts`
- Modify: `src-react/domains/ai/chat/components/ChatInput.tsx`（todo PendingFile [进展] 块；预填消费）
- Modify: `src-react/domains/ai/chat/lib/pending-file.ts`（无改动——kind 不变，仅 content 拼接，确认后不动）
- Test: `tests/ai/chat-input-todo.test.tsx`（追加）、`tests/project/plan-advance-store.test.ts`（新建）

**Interfaces:**
- Consumes: T1 `PlanItemRecord.aiSummary`（ChatInput todoItems 类型需加该字段——todoItems prop 类型扩 `aiSummary?: string`）；create-skill.store 形状先例。
- Produces（T4 依赖）:
  - `usePlanAdvanceStore`（zustand）：`{ prompt: string | null; setPrompt(p: string): void; consume(): string | null }`（读后即清）。
  - ChatInput：`const planPrompt = usePlanAdvanceStore((s) => s.prompt)` + `useEffect(() => { if (planPrompt) { const p = usePlanAdvanceStore.getState().consume(); if (p) { setContent(p); textareaRef.current?.focus(); } } }, [planPrompt])`（运行期消费——底栏常驻仅挂载一次，订阅值变化触发）。
  - `#待办` PendingFile content：现有摘要行后，`item.aiSummary` 非空时追加 `\n[进展]\n${item.aiSummary.split("\n").slice(-10).join("\n")}`。

- [ ] **Step 1: 写失败的测试**

plan-advance-store.test.ts（纯 zustand 测试，零 jsdom）：

```ts
it("setPrompt → consume 读后即清", () => {
  usePlanAdvanceStore.getState().setPrompt("请推进 #3");
  expect(usePlanAdvanceStore.getState().prompt).toBe("请推进 #3");
  expect(usePlanAdvanceStore.getState().consume()).toBe("请推进 #3");
  expect(usePlanAdvanceStore.getState().prompt).toBeNull();
  expect(usePlanAdvanceStore.getState().consume()).toBeNull();
});
```

chat-input-todo.test.tsx 追加：

```ts
it("待办带 aiSummary → onSend 的 PendingFile content 含 [进展] 块（末 10 行）", /* fixture item.aiSummary 12 行 → content 含 [进展] 且首 2 行不在、末 10 行在 */);
it("无 aiSummary → content 与原格式一致（无 [进展]）", /* 既有用例改断言或新加 */);
it("store setPrompt 后 → textarea 值 = prompt 且获焦（消费一次即清）", /* act 内 setPrompt → 断言 textarea.value + document.activeElement；再 setPrompt(null 检查) */);
```

- [ ] **Step 2-3: 实现**（store 34 行内——create-skill.store 翻版；ChatInput 两处拼接/消费 effect；todoItems 类型 + aiSummary）

- [ ] **Step 4-5: 三绿 → Commit**

```bash
git add src-react/domains/project/store/plan-advance.store.ts src-react/domains/ai/chat/components/ChatInput.tsx tests/ai/chat-input-todo.test.tsx tests/project/plan-advance-store.test.ts
git commit -m "feat(project): #待办引用携带 AI 进展（末10行）+ plan-advance 预填 store（读后即清，底栏运行期消费聚焦）"
```

---

### Task 4: 双入口与呈现（列表按钮/表格菜单/AI Badge/进展徽标/弹窗折叠区）+ 收尾

**Files:**
- Modify: `src-react/domains/project/components/PlanListView.tsx`（行 hover Sparkles 推进按钮 + aiSummary 徽标 + AI Badge + onAiAdvance 回调）
- Modify: `src-react/domains/project/components/PlanTableView.tsx`（行尾菜单「AI 推进」项 + AI Badge）
- Modify: `src-react/domains/project/components/PlanItemDialog.tsx`（只读「AI 进展」折叠区——ThinkingPanel L55-101 折叠模板）
- Modify: `src-react/domains/project/components/PlanPane.tsx`（onAiAdvance 接 store）
- Modify: `src-react/i18n/locales/*/project.json`
- Test: `tests/project/plan-list.test.tsx`、`tests/project/plan-table.test.tsx`、`tests/project/plan-item-dialog.test.tsx`（各追加）

**Interfaces:**
- Consumes: T3 `usePlanAdvanceStore.setPrompt`；T1 `PlanItemRecord.aiSummary`（fixture 需补字段——**连带**：project 域各测试 makeItem 工厂加 `aiSummary: ""`，破坏的既有断言按最小等价修复）。
- Produces: 入口终态 + 呈现终态；全量回归绿。

- [ ] **Step 1: 追加失败的测试**（用例清单）

plan-list.test.tsx：
1. 「行 hover 出 AI 推进按钮（group-hover opacity），点击 → setPrompt 含 `#<id>《标题》` 与预填模板文案」（mock store 或真 store+断言 state）
2. 「aiSummary 非空 → Sparkles 徽标常驻且 title=最后一行；空 → 无徽标」
3. 「source==="ai" → 行内 AI Badge；manual → 无」

plan-table.test.tsx：
4. 「行尾菜单三项（编辑/AI 推进/删除），点 AI 推进 → setPrompt 同款」
5. 「source ai Badge 在标题旁」

plan-item-dialog.test.tsx：
6. 「item.aiSummary 非空 → 『AI 进展』折叠区渲染（默认收起，点开显 pre-wrap 文本）；空 → 不渲染」

- [ ] **Step 2-3: 实现**

1. PlanListView ListRow：行尾头像 span 前插 `{item.aiSummary && <span title={末行} className="text-primary"><Sparkles className="h-3 w-3" /></span>}`；标题前 `{item.source === "ai" && <Badge variant="secondary" className="px-1 text-[9px]">AI</Badge>}`；行尾（头像后）`<button className="opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100" aria-label={t("project:plan.aiAdvance")} onClick={() => onAiAdvance(item)}><Sparkles className="h-3.5 w-3.5" /></button>`（AssetFileTable hover 先例）；props 加 `onAiAdvance: (item: PlanItemRecord) => void`。
2. PlanTableView 菜单：编辑项后插 `<DropdownMenuItem onClick={() => onAiAdvance(item)}>…{t("project:plan.aiAdvance")}</DropdownMenuItem>`（props 加回调）；AI Badge 同款标题旁。
3. PlanItemDialog：胶囊行后（L463/465 之间）插折叠区——`const [summaryOpen, setSummaryOpen] = useState(false)` + item?.aiSummary 非空时渲染：头行（Sparkles + `t("project:plan.aiSummary")` + Chevron 按钮 aria-expanded）+ `{summaryOpen && <p className="whitespace-pre-wrap rounded-md border border-border/50 p-2 text-xs text-muted-foreground">{item.aiSummary}</p>}`（编辑态只读——aiSummary 恒显示 item 原值）。
4. PlanPane：`const setAdvancePrompt = usePlanAdvanceStore((s) => s.setPrompt)`；两视图回调统一 `(item) => setAdvancePrompt(t("project:plan.advancePrompt", { id: item.id, title: item.title }))`（插值 key：`请推进 #{{id}}《{{title}}》：结合项目上下文与此任务的进展记录，推进下一步工作，并更新任务状态与进展。`）。
5. i18n（双语言）：`plan.aiAdvance` AI 推进/AI advance、`plan.aiSummary` AI 进展/AI progress、`plan.advancePrompt` 如上、`plan.aiBadge`（可省——Badge 字面 "AI" 硬编码非文案属标识）——**用 "AI" 字面**（Badge 内容非句子，与 P0/P1 同类，i18n 规范豁免先例）。

- [ ] **Step 4: 全量回归三绿（收尾任务）**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: 全绿（含 makeItem 工厂连带修复后的全部 project 测试）

- [ ] **Step 5: Commit**

```bash
git add src-react/domains/project/components src-react/i18n/locales tests/project
git commit -m "feat(project): AI 推进双入口与呈现——列表/表格入口+预填模板、AI Badge、进展徽标、弹窗只读折叠区"
```

---

## 手动验收清单（spec §4）

1. 项目底栏：「帮我把 #3 推进」→ AI 调 plan_update_status + plan_append_summary（默认权限弹确认）→ 列表/看板状态实时变 + Sparkles 徽标出现。
2. 「为下周一发布会建 5 个准备任务」→ 批量建（AI Badge）→ 五视图可见。
3. 列表行 hover 点 AI 推进 → 底栏预填聚焦 → 发送 → AI 续接进展（#3 引用携带 [进展] 块）。
4. 弹窗「AI 进展」折叠区展开内容完整；表格行尾菜单三入口。
5. AI 模块全局会话：工具列表无 plan_*（permissions-integration 断言 + 手动确认）；全套权限胶囊/记住流程照常。

## 自审记录（Self-Review）

1. **Spec coverage**：§1 工具组（T2 全部：三工具/门槛/权限/错误语义/闭环教学）；§2 数据层+引用（T1 列+负向 / T3 [进展] 块 10 行）；§3 双入口+呈现（T3 store / T4 按钮+菜单+徽标+Badge+折叠区+预填模板）；§4 测试（各任务）+验收清单。spec「双 key 失效」按 Global Constraints 裁决简化为仅主 key（已记理由）。
2. **占位符**：T2 工具实现给了结构骨架+行为规格（read-skill.ts 42 行模板先例、deps 注入使测试零 mock）；其余含完整代码/断言。
3. **类型一致性**：ToolContext.projectId（T2 定义/消费一致）；aiSummary（T1 entity → T3 todoItems 类型扩 → T4 fixture/呈现）；makePlanTools(deps) 签名 T2 内自洽；onAiAdvance(item) T4 内两视图+PlanPane 一致；advancePrompt 插值 {{id}}/{{title}} T4 Step3.4/3.5 对齐。

