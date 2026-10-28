# 天枢移动端消息渲染对齐（MR 批）

- 日期：2026-10-23
- 状态：设计定稿（对话内已批），待写实施计划
- 前置：MB 批（图片/分组/重生成）、LT/MT 批（编辑重发/权限/用量胶囊等）、
  file-ref 卡片批（1ef4104a）
- 上游盘点：2026-10-23 移动端能力对齐盘点——消息渲染面为「模型已产出、
  移动端看不见」的信息丢失级缺口，优先级最高

## 1. 背景与目标

**问题**：模型产出的下列内容在移动端不可见或错渲染——

- `show_widget` 可视化（模型经工具输出 HTML/JS 图表）：移动端落进通用
  ToolCallCard，HTML 代码当工具输出文本，图表看不到
- `recommend_experts` 专家推荐卡：同上，只看到工具名与原始 args
- 伪工具调用碎片（本地服务不支持结构化 tool_calls 时的模型文字仿冒）：
  直接进 Markdown 渲染成乱文
- 流式期间无 Agent 进度行（准备中/回复中/轮次+当前工具）
- 会话写了哪些文件（write_file 产物）无从查看（桌面 DetailPanel 产物 tab）

**关键事实（协议零改动依据）**：块协议共享（`@tianshu/protocol`
chat-contract.ts，MessageBlock 五类）；widgets/recommends 是 tool_call 块按
toolName（`show_widget` / `recommend_experts`）的**渲染层分流**；移动端
`logic/group-blocks.ts` 已同构双份（分组定义与常量已在，仅渲染层未消费）；
流式链 `liveBlocks` 同样产出 tool_call 块——分流对流式期自动生效。

## 2. 任务表

| # | 能力 | 桌面实现 | 移动端落地 |
|---|---|---|---|
| MR-T1 | show_widget 可视化 | WidgetRenderer（iframe 沙箱 + postMessage 高度上报） | WidgetCard（react-native-webview 沙箱 + injectedJS 高度上报） |
| MR-T2 | 专家推荐卡 | ExpertRecommendCard（市场模板建专家 + 绑定会话） | RecommendCard 只读展示（添加动作裁剪，见 §4） |
| MR-T3 | Agent 流式进度行 | AgentProgress（扫光文字 + 轮次 + 工具名） | 简化版（ActivityIndicator + 文字），替换现有 sending 占位行 |
| MR-T4 | 伪工具调用警示 | PseudoToolCallNotice 折叠条 | 检测函数移植 + 折叠条 |
| MR-T5 | 代码块复制 | CodeBlock 复制按钮 | MarkdownLite code 节点长按复制 |
| MR-T6 | 会话产物文件视图 | DetailPanel 产物 tab（deriveSessionFiles 纯派生） | 会话页头部入口 → sheet 列表，点行 files/read 读内容 |

## 3. 设计

### 3.1 MR-T1 WidgetCard（widget 沙箱渲染）

- **分流点**：`MessageItem` 的 `BlockView` 在 tool_call case 按 toolName
  分流——`WIDGET_TOOL_NAME` 自既有 `logic/group-blocks.ts` 常量。块级分流
  保序渲染，不把 assistant 整体改造为 grouped 结构（移动端现状逐块渲染，
  视觉语义与桌面一致：消息流正文位渲染，不进思考面板）
- **依赖**：`react-native-webview`（Expo Go SDK 57 内置，`npm install -w`
  装入 mobile）
- **沙箱文档**：`buildWidgetSrcDoc` 纯函数双份移植（桌面
  WidgetRenderer.tsx 内函数 → `mobile src/logic/widget-srcdoc.ts` + 单测）。
  不收编共享包：`@tianshu/core` 带 langChain peer 不宜引；同 file-refs
  双份先例（两端注释互指）
- **高度自适应**：`injectedJavaScript` 注入桌面同款 RESIZE_BOOTSTRAP
  （postMessage `{source:"widget",type:"widget:resize",height}`）；
  RN 侧 `onMessage` 解析 `event.nativeEvent.data`（string → JSON.parse），
  clamp 40–800，初值 120
- **状态语义照搬桌面**：running / awaiting-approval → 标题栏 + 加载占位；
  其余一切态（done/denied/error）→ 一次性注入沙箱。标题栏 BarChart3 +
  title（无标题走 i18n 通用文案）
- **WebView 隔离**：`javaScriptEnabled` + `source={{ html }}`；RN WebView
  为独立原生视图（无同源共享），安全语义不弱于桌面 iframe sandbox=
  allow-scripts；沙箱文档 CSP 同款移植

