# 专家团多角色协作（第二期）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 专家团真正的运行时协作——绑定专家团的会话中主理人（主循环模型）经 `dispatch_member` 工具调度成员子 agent（独立 systemPrompt 非流式 LLM 调用），串行分阶段协作，成员产出回传汇编。

**Architecture:** 数据层 assistant +2 列（expertType/members，成员不含主理人）→ 运行时 buildTeamLeadSystem 组装主理人 system（人设+成员清单+铁律）+ collectToolDefinitions 每请求闭包构造 dispatch_member（成员清单/modelText/abortSignal 闭包携带）→ 工具层 create/update_expert 扩展 team → 前端表单/市场/详情。

**Tech Stack:** 同第一期（Electron TS + Prisma + React 19 + zod + AI SDK generateText + Vitest）。

**Spec:** `docs/superpowers/specs/2026-10-11-expert-team-design.md`（执行者须同时读）

## Global Constraints

（同第一期，重申关键项）
- 完成口径：每任务 `npx vitest run <file>` 相关文件全绿；最终 `npm run test` + `typecheck` + `lint`（触碰文件 0 新增）全绿。
- 用户可见文本走 `t()`（zh/en 同步）；专家条目内容数据直接中文不走 i18n。
- 主题变量禁硬编码色；弹窗 `border-border/50 rounded-lg shadow-lg`；Prettier 双引号/分号/2 空格/无尾随逗号。
- 主进程 agent 工具文件禁 `import electron`（纯 Node 可测）。
- 只 `git add` 本任务实际改动文件，禁 `git add -A`。
- 全仓存量 lint 错误在未触碰文件（monitor/paste 域等），不修不碰。

---

### Task 1: 数据模型 +2 列与 TeamMember 类型源

**Files:**
- Modify: `prisma/schema.prisma`（assistant 模型 +2 列）、`electron/infrastructure/script/v1/upgrade-table.sql`
- 再生: `npx prisma generate`
- Create: `electron/domains/ai/chat/expert-team.ts`（本任务仅类型 + 解析辅助；T2 加 buildTeamLeadSystem）
- Modify: `src-react/domains/ai/api/assistant.api.ts`、`electron/domains/ai/chat/assistant.repo.ts`
- Test: `tests/ai/assistant-repo.test.ts`（扩展）、Create `tests/ai/expert-team.test.ts`（本任务仅解析辅助用例）

**Interfaces:**
- Produces: `TeamMember { id: string; name: string; profession: string; systemPrompt: string }`（expert-team.ts 导出，全链路唯一类型源）；`parseTeamMembers(raw: string | null): TeamMember[]`（坏 JSON/非数组回退 []；元素缺必填字段剔除）；`AssistantRecord/CreateParams + expertType?: "agent"|"team"; members?: TeamMember[]`；`UpdateParams` 同形（members `TeamMember[] | null`）；repo create/update 透传（expertType undefined→不出现，members 序列化 JSON）。

- [ ] **Step 1: 写失败测试**

`tests/ai/expert-team.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { parseTeamMembers, type TeamMember } from "../../electron/domains/ai/chat/expert-team";

const member: TeamMember = {
  id: "macro-analyst", name: "顾大局", profession: "宏观分析师",
  systemPrompt: "你是宏观分析师…",
};

describe("parseTeamMembers", () => {
  it("合法 JSON 解析；坏 JSON/非数组/缺字段成员回退剔除", () => {
    expect(parseTeamMembers(JSON.stringify([member]))).toEqual([member]);
    expect(parseTeamMembers("{bad")).toEqual([]);
    expect(parseTeamMembers('["x"]')).toEqual([]);
    expect(
      parseTeamMembers(JSON.stringify([{ ...member, systemPrompt: undefined }])),
    ).toEqual([]);
  });
  it("null/空串返回空数组", () => {
    expect(parseTeamMembers(null)).toEqual([]);
    expect(parseTeamMembers("")).toEqual([]);
  });
});
```

`tests/ai/assistant-repo.test.ts` 追加：

