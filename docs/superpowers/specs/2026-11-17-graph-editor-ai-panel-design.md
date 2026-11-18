# 编排编辑器 AI 编排面板 —— 设计文档

日期：2026-11-17
状态：已定稿（两轮 builder 复审意见已并入），待用户批准
范围：`apps/tianshu-desktop`（渲染进程为主，`ChatPane` 一处共享组件加可选 prop）

## 意图与为什么

流程编排编辑器（`/module/ai/graphs/:id`）目前纯手工搭节点。用户希望在编辑器内直接对 AI 描述需求（如「每天抓取天气并发邮件」），AI 生成/修改整张图，用户确认后落到画布。参考先例是文件窗文档页右侧的 AI 对话框（`FileChatPanel` 内嵌通用 `ChatPane` + 首条上下文注入）。

## 目标

- 图编辑器右栏新增「AI 编排」标签页，内嵌复用 `ChatPane`（消息流 + 输入框 + 流式 + 模型/权限胶囊）。
- AI 直接改图：新建输出全量图 JSON、局部修改输出结构化变更单；**校验链通过后自动落画布**（对齐 n8n AI Builder / Cursor 的画布介质主流模式），卡片转为「已执行回执」（列改动 + 撤销入口）。
- 每个已保存图（graphId）绑定一个持久会话，重开编辑器对话历史仍在。

## 非目标

- 不做真 agentic 工具循环改图——业界（Coze/Dify）的 agentic 为多步推理带观察场景设计；单趟变更单 + 消息级回执已覆盖编辑辅助的核心收益（可见、可监督），架构打通留作远期。
- 不做跨主机（server-face 遥控编辑器）——编排编辑器本身即桌面本地能力（n8n Cloud/Coze 式远程编辑不在本期）；server 侧未来有图编辑 UI 时本设计平移。
- 不做文件窗式「面板级图片 drop 区」——ChatPane 自带 ChatInput 附件体系（粘贴/拖入图片走多模态）随复用自然可用，不另造面板层 drop。

## 反目标

- AI 输出**未经完整校验链**直接写画布（校验不过绝不自动应用，问题必须可见）。
- ~~新建（未保存）图可用 AI 面板（无 graphId 无法绑定会话，避免落地后绑定丢失）。~~
  **2026-11-18 修订（用户裁定）**：新建图**可用** AI 编排——会话照常创建但**不绑定**（用户明确「可以不存历史会话」）；保存成功后视图层把期间会话补绑到新图，历史随图走。


## 约束

- 复用 `ChatPane`（`src-react/domains/ai/chat/components/ChatPane.tsx`），不 fork。
- 图校验用现成 zod schema：`packages/tianshu-core/src/graph-schema.ts`（渲染层经 `domains/ai/orchestration/api/graph.schema.ts` re-export）。
- 画布状态在渲染进程 React state（`GraphEditorView` 的 `graph` + `commitGraph`，自带撤销/重做），AI 面板必须以 props 回调形式经 `GraphEditorView` 落图。
- 全部用户可见文案走 i18n（zh-CN/en-US，命名空间沿用 `chat`，key 挂 `orchestration.editor.ai*`）。
- 图↔AI 会话绑定走 schema：`graphDefinition` 加可空列 `aiSessionId`（1:1，资源侧拥有，业界文档型产品同款——Notion 页面线程/GitHub PR↔review）。DB 现处 v1（发布前全量建表脚本），按仓库规则直接改 v1 快照（开发态指纹守卫自动 drop 重放重建，发布后则需 script/vN）。

## 方案（已选定）

业界对标（2026）：n8n AI Builder / Zapier Copilot 走「对话 → 全量图 → 应用」（n8n 的 workflow JSON 是唯一共享模型且自动保存，无草稿态）；Coze/Dify 走「agentic 工具循环逐步改图」（chain-of-thought 可见、需人工监督，规划模式 ~15% 失败）；Copilot/v0 确立「AI 改动渲染为可审阅 diff/变更清单后确认应用」的审阅模式。

