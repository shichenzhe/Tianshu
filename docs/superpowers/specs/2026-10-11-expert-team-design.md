# 专家团多角色协作（专家功能 2.0 第二期）——设计文档

日期：2026-10-11
状态：路线已拍板（spawn 子 agent，WorkBuddy Team 型移植）；范围细化本文
前置：`2026-10-11-expert-2.0-design.md` 第一期已落地（数据模型/工具/运行时/市场全量交付）
参考材料：`/tmp/wb-exp/`（team-spec.md 花名规范与协作铁律、agent-md-spec.md 成员 prompt 六要素、curated-experts.json 专家团条目）

## 背景与目标

WorkBuddy Team 型专家 = 主理人 + 团员多 agent 协作：主理人持 SOP 编排，成员
经 spawn 独立产出、结论回传主理人汇编，**明令禁止主理人代写成员产出**（质量
红线）。天枢第一期的专家团仅 `type:"team"` 数据标记（systemPrompt 单条模拟
多角色），本期为真正的运行时协作：绑定专家团的会话中，主循环模型作为主理人
经 `dispatch_member` 工具调度成员子 agent（独立 systemPrompt 的非流式 LLM
调用），成员产出作工具结果回传汇编。

**已拍板决策**：

- **spawn 子 agent 路线**（用户确认）：execute 内经 AI SDK `generateText`
  非流式调用（chat.service 已有 `generateText` import 与
  `handoverModelText` 注入式 stub 先例）。
- **受控并行调度（2026-10-11 用户确认）**：同阶段无依赖成员同回复并行
  调用，跨阶段串行；编排结构由主理人 systemPrompt 承载（SOP 分阶段），
  成员互发与多轮留后续。
- **members 不含主理人**（与 WorkBuddy 偏差）：`assistant` 行本身就是主理人
  （name/profession/systemPrompt 即主理人身份与编排 prompt），members 仅存
  被调度成员——数据简洁、表单清晰、无冗余同步。WorkBuddy 把主理人放进
  members 是为头像展示，天枢卡片以专家名为主理人 + 成员列表展示，语义等价。

## 1. 数据模型（发布前直改 v1 快照，`assistant` 表 +2 列）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `expertType` | TEXT NULL | null/"agent"=单专家；"team"=专家团（主理人） |
| `members` | TEXT NULL | JSON 数组，成员结构见下；team 必填，agent 恒 null |

```ts
/** 专家团成员（不含主理人；id 为 dispatch_member 的成员定位键） */
export interface TeamMember {
  id: string;          // kebab-case，团内唯一（如 macro-analyst）
  name: string;        // 花名（如 严过关，参照 WorkBuddy team-spec 谐音风格）
  profession: string;  // 职业头衔（如 风控官）
  systemPrompt: string;// 成员人设：五段式（角色/能力/流程/输出规范/注意）
}
```

- repo/api 同步：`AssistantRecord`/`CreateParams` + `expertType?: "agent"|"team"`
  /`members?: TeamMember[]`；`UpdateParams` 同形（members 数组差量、null 清空）
  ；repo members JSON 序列化（坏 JSON 回退 `[]`，同 tags/quickPrompts 先例，
  复用 `parseJsonStringArray`）。expertType 入库归一：undefined→null。
- 导入导出（第一期 expert-io）：导出 JSON + expertType/members 两字段；导入
  zod 扩展（members ≤6、id kebab-case 唯一、每成员 systemPrompt 必填）。

## 2. 运行时——专家团 system 组装

新建 `electron/domains/ai/chat/expert-team.ts`（纯 Node 纯函数，vitest 直测）：

```ts
/** 主理人 system 组装：主理人 prompt + 成员清单 + 编排铁律（team-spec 移植） */
export function buildTeamLeadSystem(params: {
  leadPrompt: string;        // assistantRow.systemPrompt（主理人人设与业务 SOP）
  members: TeamMember[];
}): string;
```

组装结构（段落顺序固定）：

1. 主理人 prompt 原文（业务 SOP/工作流在主理人 prompt 内承载）。
2. 【团队成员】清单表：每成员一行 `id｜花名（职业头衔）`，附职责一句话取自
   成员 systemPrompt 首句不可靠——直接以 profession 表达；清单后注明「调度时
   dispatch_member 的 member 参数传成员 id」。
3. 【协作铁律】（team-spec 移植，受控并行版；四条，与 expert-team.ts
   `TEAM_LEAD_RULES_HINT` 逐条一致）：①严禁主理人代写成员产出：必须真实
   调度成员取得分析，不得虚构、替代或改写成员观点；②分阶段推进，上一阶段
   成员产出原文完整传入下一阶段调度的 context；同一阶段内无数据依赖的
   成员，应在同一次回复中并行调用 dispatch_member（为每位成员写独立的
   任务简报），全部回传后再进入下一阶段；③成员只对主理人回传结论：主理人
   统筹汇总后再形成面向用户的回答；④面向用户的输出使用用户的语言。
4. 【工具说明】dispatch_member 参数用法（member/task/context 语义一句话）。

