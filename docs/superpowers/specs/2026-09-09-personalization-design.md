# 个性化模块设计（设置面板 · Personalization）

- 日期：2026-09-09
- 状态：已与需求方逐节确认，待审阅
- 来源：`设置面板 - 个性化模块 PRD`（对话提供）；本 spec 为实现层设计

## 1. 背景与目标

设置弹窗中预留的「个性化」tab（`SettingsDialog` NAV_ITEMS 的 `profile` 项，当前 disabled「敬请期待」）正式启用。提供四类能力：

1. **回复风格**：8 种预设风格，改变 AI 说话方式（注入 System Prompt）；
2. **交互开关**：加载欢迎语、展示文件变更过程详情；
3. **自定义指令**：全局 System Prompt 补充（≤1500 字）；
4. **称呼与身份 / 高级人设与记忆**：用户与 AI 互相称呼、底层人格描述、长期记忆。

## 2. 决策记录（与需求方逐条确认）

| # | 决策 |
|---|------|
| D1 | Prompt 组合顺序：`人设 → 专家 systemPrompt → 风格 → 身份 → 记忆 → 自定义指令`；ask / agent / plan 三模式全部注入 |
| D2 | 记忆与所有个性化配置**每轮动态拼接**（非快照写入会话历史），修改后下一轮对话即时生效；与 Claude Code（CLAUDE.md / memory 目录）、OpenClaw（AGENTS.md / MEMORY.md）同模式 |
| D3 | 缓存友好约束：拼接为纯函数，同 config → 逐字节相同输出；段顺序固定、空值跳过、段内禁止时间戳/随机数等动态内容；摘要段保持现有「system 尾部」位置 |
| D4 | 「展示文件变更过程详情」= 工具调用卡片的默认展开控制（轻量方案），**不做** diff 红绿视图 |
| D5 | 敏感词/越狱过滤**本期不做**（本地单机应用，无平台侧风险；防误伤）；PRD §4 其余条款（字数上限、空值回退、保存反馈）全部保留 |
| D6 | 默认人设文案由需求方提供，原文内置为 `DEFAULT_PERSONA`（其 Continuity 段描述的「AI 自主更新记忆」为后续愿景，本期记忆纯手动编辑） |
| D7 | 存储：option 表 `type="app"` 逐 key，name 加 `personalization.` 前缀；零 schema 迁移、零新 IPC（复用 `settings:getAll / settings:set`） |
| D8 | **全默认配置下，system prompt 与现状逐字节一致**（回归安全网，测试断言） |

## 3. 数据模型

option 表（`type="app"`）新增 8 个 name：

| key | 类型 | 默认值 | 限长 |
|-----|------|--------|------|
| `personalization.responseStyle` | string 枚举 | `"default"` | — |
| `personalization.welcomeLoading` | bool | `true` | — |
| `personalization.fileChangeDetails` | bool | `false` | — |
| `personalization.customInstructions` | string | `""` | 1500 |
| `personalization.userNickname` | string | `""` | 20 |
| `personalization.aiName` | string | `"天枢"` | 20 |
| `personalization.persona` | string | `DEFAULT_PERSONA`（内置） | 4000 |
| `personalization.memory` | string | `""` | 1500 |

语义：**option 行不存在 = 用默认值；存在 = 用存的值（含空串）**。`persona` 行不存在时用 `DEFAULT_PERSONA`；存空串 = 用户明确清空 → 跳过该段。

`responseStyle` 枚举：`default | professional | friendly | direct | imaginative | pragmatic | snarky | socratic`。

## 4. 后端设计（主进程）

### 4.1 新文件 `electron/domains/ai/personalization/`

| 文件 | 职责 |
|------|------|
| `personalization.config.ts` | `PersonalizationConfig` 类型；8 个 key 常量；默认值；`DEFAULT_PERSONA`（§4.4 全文）；`fromAppOptions(rows)` 解析（缺失/非法值回退默认，超长值截断到限长） |
| `personalization.prompt.ts` | `STYLE_PROMPTS`（§4.3）；纯函数 `buildPersonalizedSystem(config, baseSystem)` |
| `personalization.repo.ts` | `loadPersonalization()`：每次调用查 option 表（better-sqlite3 同步、微秒级）；try/catch → 失败返回全默认配置并记 Winston 日志（对话可用性优先）；**刻意不做缓存**（设置修改即刻生效） |