```ts
it("create/update 透传 expertType 与 members 序列化", async () => {
  await repo.create(
    {
      name: "交易团", systemPrompt: "主理人…", expertType: "team",
      members: [{ id: "m1", name: "甲", profession: "分析师", systemPrompt: "P" }],
    } as never,
    1,
  );
  const data = (prisma.assistant.create as Mock).mock.calls[0][0].data;
  expect(data.expertType).toBe("team");
  expect(data.members).toContain('"macro-analyst"') /* 或断言 JSON.parse 回环 */;
});
```

（以文件现有 mock 行 helper 实际形态为准；断言 JSON.parse(data.members) 深等价亦可。）

- [ ] **Step 2: 跑测试确认失败** → `npx vitest run tests/ai/expert-team.test.ts tests/ai/assistant-repo.test.ts` FAIL
- [ ] **Step 3: 实现**——schema +2 列（`expertType String?` / `members String?`，v1 SQL 同步裸名 TEXT NULL 风格）；expert-team.ts 建类型与 parseTeamMembers（内部可复用 `expert-catalog.ts parseJsonStringArray` 思路但需对象校验，独立实现更清晰，注释注明关系）；api 三 interface +2 字段；repo toRecord（expertType 归一 `"team"` 才透传 team，其余 undefined；members 用 parseTeamMembers）/create/update（三态同既有列）。
- [ ] **Step 4: 跑测试通过 + typecheck**
- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma electron/infrastructure/script/v1/upgrade-table.sql electron/generated/prisma electron/domains/ai/chat/expert-team.ts electron/domains/ai/chat/assistant.repo.ts src-react/domains/ai/api/assistant.api.ts tests/ai/expert-team.test.ts tests/ai/assistant-repo.test.ts
git commit -m "feat(expert-team): assistant 表 +2 列（expertType/members）与 TeamMember 类型源"
```

---

### Task 2: buildTeamLeadSystem 与 assembleContext team 组装

**Files:**
- Modify: `electron/domains/ai/chat/expert-team.ts`（+buildTeamLeadSystem）
- Modify: `electron/domains/ai/chat/chat.service.ts`（assembleContext：team 分支 base 组装 + 禁用门控）
- Test: `tests/ai/expert-team.test.ts`（扩展）、`tests/ai/chat.service.test.ts`（扩展）

**Interfaces:**
- Consumes: T1 TeamMember/parseTeamMembers。
- Produces: `buildTeamLeadSystem(params: { leadPrompt: string; members: TeamMember[] }): string`——段落顺序：主理人 prompt 原文 →【团队成员】清单（每行 `- id｜花名（职业头衔）`+调度传 id 说明）→【协作铁律】（4 条：严禁代写成员产出/分阶段串行且上一阶段产出原文传入下一阶段 context/成员只对主理人回传/输出用用户语言）→【工具说明】dispatch_member 参数一句话语义。空 members 返回 null（调用方回退裸 prompt）。`TEAM_LEAD_RULES_HINT` 等常量不导出（纯函数内聚）。
- chat.service：`assistantRow.expertType === "team" && members.length > 0` 时 base 换 buildTeamLeadSystem；**禁用门控**：dispatch_member 被禁用（runtimeFilter）时铁律段与工具说明不组装（system 与工具集同缺席，对齐第一期目录段门控模式）——即 buildTeamLeadSystem 增可选参数 `withDispatch?: boolean`（默认 true），门控处传 false 且工具集不构造。

- [ ] **Step 1: 写失败测试**

expert-team.test.ts 追加：

```ts
import { buildTeamLeadSystem } from "../../electron/domains/ai/chat/expert-team";