| 方案 | 取舍 | 结论 |
|---|---|---|
| A. 全量图 JSON 往返 | 复用现成 schema/序列化，实现最短；每次全量注入/回传 token 粗暴、应用是黑盒 | 仅保留为「新建/大改」输出形态 |
| B. 纯增量 patch | 省 token；无审阅环节、新建场景不适用 | 否 |
| C. chat 工具调用改图（真 agentic） | 主进程 tool loop 够不到渲染进程草稿，需新 IPC 链路或草稿上搬主进程；多轮往返延迟高 | 否（架构成本不划算，留作远期） |
| **D. 全量建图 + 变更单改图（混合）** | 新建输出全量 JSON（n8n 模式），修改输出结构化变更单并渲染为可审阅变更清单（Copilot/v0 模式）；单趟 LLM 调用、全渲染层、不动聊天引擎 | **选定** |

会话归属：绑定 graphId 的持久会话（用户已选）。面板布局：右栏「节点属性 / AI 编排」标签页（用户已选）。

## 变更单契约（方案 D 核心新增）

### 操作 schema（`graph-ai-context.ts` 内 zod）

```ts
graphChangeSetSchema = {
  ops: Array<
    | { op: "addNode"; node: GraphNode }              // position 可缺省（自动布局）
    | { op: "updateNode"; id: string; patch: object } // 宽松补丁，同 NodePropertiesPanel patchNode 语义
    | { op: "removeNode"; id: string }                // 牵连边由应用器级联删除
    | { op: "renameNode"; from: string; to: string }  // 应用器同步边引用（编辑器已有 renameNode 纯函数可复用）
    | { op: "addEdge"; edge: GraphEdge }
    | { op: "removeEdge"; from: string; to: string; conditionValue?: string }
  >
}
```

### AI 回复两种形态（`extractGraphEdit` 统一解析）

- **全量形态**：```json 代码块内容过 `graphJsonSchema` → 整体替换（保留存活节点坐标，见 5b）。
- **变更单形态**：```json 代码块内容过 `graphChangeSetSchema` → 渲染变更清单卡片。
- 解析优先级：先尝试变更单，再尝试全量图；都不过返回 null。

### 变更清单卡片（GraphAiPanel 内，AI 回复下方）

- **消息级归属（复审裁定）**：每条解析成功的 assistant 消息各自绑定自己的提取结果，卡片渲染在该消息下方；状态按消息 id 标记（待校验 → 已应用 / 校验失败）。不存在全局「最新一条」状态。
- 渲染实现：消息列表渲染需要消息级插槽——`ChatPane` 再加一个可选 prop `renderMessageExtra?: (message: MessageRecord) => ReactNode`（ChatMessages 透传到对应消息项下方；默认不传零变化）。卡片从消息文本 `extractGraphEdit` 提取（useMemo），数据源就是该消息本身 + 当前 `graph`。
- **自动应用 + 回执模式（已改定，业界对标后修订；用户已选）**：AI 回复解析成功 → 立即跑校验链 → **通过则自动落画布**（`onApplyGraphOps` / `onApplyFullGraph`（GraphEditorView 提供）→ 坐标合并（5b）→ `commitGraph` 进撤销栈），卡片转为**已执行回执**：列出改动条目 + 撤销按钮（undo 一步）+ toast 成功；**不通过则不落图**，卡片红色列出候选问题 + 提示「可追问 AI 修正」，无应用按钮（无可应用之物）。
- 卡片内容：把 ops 渲染为人类可读条目列表（i18n）：「新增节点 `send-email`（email）」「修改 `fetch-weather` 的 url」「连接 `a → b`」「删除节点 `old-node`（级联删除 N 条边）」；条目图标按操作类型区分（Plus/Pencil/Trash/Link/Unlink）。全量形态卡片显示「整体替换（N 节点 / M 边）」。
- **候选问题渲染在卡片内（复审裁定）**：校验链失败的候选图从未进 `graph` state，编辑器现有校验清单（committed state 派生）物理上显示不了它——候选的 `normalizeGraph`/`validateGraph` 问题列表渲染在卡片内部（红色条目）。不用 toast 报数、不自动展开编辑器清单（toast 保留为次要提示）。
- 面板头部不设全局「应用」按钮（复审裁定，统一为消息级卡片）。