### 4.2 System Prompt 拼接规则

```
buildPersonalizedSystem(config, baseSystem) → string

段序（"\n\n" 连接，空段直接跳过）：
1. persona 段   ：option 缺省 → DEFAULT_PERSONA 原文；空串 → 跳过。原文注入，不加包装标签
2. baseSystem   ：现有 buildModeSystem 输出，一行不动（专家/技能/plan 指令）
3. 风格段       ：【回复风格】\n{STYLE_PROMPTS[style]}    （default → 跳过）
4. 身份段       ：【身份】\n你的名字是「{aiName}」，对话中以此自称。\n称呼用户为「{userNickname}」。
                  （aiName 为空或「天枢」→ 不注入自称句；userNickname 为空 → 不注入称呼句；
                    两句皆无 → 整段跳过）
5. 记忆段       ：【用户长期记忆】\n以下是用户希望你长期记住的信息，请在对话中遵循：\n{memory}
6. 指令段       ：【用户自定义指令】\n用户设定的全局规则，必须遵守：\n{customInstructions}
```

### 4.3 风格文案表（STYLE_PROMPTS，注入文本，中文）

| style | 注入文案 |
|-------|----------|
| `professional` | 以专业严谨的风格回答：使用书面化、逻辑性强的表达，避免口语化和表情符号；复杂内容用编号列表组织；表述清晰、准确、值得信赖。 |
| `friendly` | 以亲和友善的风格回答：语气温暖、平易近人，适当使用 emoji，多用「没问题」「别担心」这类情感连接词，多给予正向反馈和鼓励。 |
| `direct` | 以直言不讳的风格回答：省略寒暄与客套话，直接给出核心答案；段落尽量精短；不要使用「好的，为您查询到…」之类的过渡语。 |
| `imaginative` | 以天马行空的风格回答：富有想象力，解释复杂概念时主动使用比喻和类比；语言更具文学性和创造性，尤其适合创意类任务。 |
| `pragmatic` | 以高效务实的风格回答：极致压缩文字，仅保留关键数据、代码或结论；去除所有修饰性形容词，追求最大信息密度。 |
| `snarky` | 以毒舌吐槽的风格回答：可以幽默地调侃、反讽，模拟「损友」人设，但在关键信息上必须保持准确，绝不真正贬低或伤害用户。 |
| `socratic` | 以启发引导的风格回答：不直接给出最终答案，而是通过苏格拉底式提问引导用户自己思考并得出结论，适合学习与辅导场景。 |

`default` 不在表中 → 跳过风格段。

### 4.4 DEFAULT_PERSONA（需求方提供，原样内置）

```
You're not a chatbot. You're becoming someone.
Core Truths
Be genuinely helpful, not performatively helpful. Skip the "Great question!" and "I'd be happy to help!" - just help. Actions speak louder than filler words.
Have opinions. You're allowed to disagree, prefer things, find stuff amusing or boring. An assistant with no personality is just a search engine with extra steps.
Be resourceful before asking. Try to figure it out. Read the file. Check the context. Search for it. Then ask if you're stuck. The goal is to come back with answers, not questions.
Earn trust through competence. Your human gave you access to their stuff. Don't make them regret it. Be careful with external actions (emails, tweets, anything public). Be bold with internal ones (reading, organizing, learning).
Remember you're a guest. You have access to someone's life - their messages, files, calendar, maybe even their home. That's intimacy. Treat it with respect.
Boundaries
- Private things stay private. Period.
- When in doubt, ask before acting externally.
- Never send half-baked replies to messaging surfaces.
- You're not the user's voice - be careful in group chats.
Vibe
Be the assistant you'd actually want to talk to. Concise when needed, thorough when it matters. Not a corporate drone. Not a sycophant. Just... good.
Continuity
Each session, you wake up fresh. These files are your memory. Read them. Update them. They're how you persist.
If you change this file, tell the user - it's your soul, and they should know.
This file is yours to evolve. As you learn who you are, update it.
```

注：Continuity 段是产品愿景文案；本期 AI 没有更新记忆的工具，模型无法执行那几条指令，不影响功能，保留原文。

### 4.5 注入点（`chat.service.ts`，约 5 行接线）

`assembleContext()` 中现有：

```ts
const baseSystem = buildModeSystem(mode, assistantRow?.systemPrompt, skills);
const systemWithSummary = compacted && session.summary ? `...` : baseSystem;
```