describe("buildTeamLeadSystem", () => {
  const members: TeamMember[] = [
    { id: "macro-analyst", name: "顾大局", profession: "宏观分析师", systemPrompt: "A" },
    { id: "risk-officer", name: "严守仓", profession: "风控官", systemPrompt: "B" },
  ];
  it("四段齐备：主理人原文/成员清单/铁律/工具说明", () => {
    const text = buildTeamLeadSystem({ leadPrompt: "你是交易团主理人。", members });
    expect(text).toContain("你是交易团主理人。");
    expect(text).toContain("macro-analyst｜顾大局（宏观分析师）");
    expect(text).toContain("risk-officer｜严守仓（风控官）");
    expect(text).toContain("严禁");        // 代写红线
    expect(text).toContain("context");     // 阶段传递
    expect(text).toContain("dispatch_member");
  });
  it("空成员返回 null；withDispatch=false 时无铁律与工具说明", () => {
    expect(buildTeamLeadSystem({ leadPrompt: "x", members: [] })).toBeNull();
    const noDispatch = buildTeamLeadSystem({ leadPrompt: "x", members, withDispatch: false });
    expect(noDispatch).not.toContain("dispatch_member");
    expect(noDispatch).toContain("macro-analyst"); // 成员清单仍在（展示语义）
  });
});
```

chat.service.test.ts 追加（沿用现有 assembleContext 集成用例的 makeSvc/stub 模式）：
- team 会话：system 含成员清单行与「严禁」；非 team（expertType null/"agent"）system 为裸 prompt。
- `runtimeFilter: () => ["dispatch_member"]` 的 team 会话：system 无铁律段（对照禁用 run_command 时铁律段仍在）。

- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**——buildTeamLeadSystem 按 Interfaces 段落结构（模板字符串拼接，注意空 leadPrompt 不产生开头空行）；assembleContext 在既有 base 计算处（`buildProjectSystemBase`/裸 prompt 分支后）插入 team 分支；禁用判断用与 withCatalog 门控同一 runtimeFilter 读法。
- [ ] **Step 4: 跑通过 + typecheck + 既有回归**（chat.service.test.ts 全量）
- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/chat/expert-team.ts electron/domains/ai/chat/chat.service.ts tests/ai/expert-team.test.ts tests/ai/chat.service.test.ts
git commit -m "feat(expert-team): 主理人 system 组装（成员清单+协作铁律）与禁用门控"
```

---

### Task 3: dispatch_member 工具与条件注入

**Files:**
- Create: `electron/domains/ai/agent/dispatch-member-tool.ts`
- Modify: `electron/domains/ai/chat/chat.service.ts`（collectToolDefinitions +team 参数，两处调用点；modelText 装配参照 handover-summary.ts defaultModelText）
- Modify: `electron/domains/security/defaults.ts` + `src-react/i18n/locales/{zh-CN,en-US}/security.json`
- Test: Create `tests/ai/dispatch-member-tool.test.ts`；`tests/ai/chat.service.test.ts`（工具集条件用例）；扩展 `tests/ai/{disabled-tools,security-components,security-service}` 计数 16→17（以实际断言形态为准）

**Interfaces:**
- Consumes: T1 TeamMember；`ToolDefinition`（file-tools）；AI SDK `generateText` + `createLanguageModel`（handover-summary.ts:172-186 先例：model+system+prompt+`AbortSignal.timeout`）。
- Produces: `DISPATCH_MEMBER_TOOL_NAME = "dispatch_member"`；`DispatchMemberDeps { members; modelText: (args: { system; prompt; abortSignal?: AbortSignal }) => Promise<string> }`；`makeDispatchMemberTool(deps)`——kind "read"；zod `{ member: string(≤64), task: string(1..2000), context?: string(≤8000) }`；execute：定位（miss 返回 `错误: 团队中不存在成员「${member}」`，id 列出可用成员）→ modelText（system=成员 systemPrompt；prompt=`【任务】\n${task}` + context 段）→ 返回产出原文；异常 catch `错误: 成员「${name}」执行失败（${message}）`。abortSignal 经 deps 闭包传入（工具每请求构造，构造点持有当次 abort.signal）。