### 指令文本要点（`buildGraphAiInstruction`，i18n）

- 告知 AI 两种输出形态的选择标准：**新建图或改动超过半数节点 → 全量图 JSON；局部修改 → 变更单**（ops 数组）。
- 变更单只含改动；`removeNode` 不需列级联边；id 必须 kebab-case 唯一；未修改节点必须原样保留 position（全量形态）。
- **模型目录约束（复审裁定）**：llm/intent/vectorize/imageGen 等节点的 `modelId` 必须来自注入的模型目录（id + 显示名），不得臆造；无法确定时置 `0` 占位（编辑器模板预填同款语义），用户在画布上手动换绑。
- 不要求改图时正常问答，不输出代码块。

## 具体设计

### 1. 右栏标签页（GraphEditorView）

- 右侧面板头部（现 `:1229-1233` 标题行）改为：左侧两个 tab「属性」（Settings2 图标）/「AI 编排」（Sparkles/Wand2 图标），右侧保留最大化/最小化/收起。
- `panelState: collapsed | float | full` 状态机不动。收起态右缘把手从 1 个变 2 个（上下排列：属性 / AI），点击各自展开并选中对应 tab。
- 内容区按 activeTab 渲染 `NodePropertiesPanel`（现状）或新 `GraphAiPanel`。
- 仅 `mode === "canvas"` 时存在（现状一致）；JSON 模式不出面板。
- `isNew`（未保存新图）：AI tab 禁用（点击 toast「保存后可用」，i18n）。
- activeTab 为组件内 state（不持久化，我的裁定）。

### 2. GraphAiPanel（新组件）

`src-react/domains/ai/orchestration/components/GraphAiPanel.tsx`，结构仿 `FileChatPanel` 但精简：

- props：`graphId: number`、`graphName: string`、`graphDescription: string`、`graphJson: string`（当前 canonicalJson）、`onApplyGraphOps: (ops: GraphOp[]) => void`、`onApplyFullGraph: (json: GraphJson) => void`、`onUndo: () => void`（回执卡片撤销按钮用，接编辑器现有撤销；均由 GraphEditorView 提供，内部走 `commitGraph`/现有 undo）。
- 头部工具行：新建会话（清绑定再发即新建）、收起。无全局应用按钮（见变更清单卡片节）。
- **模型目录查询（复审裁定）**：面板挂 `useQuery` 拉模型配置列表（现有 model-config API），拼进指令与快照——AI 只用目录内 `modelId` 或 `0` 占位。
- 无拖宽（右栏宽度沿用面板骨架 440px）、无图片 drop。
- 会话记录拉取、占位会话（哨兵 id=-1）、`sessionResolver`/`onSessionResolved` 链路照抄 FileChatPanel 模式（`useQuery` key `["sessions","graph-ai",id]`）。
- `onOpenSettings`：聚焦主窗跳 providers/experts 路由——文件窗用 `fileWindow:openRoute`；图编辑器在主窗内，直接 `navigate()`（GraphEditorView 已有 useNavigate）或复用同路由即可（我的裁定：直接 react-router navigate）。
- 快捷指令 2 条（i18n）：「解释当前图」「给出优化建议」——纯问答，不改图。

### 3. 会话绑定与创建（use-graph-ai-session.ts）

`src-react/domains/ai/orchestration/hooks/use-graph-ai-session.ts`：