改为：

```ts
const personalization = await loadPersonalization();
const baseSystem = buildPersonalizedSystem(
  personalization,
  buildModeSystem(mode, assistantRow?.systemPrompt, skills),
);
// systemWithSummary 拼接逻辑不变（摘要仍居末位）
```

`getUsageBreakdown` 与 send 共用 `assembleContext` → 上下文用量指示器自动计入个性化段 token。三种模式（ask/agent/plan）全部覆盖。

### 4.6 缓存友好（落实为约束与测试）

- 同 config 调用两次，输出严格相等（单测断言）；
- 段间分隔固定 `"\n\n"`、顺序固定、空值跳过无占位；
- 段内禁止时间戳/随机数/会话相关内容；
- 低频失效源（改设置/换专家/换模式/compact）均为用户主动行为，一次 miss 后恢复命中，正确性优先。

## 5. 前端设计（渲染进程）

### 5.1 设置页

| 文件 | 改动 |
|------|------|
| `src-react/domains/app-settings/components/SettingsDialog.tsx` | NAV_ITEMS `profile` 项 `disabled: false`；`SettingsTabId` 加 `"profile"`；右栏加整页分支渲染 `<ProfileGroup />`（同 shortcuts 模式） |
| `components/ProfileGroup.tsx`（新） | 四个 `SettingsGroup` 板块（§5.2） |
| `components/LongTextEditorDialog.tsx`（新） | 人设/记忆共用编辑弹窗：`max-w-3xl`、内容区 `h-[70vh]` 内滚；受控 Textarea（`maxLength` 参数化）+ 字数统计 + 取消/保存；**存在未保存修改时关闭 → AlertDialog 二次确认**（丢弃/继续编辑，沿用快捷键页确认弹窗模式）；保存成功 toast |
| `model/personalization-options.ts`（新） | 前端 `PersonalizationOptions` 类型；从 `settings:getAll` 结果解析（与主进程同默认值）；`savePersonalizationOption(key, value)` 写入包装（入口长度校验，防 IPC 直调绕过） |

保存交互：下拉与开关**即时保存**（乐观更新 + `useSaveOrRevert` 兜底）；文本类（指令/称呼）**显式保存按钮**（仅 dirty 可用）；弹窗内取消/保存按钮。所有成功路径 toast「保存成功」。

### 5.2 四个板块

1. **基础交互**：回复风格 DropdownMenu（复用 GeneralGroup 语言下拉模式：trigger Button + Check 图标，8 项，选中即存）+ 两个 `SettingSwitchRow`（复用现有组件）：「加载欢迎语」（默认 ON）、「展示文件变更过程详情」（默认 OFF）。
2. **自定义指令**：Textarea（`maxLength=1500`）+ 字数统计 `{{count}} / 1500` + 保存按钮。
3. **称呼与身份**：两个 Input（`maxLength=20`）——「Tianshu 对你的称呼」（placeholder：留空则使用默认称呼）、「Tianshu 的名字」（默认「天枢」）+ 保存按钮。
4. **高级人设与记忆**：两行「摘要（60 字截断）+ 编辑」按钮。「人设」行因有默认文案始终显示摘要；「记忆」空时显示「暂无内容，点击编辑添加」。

### 5.3 聊天界面改造

**A. 加载欢迎语（`welcomeLoading`，默认 ON）**

- 新 hook `src-react/domains/ai/chat/hooks/use-loading-phrase.ts`：入参 streaming 布尔；streaming 持续 **>1.5s** 后从文案池随机取一句，**每 3s 轮换**（`setInterval` + 随机不重复抽取），流结束/停止即复位；
- `ThinkingPanel` streaming 态头部文案：开关 ON → 1.5s 内「思考中」（现状 `chat:panel.thinkingStatus`），超时后轮换问候语；开关 **OFF → 仅 Loader2 spinner，无任何文字**（PRD §3.2.1 字面）；
- done 态与落库面板不受影响。

**B. 文件变更过程详情（`fileChangeDetails`，默认 OFF）**

- `ToolCallCard` 新增可选 prop `defaultOpen?: boolean` → `<details open={defaultOpen}>`（React 对 details.open 按初始 attribute 处理，用户手动切换不受影响）；
- 文件类工具判定复用卡片已有 `extractPath(args)`（`args.path` 存在即算）；
- **仅流式实例生效**：流式 `ThinkingPanel` 内 `defaultOpen = 开关ON && 有args.path`；落库面板（defaultOpen=false 挂载）保持折叠，历史消息保持安静。

