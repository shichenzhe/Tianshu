# markdown 源位置追踪批（桌面搜索高亮口径统一）设计 spec

日期：2026-10-26
状态：直接开工（事实面已核实，Explore 纠偏两处置信假设）
关联：A9 批/精修批搜索面收口；移动端位置级契约先例

## 0. 事实基线（Explore 核实）

- **桌面已有逐命中高亮**（`search-highlight.tsx` 的 `<mark data-hit-index>` + 当前实底/余半透明 + scrollIntoView 逐位导航），但口径是「原始 Markdown 源文本计数（MessageList.tsx:58-67 拼 text 块 block.text）+ 渲染后 ReactNode 递归着色（highlightChildren）」双计数——代码块、链接 URL、Markdown 标记处计数与落点漂移；伪工具调用块计数但无落点（已知无落点分支）。
- **渲染管线**：MessageItem → MarkdownView（react-markdown + remark-gfm）→ createMarkdownComponents 主题组件 → 围栏分流 CodeBlock（Shiki dangerouslySetInnerHTML）/MermaidBlock。**当前管线未读取 mdast/hast position**。
- **core 块**：只有 text/thinking/usage/tool_call/image 五型，无独立 markdown/code 块——Markdown 语法构造都是 text 块内构造；块结构无源偏移字段。
- **移动端位置级契约先例**（`apps/tianshu-mobile/src/logic/message-search.ts:77-84`）：`{messageIdx, blockIdx?, start, length}`——blockIdx 为原始 blocks 数组下标，start/length 为块内原始文本偏移；命中块降级纯文本高亮。桌面复用语义契约，不复用降级呈现。
- **验收铁律**：每一个计入 totalHits 的位置级命中都有唯一可滚动可见落点；不满足者显式消息级降级，不静默丢失。

## 1. 本批裁定

### 1.1 位置级命中集合（唯一计数口径）
- search-highlight 纯函数升级：对每 text 块产出 `{blockIdx, start, length}[]`（块内原始 block.text 坐标，大小写不敏感非重叠，与移动端契约同形）；文件引用前缀剔除后偏移换算回原始块坐标（同移动端 message-search.ts:104-143 手法）。
- **可映射命中**：普通文本、段落、标题、列表、引用、表格单元格、强调/删除线、链接显示文字、行内代码——这些 hast 文本节点可经 position 映射回源偏移。
- **排除出位置级集合**：围栏代码/Shiki/mermaid、Markdown 图片/链接 URL/纯标记无可见落点、伪工具调用折叠条、thinking/tool_call/usage/image 块（维持不搜索）。排除后 totalHits 只含可映射命中——计数与落点天然一致。

### 1.2 渲染映射
- MarkdownView 搜索态：**经 hast position 映射着色**。实施先验证 react-markdown 当前版本组件能否拿到 hast 节点 position（rehype 插件把 `position.start.offset`/`end.offset` 注入 properties 或自定义组件取 node）——**若 position 不可得，停下报告主会话，不回落双计数旧路**。
- 文本节点按命中区间切分包 `<mark data-hit-index>`；块前命中前缀和改为读位置级数组（不再累计计数）。
- user 气泡维持现有纯文本高亮（坐标换算复用位置级数组）。
- Shiki 围栏/mermaid 不高亮（已排除出集合，无落点缺失）。

### 1.3 导航与状态
- store 升级为位置级命中数组（`hits: {messageIdx, blockIdx, start, length}[]`），activeIndex 循环导航语义不变；scrollIntoView 按 data-hit-index 不变。
- 250ms 防抖/⌘F/收起清空等行为不变。

### 1.4 非目标
- 围栏代码内 token 级高亮（Shiki 源偏移另批）；移动端不动（已位置级）；搜索范围不扩 thinking/tool 块。

## 2. 测试与验收
- 纯函数：位置级产出（多命中/跨块/引用前缀换算/大小写/非重叠/排除项不产出）；totalHits=可映射数。
- 渲染：react-markdown 搜索态——段落/标题/列表/链接显示文字/行内代码命中落 mark 且 data-hit-index 全局序正确；代码块内命中不计数；伪工具调用条不计数。
- 导航：跨块跨消息 active 序与 scrollIntoView 选择器不变。
- 既有 search-highlight/MessageList/session-search 测试改造零红；`npx vitest run tests/ai/ tests/layout/` + 根 typecheck + prettier；分提交。

## 3. 风险
- **react-markdown 版本 position 可得性**：v9+ 组件 props 形状需实证——先写 spike 验证再铺实现；不可得则停报（备选：remark 插件在 mdast 层建源偏移索引表，组件按内容反查，准确率降级方案须经主会话裁定）。
- 流式 liveMessage 期间高亮按现语义（不参与）不动。
- 性能：长消息位置映射每次渲染计算—— memo 按 (text, query) 缓存。