`assembleContext` 接线：`assistantRow?.expertType === "team"` 且 members
非空时，`base = buildTeamLeadSystem({ leadPrompt: assistantRow.systemPrompt,
members })`（替代裸 systemPrompt）；members 空的 team 行回退裸 prompt（数据
防御）。采样参数/技能并入/quickPrompts chips 等第一期行为不变。

## 3. dispatch_member 工具

新建 `electron/domains/ai/agent/dispatch-member-tool.ts`：

```ts
export const DISPATCH_MEMBER_TOOL_NAME = "dispatch_member";

export interface DispatchMemberDeps {
  members: TeamMember[];
  /** 非流式成员补全：装配处接 AI SDK generateText（测试注入 stub，
   *  handoverModelText 同款注入式模式） */
  modelText: (args: {
    system: string;
    prompt: string;
    abortSignal?: AbortSignal;
  }) => Promise<string>;
}

export function makeDispatchMemberTool(
  deps: DispatchMemberDeps,
): ToolDefinition<{ member: string; task: string; context?: string }>;
```

- **每请求构造，不进静态 registry**：`collectToolDefinitions` 内当会话绑定的
  assistant 为 team 且 members 非空时构造（`makeReadSkillTool(skills)` 每请求
  构造先例）——成员清单与模型随会话而变，闭包携带，无需 ctx 扩展。签名按
  现有调用点最小扩展（传入 team 信息）。
- **参数**（zod）：`member`（成员 id）、`task`（任务简报：让成员做什么、需要
  回答什么，≤2000 字）、`context`（可选：前一阶段成员产出原文，≤8000 字）。
- **execute**：id 定位成员（不在清单返回错误文案）→
  `modelText({ system: 成员.systemPrompt, prompt: task+context 组装,
  abortSignal: ctx 透传 })` → 返回成员产出原文（不截断，主理人汇编需要
  完整结论）。LLM 调用异常 catch 返回 `错误: 成员「name」执行失败（原因）`
  文案，主循环可继续。
- **kind:"read"**（无本地副作用，模型自主调度是编排核心；WorkBuddy Agent
  spawn 同样无审批）。**登记 BUILTIN_TOOLS**（`{ name:"dispatch_member",
  group:"expert", kind:"read" }` + zh/en security.json 描述 + 计数断言 16→17）
  ——第一期终审 G1 教训：read 工具同样必须可禁用；且工具集构造处须感知禁用
  （禁用时既不出工具也不组装 team system 的铁律段——同目录段门控模式，
  runtimeFilter 同源）。
- **abort 透传**：`ToolDefinition` 的 ctx 形态以现有实现为准（runToolCall 已
  收 abortSignal，确认其是否进 ctx；不进则经 deps 闭包由调用方挂接——以
  最小侵入落地并在报告说明）。

## 4. AI 创建/修改专家团（第一期工具扩展）

`create-expert.ts` 双工具扩展（校验链先行）：

- create schema + 可选 `expertType`（默认 "agent"）与 `members`（expertType
  为 "team" 时必填 1-6 个；agent 时传 members 报错）；成员校验：id
  kebab-case（`^[a-z0-9][a-z0-9-]*$`）团内唯一、name/profession ≤30、
  systemPrompt min 1 ≤8000。description 提示成员 prompt 按五段式编写、花名
  风格建议（team-spec 谐音/职能巧思，不解释也像人名）。
- update schema + `expertType`/`members` 可选差量（members 传即整体覆盖，
  同数组三态）；定位仍按 name。
- 落库：expertType/members 序列化（repo 已透传）。

## 5. UI

- **AssistantDialog**：顶部类型切换（单专家/专家团，RadioGroup 或 pill 二选
  一，默认单专家）；团队态追加「团队成员」编辑区——动态行列表（每行：
  花名/职业头衔/成员 id/人设 Textarea + 删除；「+ 添加成员」≤6 行）；提交
  差量含 expertType/members；编辑态回填。单专家态隐藏成员区（members 提交
  null 保持清空语义——由类型切换驱动）。
- **ExpertDetailDialog**：team 条目展示「团队成员」列表（花名+职业头衔胶囊
  行，主理人以专家名标注「主理人」Badge）。
- **市场卡片/我的专家卡**：不另加成员展示（详情弹窗承载，卡片保持简洁）。
- **会话内**：dispatch_member 工具卡走 ToolCallCard 通用展示（args.member +
  task 摘要、展开显完整参数与成员产出 output）——无新组件。
- **expert-sub-menu/推荐卡/quickPrompts chips**：绑定专家团自动生效（chips/
  技能并入/参数照旧），无改动。

## 6. 市场数据（3 个 team 条目补 members）

`ExpertMarketItem` + `members?: TeamMember[]`（team 条目必填）；三团各 3 名
成员，成员 id/花名（team-spec 谐音风格）/职业头衔/五段式 systemPrompt
（80-200 字/员）：