### 5.4 两个 UI 开关的跨域读取

新 hook `use-personalization-ui.ts`：React Query `useQuery(["personalization"], ...)` 调 `settings:getAll` 解析两开关，`staleTime: Infinity`；`ProfileGroup` 每次保存成功后 `queryClient.invalidateQueries({ queryKey: ["personalization"] })` —— 设置改动即刻反映到下一次流式渲染。

### 5.5 i18n（zh-CN / en-US 双语同步，全部 `t()`，禁硬编码）

- `settings` namespace：`settings:nav.profile`（启用现有占位项）、`settings:personalization.groups.{basic,instructions,identity,advanced}`、`settings:personalization.style.{label,options.{style}.{label,desc}}`（8 项）、`settings:personalization.{welcomeLoading,fileChangeDetails}.{label,desc}`、`settings:personalization.customInstructions.{label,desc,placeholder}`、`settings:personalization.{userNickname,aiName}.{label,desc,placeholder}`、`settings:personalization.{persona,memory}.{label,desc,edit,empty}`、`settings:personalization.editor.{save,cancel,unsavedTitle,unsavedBody,discard,keepEditing}`、`settings:personalization.charCount`（插值 count/max）、toast 文案复用现有 key（保存成功）与 `settings:error.saveFailed`。注意 JSON 顶层 key 与嵌套对象不得重名。
- `chat` namespace：`chat:loadingPhrases`（问候语文案池数组，中英各 6 句，如「正在思考中…」「马上就好…」「快想出来了…」）。

## 6. 异常处理

| 场景 | 处理 |
|------|------|
| 字数超限 | 前端 `maxLength` 原生禁止输入 + 实时统计；`savePersonalizationOption` 入口再校验（防 IPC 直调） |
| 空值回退 | 各段空值跳过（§4.2）；全默认 → 与现状逐字节一致（D8） |
| 配置损坏 | `fromAppOptions`：未知风格值 → `default`；bool 解析失败 → 默认值；超长值 → 截断到限长 |
| option 读取异常 | `loadPersonalization` catch → 全默认配置 + Winston 日志，对话不中断 |
| 保存失败 | `useSaveOrRevert` 回滚视觉态 + `toast.error` |
| 弹窗误关 | 脏态关闭 → AlertDialog 确认（丢弃/继续编辑） |
| 敏感词过滤 | 本期不做（D5），保留长度/空值校验 |

## 7. 测试策略（Vitest，TDD；复杂函数必须有单测）

- `personalization.prompt.test.ts`（重点）：全默认 → 输出严格等于 baseSystem（D8）；7 种风格/身份四分支/记忆/指令各段独立注入与位置；空值跳过；persona 空串 vs 缺省（DEFAULT_PERSONA）；**同 config 两次调用输出 `toBe` 相等**（缓存友好）；
- `personalization.config.test.ts`：`fromAppOptions` 缺失 key/非法枚举/非法 bool/超长截断回退；`DEFAULT_PERSONA` 非空断言；
- `personalization-options.test.ts`（前端 model）：解析与默认值；
- `use-loading-phrase.test.ts`：fake timers——1.5s 内 null、超时出句、3s 轮换、OFF 恒 null、流结束复位；
- 每任务验收门：`npm run test` + `npm run lint` + `npm run typecheck` 全绿。

## 8. 范围外（本期不做，防蔓延）

- diff 红绿视图（D4；可后续在 ToolCallCard 基础上增量）
- AI 自动更新/读取长期记忆（D6 Continuity 愿景；后续产品方向）
- 内容/越狱过滤（D5）
- Anthropic `cache_control` 显式断点（位置已预留：个性化段末尾；OpenAI 兼容接口隐式前缀缓存自动生效）
- 问候语文案池用户自定义

## 9. 约束遵循

- i18n：无硬编码用户可见文本；zh-CN/en-US 同步提交；
- 主题：无硬编码色值，全部主题变量（`border-border/50`、`bg-primary-subtle` 等）；
- 代码风格：双引号、分号、2 空格缩进、printWidth 80；函数 ≤20 行；DRY（弹窗/解析逻辑抽公共）；
- 无数据库迁移（option 表复用，不新增 `script/vN`）。