- [ ] **Step 1: 写失败测试** `tests/ai/dispatch-member-tool.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { makeDispatchMemberTool } from "../../electron/domains/ai/agent/dispatch-member-tool";

const members = [
  { id: "macro-analyst", name: "顾大局", profession: "宏观分析师", systemPrompt: "MACRO_SYS" },
  { id: "risk-officer", name: "严守仓", profession: "风控官", systemPrompt: "RISK_SYS" },
];

function makeDeps() {
  const modelText = vi.fn().mockResolvedValue("成员产出");
  const abortSignal = new AbortController().signal;
  return { modelText, abortSignal };
}

it("调度成员：modelText 收到成员 systemPrompt 与任务上下文，返回产出", async () => {
  const { modelText, abortSignal } = makeDeps();
  const tool = makeDispatchMemberTool({ members, modelText, abortSignal });
  const out = await tool.execute({} as never, {
    member: "risk-officer", task: "评估仓位风险", context: "前情结论",
  } as never);
  expect(out).toBe("成员产出");
  expect(modelText).toHaveBeenCalledWith({
    system: "RISK_SYS",
    prompt: expect.stringContaining("评估仓位风险"),
    abortSignal,
  });
  expect(modelText.mock.calls[0][0].prompt).toContain("前情结论");
});

it("成员不存在返回错误文案（含可用 id）", async () => {
  const { modelText, abortSignal } = makeDeps();
  const tool = makeDispatchMemberTool({ members, modelText, abortSignal });
  const out = await tool.execute({} as never, { member: "nope", task: "x" } as never);
  expect(out).toContain("错误");
  expect(out).toContain("macro-analyst");
  expect(modelText).not.toHaveBeenCalled();
});

it("modelText 异常 catch 为错误文案不抛出", async () => {
  const { modelText, abortSignal } = makeDeps();
  modelText.mockRejectedValue(new Error("超时"));
  const tool = makeDispatchMemberTool({ members, modelText, abortSignal });
  const out = await tool.execute({} as never, {
    member: "macro-analyst", task: "x",
  } as never);
  expect(out).toContain("顾大局").toContain("超时");
});

it("kind read（免审批）", () => {
  const { modelText, abortSignal } = makeDeps();
  expect(makeDispatchMemberTool({ members, modelText, abortSignal }).kind).toBe("read");
});
```

chat.service.test.ts 追加：team 会话工具集含 dispatch_member（名字命中）且非 team 会话不含；禁用时缺席（复用 T2 的 runtimeFilter 用例数据链）。

- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**
  - dispatch-member-tool.ts（纯 Node；`import { z } from "zod"` + type-only import；abortSignal 放进 DispatchMemberDeps）。
  - chat.service：`collectToolDefinitions` 增第 4 参 `team?: { members: TeamMember[]; abortSignal?: AbortSignal } | null`（T2 已有 assistantRow 在 ctx，从 assembleContext 返回值取 members）；当 team 且成员非空且 dispatch_member 未被 runtimeFilter 禁用时，在 `makeReadSkillTool(skills)` 旁并列构造 `makeDispatchMemberTool({ members, abortSignal, modelText })`；modelText 装配：新私有方法 `memberModelText(modelRow, providerRow)` 照 handover defaultModelText（`generateText({ model: createLanguageModel(...), system, prompt, abortSignal: AbortSignal.timeout(120_000) })`，注释注明成员单轮重于摘要故 120s）——两个调用点（streamAndPersist 与 getUsageBreakdown 处，后者 abortSignal 可 undefined）都接。
  - defaults.ts + security.json 登记（`tools.dispatch_member` zh「调度团队成员独立分析并回传结论」/ en「Dispatch a team member for independent analysis」）；三处计数断言 16→17 + fixture/aria 数组同步（第一期 G1 修复的完整清单模式）。