### 3.2 MR-T2 RecommendCard（只读推荐卡）

- 形态：reason 文本 + slugs 胶囊行 + 脚注「请在桌面端添加」（i18n）
- **不做**已添加收敛判定（桌面 sourceSlug 命中）：assistant/query 行
  slug 字段面未确认 + 历史消息中推荐卡会长期存在、收敛态易过期误导
- 命中分流的块（recommend_experts tool_call）不再渲染通用 ToolCallCard

### 3.3 MR-T3 AgentProgress（流式状态行）

- **派生纯函数** `logic/agent-progress.ts` + 单测：入参
  `RemoteStreamState`（remote-stream.ts 既有：text/thinking/toolOrder/
  tools），出参 `{ preparing, stepCount, activeTool }`——
  preparing = 三者皆空；stepCount = toolOrder.length + 1；activeTool =
  最新 running / awaiting-approval 工具名
- **位置**：倒置列表（index 0 = 最新）中 live 行之后；**替换**
  `[id].tsx` 现有 `sending && !streamStarted` 占位行（现占位仅覆盖
  preparing 态，本任务吸收并扩展）
- 动画简化：ActivityIndicator + 文字（不移植桌面扫光文字；RN 端动效
  成本高、信息等价）

### 3.4 MR-T4 PseudoToolCallNotice（伪工具调用警示）

- `detectPseudoToolCallText` 纯函数双份移植（桌面
  `lib/pseudo-tool-call.ts` → `mobile src/logic/pseudo-tool-call.ts`）+
  单测（检测规则照搬）
- `BlockView` text case 先检测：命中则渲染折叠条（Pressable 展开/收起，
  原文保真不进 MarkdownLite），未命中走 MarkdownLite

### 3.5 MR-T5 代码块长按复制

- MarkdownLite code 节点外包 Pressable：`onLongPress` →
  `expo-clipboard.setStringAsync(code)` + toast「已复制」（既有 toast-bus）
- 不加语法高亮（裁剪，见 §4）

### 3.6 MR-T6 会话产物文件 sheet

- `deriveSessionFiles` 纯派生移植（桌面 `chat/lib/artifacts.ts` →
  `mobile src/logic/session-files.ts` + 单测）：产物文件 = write_file
  tool_call（state=done）的 args.path；工作空间文件 = user 消息
  `[引用文件 x]` 行首前缀；同 path 去重、messageId 降序。流式合并分支
  照搬（live tools 的 running→writing / done→written）
- 数据源：会话页已有 history（getById 定稿）+ live；不新增拉取
- **UI**：会话页头部入口（有产物才渲染）→ Modal sheet（视觉对齐
  PlusSheet/SessionActionsSheet 既有形态）：两组列表（产物文件 / 工作
  空间文件），行=path
- **点开**：`ENDPOINTS.files.read` 既有——sheet 内点行再拉内容，文本
  预览（超长截断 + 全文复制）；非文本/读取失败降级提示
- i18n：`chat.json` 双语新增 key

## 4. 裁剪项（本批不做，留档）

- **artifact 作品收藏面板**：需 face/server 透出 artifact 端点（协议扩
  面）+ favorite 面管理，另行立批
- **推荐卡「添加并启用」**：需 assistant/save 端点 + marketplace 模板
  下发，远控协议均无；扩协议另行立批
- **会话内搜索 + 命中高亮**：会话面能力，价值次优先，不在本批
- **Markdown 语法高亮**：RN 高亮库成本高收益低

## 5. 风险与假设

1. react-native-webview 在 Expo Go SDK 57 内置可用（假设成立；dev client
   场景依赖树本地化——nativewind 99.9% 卡死教训，装包后跑恢复脚本口径
   核对）
2. WebView postMessage → RN onMessage 的 `event.nativeEvent.data` 为
   string（JSON.parse 口径）；防串扰（桌面 e.source 比对）在 RN 侧按
   webview 来源天然隔离，无需比对
3. 倒置列表 AgentProgress 插入位置的视觉语义（inverted 反直觉），实施
   计划精确到 index；真机验证
4. 测试口径：纯函数 vitest（srcdoc 构造 / 伪调用检测 / 进度派生 / 产物
   派生）+ `npm run typecheck -w apps/tianshu-mobile`；视觉组件真机
   手测（mobile 现状无 UI 测试框架）
5. i18n：`src/i18n/locales/{zh-CN,en-US}/chat.json` 双语同步
6. mobile 测试跑法：`npm run test -w apps/tianshu-mobile`