- content-team：内容策划/文案写手/审校编辑（花名如 沈思齐/文从顺/校无瑕）
- trading-analysis-team：宏观分析师/技术分析师/风控官（花名如 顾大局/
  线索明/严守仓）
- tax-compliance-team：税务顾问/财务顾问/合规法务（花名如 税安平/账清明/
  合同盾）

handleAdd/推荐卡 create 载荷 + `expertType: "team"`/`members`；数据测试锁
members 规范（team 条目必有、1-6 员、id 唯一 kebab-case）。

## 7. i18n 与样式

`chat` namespace `experts` 节 + `ai` namespace `assistant` 节补 key（zh/en
同步）：类型切换标签（单专家/专家团）、成员区标题/添加成员/成员 id 占位/
花名/职业/人设标签、详情「团队成员/主理人」；security.json
`tools.dispatch_member` 双语。样式遵循主题变量与弹窗规范。

## 8. 文件清单

| 动作 | 文件 |
| --- | --- |
| 新建 | `electron/domains/ai/agent/dispatch-member-tool.ts` |
| 新建 | `electron/domains/ai/chat/expert-team.ts`（buildTeamLeadSystem + TeamMember 类型源） |
| 修改 | `electron/domains/ai/chat/chat.service.ts`（team system 组装 + collectToolDefinitions 条件构造 dispatch_member + 禁用门控） |
| 修改 | `electron/domains/ai/agent/create-expert.ts`（双工具 team 扩展） |
| 修改 | `electron/domains/ai/chat/assistant.repo.ts`（+2 列透传与序列化；导入导出 schema 扩展） |
| 修改 | `electron/domains/security/defaults.ts` + zh/en `security.json`（dispatch_member 登记） |
| 修改 | `src-react/domains/ai/api/assistant.api.ts`（类型 + TeamMember） |
| 修改 | `src-react/domains/ai/experts/data/marketplace.ts`（三团 members + 类型） |
| 修改 | `src-react/domains/ai/experts/views/ExpertMarketView.tsx`、`components/ExpertRecommendCard.tsx`（载荷） |
| 修改 | `src-react/domains/ai/assistant/components/AssistantDialog.tsx`（类型切换 + 成员编辑） |
| 修改 | `src-react/domains/ai/experts/components/ExpertDetailDialog.tsx`（成员列表） |
| 修改 | `prisma/schema.prisma`、`electron/infrastructure/script/v1/upgrade-table.sql`（+2 列）+ `prisma generate` |
| 修改 | `src-react/i18n/locales/{zh-CN,en-US}/{chat,ai,security}.json` |

## 9. 测试策略

- `tests/ai/expert-team.test.ts`：buildTeamLeadSystem（主理人原文保留/成员
  清单行/铁律四条/工具说明段/空 members 回退 null）。
- `tests/ai/dispatch-member-tool.test.ts`：成员定位/不存在文案/modelText
  收到成员 systemPrompt 与 task+context/异常 catch 文案/abort 透传（stub
  断言收到的 signal）。
- `tests/ai/chat.service.test.ts` 增量：team 会话 system 含成员清单与铁律；
  dispatch_member 仅 team 会话进工具集；禁用时工具与铁律段双缺席。
- `tests/ai/create-expert.test.ts` 增量：members 校验链（id 重复/非法/超 6/
  team 缺 members/agent 带 members 报错）、update 整体覆盖。
- `tests/ai/assistant-repo.test.ts`/`expert-io.test.ts` 增量：+2 列序列化、
  导出含 team 字段、导入校验。
- `tests/ai/marketplace-data.test.ts` 增量：team 条目 members 规范锁。
- `tests/ai/assistant-dialog.test.tsx` 增量：类型切换显隐成员区、成员增删
  与提交载荷。
- 完成口径：`npm run test` + `typecheck` + `lint`（触碰文件 0 新增）全绿。

## 10. 与 WorkBuddy 实现的显式偏差

| WorkBuddy | 本设计 | 原因 |
| --- | --- | --- |
| TeamCreate + SendMessage + 成员互发消息 | 受控并行 dispatch_member（同阶段并行/跨阶段串行），成员仅对主理人回传 | 编排复杂度由主理人 SOP 承载；成员互发与多轮留后续 |
| members 含主理人（头像展示） | members 仅成员，assistant 行即主理人 | 数据无冗余同步；卡片以专家名+「主理人」Badge 表达 |
| 专家包文件（agents/*.md） | DB 行 members JSON | 与第一期专家=表行一致 |
| Agent 工具 subagent_type 复用 agents MD 注册表 | 每请求闭包构造（read_skill 先例） | 天枢无文件 agent 注册表；闭包携带成员清单最简 |
| spawn 独立上下文窗口 | generateText 单轮（成员无对话历史） | 成员任务自带上下文（task+context）；多轮成员对话留后续 |

## 11. 后续迭代方向（本版不做）

- 成员多轮追问（成员回传时向主理人索要补充信息的结构化协议）。
- 成员产出流式可见（当前经工具卡展开查看）。
- 专家团运行统计（各成员调用次数/耗时，monitor 域埋点）。