- [ ] **Step 4: 跑通过 + typecheck + lint**
- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/agent/dispatch-member-tool.ts electron/domains/ai/chat/chat.service.ts electron/domains/security/defaults.ts src-react/i18n/locales/zh-CN/security.json src-react/i18n/locales/en-US/security.json tests/ai/dispatch-member-tool.test.ts tests/ai/chat.service.test.ts tests/ai/disabled-tools.test.ts tests/security/security-components.test.tsx tests/security/security-service.test.ts
git commit -m "feat(expert-team): dispatch_member 工具（成员子 agent 非流式调度）与 team 会话条件注入"
```

---

### Task 4: create/update_expert 专家团扩展 + 导入导出

**Files:**
- Modify: `electron/domains/ai/agent/create-expert.ts`
- Modify: `electron/domains/ai/chat/assistant.repo.ts`（expertExportSchema +2 字段）
- Test: `tests/ai/create-expert.test.ts`（扩展）、`tests/ai/expert-io.test.ts`（扩展）

**Interfaces:**
- Consumes: T1 TeamMember。
- Produces: create schema + `expertType`（optional，enum ["agent","team"]，默认 agent）+ `members`（optional；team 时必填 1-6，agent 时传即报错）；成员校验：id `^[a-z0-9][a-z0-9-]*$` 团内唯一、name/profession ≤30、systemPrompt 1..8000。update 同形全可选（members 传即整体覆盖）。落库 expertType（agent 归一 undefined=不写列）。description 补团队用法（成员 prompt 五段式+花名谐音风格建议、主理人 prompt 写 SOP 编排）。导出 JSON + expertType/members；导入 zod 同校验。

- [ ] **Step 1: 写失败测试**（create-expert.test.ts 追加，模式同既有用例）

```ts
it("team 创建：members 校验链（非法 id/重复 id/超 6/agent 带 members 报错）", async () => {
  const tool = makeCreateExpertTool(depsWith(["code-review"]));
  const base = { name: "交易团", systemPrompt: "主理人…" } as never;
  // 合法 team
  expect((await tool.execute(ctx(), {
    ...base, expertType: "team",
    members: [{ id: "risk-officer", name: "严守仓", profession: "风控官", systemPrompt: "P" }],
  } as never)).not.toContain("错误");
  // 非法 id
  expect((await tool.execute(ctx(), {
    ...base, expertType: "team",
    members: [{ id: "Bad_Id", name: "x", profession: "y", systemPrompt: "P" }],
  } as never))).toContain("kebab-case");
  // 重复 id
  expect((await tool.execute(ctx(), {
    ...base, expertType: "team",
    members: [
      { id: "a", name: "x", profession: "y", systemPrompt: "P" },
      { id: "a", name: "z", profession: "w", systemPrompt: "Q" },
    ],
  } as never))).toContain("重复");
  // team 缺 members
  expect((await tool.execute(ctx(), { ...base, expertType: "team" } as never))).toContain("错误");
  // agent 带 members
  expect((await tool.execute(ctx(), {
    ...base, members: [{ id: "a", name: "x", profession: "y", systemPrompt: "P" }],
  } as never))).toContain("错误");
});
```

（depsWith 为文件内已有 listInstalledSkillNames 构造 helper 的适配；超 6 用例同理 `expect(out).toContain("6")`。）expert-io.test.ts 追加：serializeExpert 含 expertType/members；parse 拒重复 id members。

- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**——zod `memberSchema` 与 create/update schema 扩展；校验链纯函数 `validateTeamMembers(members): string | null`（返回错误原因或 null）；执行层落库（members JSON.stringify）。导入导出 schema +2 字段（members 复用同一校验常量）。
- [ ] **Step 4: 跑通过 + typecheck**
- [ ] **Step 5: Commit**

```bash
git add electron/domains/ai/agent/create-expert.ts electron/domains/ai/chat/assistant.repo.ts tests/ai/create-expert.test.ts tests/ai/expert-io.test.ts
git commit -m "feat(expert-team): create/update_expert 支持专家团（members 校验链与落库）"
```

---

### Task 5: AssistantDialog 类型切换与成员编辑

**Files:**
- Modify: `src-react/domains/ai/assistant/components/AssistantDialog.tsx`
- Modify: `src-react/i18n/locales/{zh-CN,en-US}/ai.json`
- Test: `tests/ai/assistant-dialog.test.tsx`（扩展）

**Interfaces:**
- Consumes: T1 TeamMember/AssistantUpdateParams 新字段。
- Produces: 表单类型切换（单专家/专家团二选一 pill，默认单专家）；团队态「团队成员」动态行（每行 花名/职业头衔/成员 id/人设 Textarea rows=3 + 删除；「+ 添加成员」≤6 行）；提交：team 态 `expertType:"team"` + members 数组（id 为空自动从花名转拼音？**不做**——id 必填校验，空 id 阻止提交并 toast 提示）；agent 态 members 提交 null（类型切回时清空）。编辑回填 expertType/members。i18n：typeAgent/typeTeam/membersTitle/addMember/memberName/memberId/memberIdHint/memberPrompt/needMemberId zh/en。

- [ ] **Step 1: 写失败测试**（assistant-dialog.test.tsx 追加）

```tsx
it("类型切换显隐成员区；成员增删与提交载荷", async () => {
  render(<AssistantDialog open onOpenChange={() => {}} />);
  // 默认单专家：无成员区
  expect(screen.queryByText("团队成员")).toBeNull();
  // 切专家团
  fireEvent.click(screen.getByText("专家团"));
  expect(await screen.findByText("团队成员")).toBeTruthy();
  fireEvent.click(screen.getByText("+ 添加成员"));
  // 填两行字段（按 aria-label/i18n key 定位输入框）
  fireEvent.change(screen.getByLabelText("花名"), { target: { value: "严守仓" } });
  fireEvent.change(screen.getByLabelText("成员 id"), { target: { value: "risk-officer" } });
  fireEvent.change(screen.getByLabelText("职业头衔"), { target: { value: "风控官" } });
  fireEvent.change(screen.getByLabelText("人设"), { target: { value: "你是风控官。" } });
  fireEvent.click(screen.getByText("common:confirm")); // 或实际按钮文案 key
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("assistant:create",
      expect.objectContaining({
        expertType: "team",
        members: [{ id: "risk-officer", name: "严守仓", profession: "风控官", systemPrompt: "你是风控官。" }],
      })),
  );
});