- **绑定存储（已改定，业界对标后修订）**：`graphDefinition.aiSessionId` 可空列（1:1，资源侧拥有）。编辑器 `GraphApi.getById` 记录自带该字段，面板零额外查询。改动面：`schema.prisma` 加列 + v1 建表脚本同步 + GraphApi update 路径不得清空该列（update 载荷为 name/description/graphJson 局部时保持原值）。
- **绑定回写通道**：首条发送会话惰建成功后需回写 `aiSessionId`——新增专用 IPC（如 `graph:bindAiSession { id, aiSessionId | null }`，repo 局部 update，不动 graphJson），「新建会话」按钮即调它置 null。通道签名留给 builder。
- 会话创建：`invoke("session:create", { workspaceId, title: 图名 })`；workspaceId 取 `WorkspaceApi.list()` 首个（无则 list 自动补建「默认工作空间」，照抄 use-file-session 保底逻辑）。
- `ensureSession()` 防重入 ref；`prepareFirstSend()` 返回 `{ session, contentPrefix }`（首条前缀含指令，见 §4）。
- 会话已删善后：照抄 `isSessionGoneError` 模式（回写 `aiSessionId=null` + 提示，再发即新建）。
- 空会话回收：文件窗有 sessionCreatedHere 判空回收；本期从简——不做回收，挂账（低风险，空会话无消息不占可见资源）。**（我的裁定，可否决）**

### 4. 上下文注入（graph-ai-context.ts，纯函数 + 单测）

`src-react/domains/ai/orchestration/lib/graph-ai-context.ts`：

