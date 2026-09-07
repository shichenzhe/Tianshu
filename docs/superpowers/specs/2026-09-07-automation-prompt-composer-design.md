# 自动化任务输入区对齐会话输入框设计

> 上游:用户需求「创建/编辑弹框的提示词/工作空间/模型/参数参照会话输入框,
> 便于引用文件、技能,选择工作空间,设置执行权限」。
> 方案 B:并行新建 TaskPromptInput(不碰 ChatInput),后端 runner 触发时
> 同构注入引用,零 DB 迁移。

## 0. 已确认决策(澄清结论)

| 问题 | 结论 |
|------|------|
| 执行权限 | 仅 UI 对齐:胶囊照会话样式只读展示「完全访问」,点击弹 FullAccessModal 说明;行为不变(fullAccess=true) |
| 布局对齐程度 | 完整卡片式:提示词卡片(联想/pill/工具栏)居中段,名称/工作空间/频率保持表单;工作空间仍下拉 |
| TaskModelPicker | 纯选模型(providers/models 分组视觉同 ModelPicker),**不带参数三档**;参数三档保留为 Dialog 表单独立行(现状位置) |
| 技能引用语义 | 聚焦注入:引用了技能 → system 只注入这些技能 + read_skill 仅挂这些;未引用 → 现状全量注入 |
| 复用方式 | 方案 B 并行新建,不重构 ChatInput;共享资产是纯函数层(inline-tokens/pending-file)与子组件(PermissionCapsule/skill-sub-menu),零改动复用 |

## 1. 前端:TaskPromptInput 卡片组件

新建 `src-react/domains/ai/automation/components/TaskPromptInput.tsx`(~300 行,
ChatInput 交互骨架的无会话态变体):

```
┌──────────────────────────────────────────────┐
│ textarea(文字与内联引用 token 交叉,          │
│ 镜像层 pill 高亮——复用 inline-tokens 渲染)  │
├──────────────────────────────────────────────┤
│ [+]菜单  权限胶囊(只读"完全访问")  TaskModelPicker │
└──────────────────────────────────────────────┘
```

- **受控 props**:`{ value; onChange; workspaceId: number | null; modelId;
  onModelChange }`。prompt 文本含 `@path`/`⚡技能名` token 原样存库。
- **联想**:照搬 ChatInput 的 `@` 文件联想(`file:listWorkspaceFiles` 数据源)
  与 `⚡`/`/` 触发逻辑、↑↓/Enter/Esc 键盘交互、IME 安全 Enter;
  **不支持 `/` 命令**(候选剔除 SLASH_COMMANDS)。
- **TaskPlusMenu**(新建,PlusMenu 子集变体):文件选择(onPickPaths → 插
  `@token`,**不读内容**——触发时才读)、skill-sub-menu(复用现组件)、
  MCP 管理跳转、**「插入变量」项**(插 `{{date}}/{{weekday}}/{{time}}`,
  替代原左下角按钮)。剔除模式三态与专家项。
- **权限胶囊**:直接复用 PermissionCapsule,`accessMode="full"` 固定 +
  no-op onChange(sessionId 传 -1 仅作无障碍 id)——点击弹出的
  FullAccessModal 红色警示即「点开看说明」入口;Dialog 原红色警示文案行移除。
- **TaskModelPicker**(新建,~80 行):借 ModelPicker 的 providers/models
  双 query 与分组视觉,props 改 `modelId/onChange`(不写会话 IPC),
  保留「管理服务商」跳转。
- **CreateTaskDialog 重构**:中段「Textarea + 模型/参数/工作空间三行」→
  名称行 + 工作空间下拉(选择后 `@` 联想随之可用)+ TaskPromptInput 卡片
  (模型选择在卡片右下)+ 参数三档独立表单行(不动)+ SchedulePicker(不动)。
- 提交校验不变;编辑回显:prompt 原样进 textarea,token pill 自动渲染
  (终审修复波的 key remount 机制已保证状态播种)。

## 2. 后端:runner 触发时引用注入

新建 `electron/domains/ai/automation/resolve-attachments.ts`,
`automation-runner.ts` 接线:

```
执行任务时:
1. tokens = parseInlineTokens(task.prompt)   ← 复用前端 inline-tokens 纯函数
2. file 段:workspacePath 下 readWorkspaceFile(path) 读最新内容
   (复用 chat 域 workspace-files.ts 现成函数,含其内置限制)
3. skill 段:loadSkills() 结果按技能名匹配 → SKILL.md 内容
4. injected = 各引用块按会话同构格式前缀拼接 + 移除全部 token 后的正文:
   "[引用文件 <path>]\n<内容>" / "[引用技能 <name>]\n<内容>"
   (块格式与 ChatView.handleSend 同构;正文 token 移除——模型不重复看到
   引用标记,编辑回显走 DB 原文不受影响)
5. injected 作为 user 消息落库与模型 history —— 会话回看/产物面板
   ([引用文件 <path>] 前缀解析)天然兼容
```

- **失败语义**:引用文件已删/读取失败 → run 落 failed(`attachment_missing:
  <path>`),不静默跳过;技能不存在同理(`attachment_missing: skill <name>`)。
- **技能聚焦注入**:prompt 含技能引用 → `buildSystemPrompt(undefined, 仅这些)`
  + `makeReadSkillTool(仅这些)`;无引用 → 现状全量。
- **变量替换顺序**:先注入引用块、后仅对用户 prompt 原文段替换
  `{{date}}/{{weekday}}/{{time}}`(引用内容里同形字样不替换)。
- **零 DB 迁移**:prompt 存 token 原样。

## 3. i18n 与范围

- 新增键:`chat:automation.create.attachmentMissing`(zh/en 同步);
  其余全部复用会话现有键(plus.*/providers/FullAccessModal)。
- **不做(YAGNI)**:`/` 命令、上下文用量按钮、模式徽标、发送/停止按钮、
  专家引用、`{{变量}}` pill 高亮、创建时内容快照、DB 迁移。

## 4. 文件与测试清单

- 新建:`TaskPromptInput.tsx` / `TaskPlusMenu.tsx` / `TaskModelPicker.tsx`
  (automation/components/)、`electron/domains/ai/automation/resolve-attachments.ts`
- 修改:`CreateTaskDialog.tsx`(中段重构)、`automation-runner.ts`(注入+聚焦)、
  `src-react/i18n/locales/{zh-CN,en-US}/chat.json`
- 测试:`tests/ai/automation-resolve-attachments.test.ts`(注入格式与
  ChatView.handleSend 输出逐字同构断言;文件/技能缺失语义;变量不进引用块);
  `tests/ai/automation-runner.test.ts` 增用例(带引用任务 → user 消息含前缀块;
  文件缺失 → failed(attachment_missing);技能聚焦 → system 只含引用技能)。