it("空成员 id 阻止提交并提示", async () => {
  /* 切团队 + 添加成员只填花名 → 提交 → toast.error 被调、invoke 未被 create 调 */
});
```

（i18n mock 返回 key，按文件内既有模式定位；具体 label 文案以实现时的 key 为准保持断言一致。）

- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**——`memberRows: TeamMember[]` state（编辑回填，新行空对象占位）；类型切换 pill 用项目既有 SegmentedControl/Tabs 风格组件（查 components/ui 现有，无则两个 Button 组）；团队成员区渲染与提交校验；Dialog 高度 `max-h-[80vh] overflow-y-auto` 防溢出。
- [ ] **Step 4: 跑通过 + typecheck**
- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/assistant/components/AssistantDialog.tsx src-react/i18n/locales/zh-CN/ai.json src-react/i18n/locales/en-US/ai.json tests/ai/assistant-dialog.test.tsx
git commit -m "feat(expert-team): 专家表单支持专家团类型切换与成员编辑"
```

---

### Task 6: 市场三团 members 补全与展示/载荷

**Files:**
- Modify: `src-react/domains/ai/experts/data/marketplace.ts`（ExpertMarketItem + `members?: TeamMember[]`；三团各 3 员）
- Modify: `src-react/domains/ai/experts/views/ExpertMarketView.tsx`、`src-react/domains/ai/chat/components/ExpertRecommendCard.tsx`（create 载荷 + expertType/members）
- Modify: `src-react/domains/ai/experts/components/ExpertDetailDialog.tsx`（成员列表 + 主理人 Badge）
- Modify: `src-react/i18n/locales/{zh-CN,en-US}/chat.json`
- Test: `tests/ai/marketplace-data.test.ts`（扩展）、`tests/ai/expert-market-fields.test.tsx`（扩展）

**Interfaces:**
- Consumes: T1 TeamMember。
- Produces: team 条目 members 必填（1-6 员，id kebab-case 唯一）；成员 systemPrompt 五段式 80-200 字/员（spec §6 花名清单）；详情弹窗「团队成员」区（花名+职业头衔，主理人=专家名旁「主理人」Badge）；两处添加载荷 + `expertType: "team"`/`members`；i18n teamMembers/lead zh/en。

- [ ] **Step 1: 写失败测试**——marketplace-data.test.ts 追加：