- `buildGraphAiInstruction(modelCatalog)`：固定指令文本（i18n），首条发送时拼入前缀。要点见上「指令文本要点」节（两种输出形态、变更单规则、模型目录约束、纯问答不输出代码块）。
- `buildGraphContextPrefix(graphName, description, graphJson, modelCatalog, selectedNodeIds?)`：每次发送注入的「当前图快照」段（图名/描述/**模型目录**（id+显示名）/选中节点 id/完整 canonicalJson）。
  - 超限降级：`graphJson` 超 ~60k 字符时改注入结构摘要（节点 id+kind+name 表 + 边表）+ 注明「完整 JSON 超出注入上限」（我的裁定值与口径，可调）。
- 发送拼装：首条 = 指令 + 快照 + 用户输入；后续 = 快照 + 用户输入。即**每次发送都带最新快照**（AI 视图不陈旧；token 成本挂账，后续可换增量/摘要 diff）。
- `ChatPane` 加可选 prop：`buildSendPrefix?: () => string`——`handleSend` 发送前调取并 prepend（哨兵会话首条与常设会话两条发送路径都要拼；与 `sessionResolver` 的 `contentPrefix` 共存时，resolver 前缀在前、buildSendPrefix 在后）。默认不传零行为变化。
  - 哨兵首条：`finalContent = resolverPrefix + sendPrefix + input`。
- 选中节点注入：`selectedId` 经 GraphEditorView 传入面板，快照里附「当前选中节点」。

### 5. 应用 AI 修改（核心闭环）

- `extractGraphEdit(text): { kind: "full"; json: GraphJson } | { kind: "ops"; changeSet: GraphChangeSet } | null`：解析 AI 回复（优先级与两种形态见上「变更单契约」）。纯函数 + 单测（全量通过/变更单通过/混合文本中定位代码块/两种都不合法返回 null）。
- `applyGraphOps(graph, ops): GraphJson`：纯函数应用器（复用编辑器既有 `renameNode` 级边引用同步、`connectEdge`、`removeNode` 级联删边语义；`updateNode` 宽松补丁同 `patchNode`；新节点无坐标留给 `layoutOf`）。单测覆盖级联删边、rename 同步引用、patch 宽松语义。
- 卡片自动应用流程见上「变更清单卡片」节：消息级卡片解析 → 校验链 → 通过自动 `onApplyGraphOps` / `onApplyFullGraph` → 坐标合并（5b）→ `commitGraph`。
- **应用前完整校验链**：`applyGraphOps` 或全量替换产出候选图后，跑 `normalizeGraph`（自愈缺失 start 节点/死边）+ `validateGraph`（语义校验：唯一 start、边端点存在等）——失败则拒绝应用，候选问题列表渲染在卡片内（红色条目）+ 按钮禁用 + 次要 toast；通过才 `commitGraph` 落画布。

### 5b. 坐标保留（builder check 裁定）

AI 回传的 JSON 中 `position` 为可选字段，模型不一定回显。应用时按节点 id 合并：**存活节点保留画布原坐标**，AI 新增/未带坐标的节点交给现有 `layoutOf`/`autoLayout` 自动摆位。指令文本同步写明「未修改的节点必须原样保留其 position 字段」。用户手工整理的布局不因应用而打乱。

### 5c. 面板挂载与流式中断（builder check 裁定）

`useChatSend` 卸载即断流式监听（Stop 按钮失效）。因此右栏两 tab **切换与收起都只隐藏（CSS `hidden`）不卸载**，`GraphAiPanel` 与 `NodePropertiesPanel` 常驻挂载、按 activeTab/panelState 显隐——生成中切 tab/收起面板不打断流。

### 5d. 绑定生命周期（已改定）

`aiSessionId` 随图行存在：删图即绑定消亡（会话本身保留，同普通历史会话语义）——原「option 孤儿」挂账随之消解。会话被删时面板回写 `aiSessionId=null`（原清 option 行语义平移）。
- 应用成功后下条发送自然带新快照（§4），无需 reinject 按钮。文件窗的 reinject 按钮不搬。
- JSON 模式下用户也能粘贴 AI 输出（现有 canonicalJson 通道），不另做。

### 6. GraphEditorView 侧改动

- 右栏头部改 tabs；新增 `GraphAiPanel` 渲染分支；提供 `onApplyGraphOps` / `onApplyFullGraph`（已核验 `commitGraph` 签名 `(updater: (current: GraphJson) => GraphJson)` 且整体替换用法在 :630 已有先例）。
- 全量应用落图时先按 5b 做存活节点坐标合并 + `endPosition` 保留，再 `commitGraph`；**不**把 AI 原始 JSON 裸提交（zod 默认值以校验后对象为准）。
- 面板骨架（float/full 定位、圆角边框阴影）两 tab 共用；两 tab 常驻挂载、CSS `hidden` 显隐（5c）。

### 7. i18n

`src-react/i18n/locales/{zh-CN,en-US}/chat.json` 新增 `orchestration.editor.ai*`：tab 名、面板标题、收起/展开、新建会话、应用修改、应用成功、无可应用修改、未保存不可用、指令文本、快照前缀模板、快捷指令×2、超限降级提示。注意禁止顶层 key 与嵌套 key 重名。

## 留给 builder 的事项

- ChatPane 扩展点两个可选 prop：`buildSendPrefix?: () => string`（每条发送前调取并 prepend）与 `renderMessageExtra?: (message: MessageRecord) => ReactNode`（消息级卡片插槽，ChatMessages 透传）。均默认不传零行为变化。
- `graph:bindAiSession` IPC 通道签名与 repo 局部 update 实现（不触碰 graphJson）。
- `GraphAiPanel` 是否需要处理 `getById` 加载/错误态——照抄 FileChatPanel 两态（loading / 错误重试），不要落占位误导。
- 快捷指令最终文案（保持「解释 / 建议」两个不改图的纯问答）。
- 应用后选中节点被 AI 删除的 `selectedId` 清理边界。
- 单测：graph-ai-context 纯函数——`buildGraphAiInstruction` 拼装、`buildGraphContextPrefix` 快照/60k 降级、`extractGraphEdit` 全量/变更单/非法三态、`applyGraphOps`（级联删边、rename 同步边引用、patch 宽松语义、坐标合并）。

## 挂账（已知未尽事项）

- 大图全量注入 token 成本高 → 后续可换结构摘要 + 按需追问，或方案 B 增量 patch。
- 空会话回收未做。
- AI 面板在远程主机（server-face）场景不可用，本期不做能力探测。
- 真 agentic 工具循环改图（方案 C）留作远期。