```ts
it("team 条目 members 规范（必有、1-6 员、id 唯一 kebab-case、字段非空）", () => {
  for (const item of MARKET_EXPERTS.filter((e) => e.type === "team")) {
    const members = item.members ?? [];
    expect(members.length, item.slug).toBeGreaterThanOrEqual(1);
    expect(members.length, item.slug).toBeLessThanOrEqual(6);
    const ids = members.map((m) => m.id);
    expect(new Set(ids).size, item.slug).toBe(ids.length);
    for (const m of members) {
      expect(m.id, item.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(m.name.length, item.slug).toBeGreaterThan(0);
      expect(m.systemPrompt.length, item.slug).toBeGreaterThanOrEqual(80);
    }
  }
});
```

expert-market-fields.test.tsx 追加：详情弹窗 team 条目渲染成员花名与「主理人」；ExpertMarketView 添加载荷含 expertType/members（mock invoke 断言，沿用现有 handleAdd 用例模式）。

- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**——三团 members 内容创作（花名/头衔按 spec §6，systemPrompt 五段式各 80-200 字）；接口 +members 可选；详情/载荷/i18n。
- [ ] **Step 4: 跑通过 + typecheck**
- [ ] **Step 5: Commit**

```bash
git add src-react/domains/ai/experts/data/marketplace.ts src-react/domains/ai/experts/views/ExpertMarketView.tsx src-react/domains/ai/chat/components/ExpertRecommendCard.tsx src-react/domains/ai/experts/components/ExpertDetailDialog.tsx src-react/i18n/locales/zh-CN/chat.json src-react/i18n/locales/en-US/chat.json tests/ai/marketplace-data.test.ts tests/ai/expert-market-fields.test.tsx
git commit -m "feat(expert-team): 市场三团成员结构与详情/添加载荷补全"
```

---

### Task 7: 收口与全量验证

**Files:**
- 修改/新建按验证结果定（收口项 + 顺手修）

- [ ] **Step 1: 全量验证**：`npm run test`（基线 2781 + 本期新增全绿）、`npm run typecheck`、`npm run lint`（触碰文件 0 新增，存量区分口径同第一期）。
- [ ] **Step 2: 顺手修候选**（若验证暴露）：成员工具卡摘要（ToolCallCard 对 dispatch_member 的 args.member 摘要展示——查通用摘要是取 args.path/command，无命中时显示形态可读即可，不改不强求）；第一期遗留「双扫描」重构若顺手可做（单次 {enabled, all}），不做不强求。
- [ ] **Step 3: 手工冒烟路径写入报告**（不要求真机跑）：绑定市场「交易分析专家团」→ 发 quickPrompt「帮我分析这个品种现在的行情」→ 预期主理人 dispatch macro-analyst → 技术面 → 风控官三段工具卡 + 汇总输出。
- [ ] **Step 4: Commit**（若 Step 2 有改动）

```bash
git commit -m "fix(expert-team): 第二期收口"
```

---

## Self-Review 记录

- **Spec 覆盖**：§1→T1；§2→T2；§3→T3；§4→T4；§5→T5/T6；§6→T6；§7 i18n→各任务内嵌；§9 测试→各任务 TDD；§10 偏差表已由 spec 承载无额外任务。
- **类型一致**：TeamMember 四字段全链路一致；DISPATCH_MEMBER_TOOL_NAME 仅 electron 侧定义（前端无分流需求，工具卡走通用 ToolCallCard，与 WIDGET/RECOMMEND 双份场景不同）；buildTeamLeadSystem 签名与 T2/T3 门控一致。
- **占位符**：T6 成员 systemPrompt 内容按 spec §6 花名清单与五段式规则创作（数据创作类，规则可执行）；T5 测试定位文案标注「以实现 key 为准保持断言一致」为测试基建适配非占位。
- **跨任务文件冲突**：T2/T3 都改 chat.service（T3 在 T2 后串行）；T4/T1 都改 assistant.repo 与 expert-io（串行）；T6 载荷改 ExpertRecommendCard（第一期已稳定）。
