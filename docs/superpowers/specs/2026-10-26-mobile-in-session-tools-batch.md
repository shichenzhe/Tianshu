# 移动端会话内搜索 / compact / 润色批（A9）设计 spec

日期：2026-10-26
状态：调研完成（Explore A8–A11 合并摸底），按最小增量实施
关联：差集 spec `2026-10-25-mobile-desktop-gap.md`（A9 条目）；P1 批 session 域扩展先例；spec 建议拆三阶段，消息搜索先行

## 0. 调研关键发现

- **桌面消息搜索纯渲染层**：只取 text blocks `\n` 拼接（剔除文件引用前缀），大小写不敏感非重叠匹配；排除 system 消息；搜索时自动拉全历史保证计数；250ms 防抖 + Enter 循环导航（MessageList.tsx:58-67、search-highlight.tsx、SessionSearchBox.tsx）。
- **被控面 `session/getById` 已全量返回 blocks**（桌面最多 500×200 条内部拼全；无头端同全量）——移动端 loadHistory 后 stream.store 持有完整 ChatMessage[]（含真实 id）——**本地搜索零协议改动**。
- **compact 桌面链路**：`chat:compact(sessionId)` → 清旧压缩态 → 压缩指令走普通 sendRound → 取最新 assistant 文本 → 写 `session.summary` + `session.compactedUpToId`（不删旧消息；中止不回填）（chat.service.ts:1033-1106）。
- **compact 无头端只有读态**（chat-runner 按 id>compactedUpToId 取历史）——**写链路需移植**。
- **polish 桌面链路**：`chat:polish {workspaceId,text,style}` → LLM invoke（30s 超时；模型=workspace 默认模型否则首个启用模型；不落库不建会话）（chat.service.ts:2272-2335）；无头端无。
- **遥控投影丢字段**：桌面 remote-session.ts 丢弃 summary/compactedUpToId 且包成 hasMore:false——HD 遥控通道需补透传。
- SDK：session 组在 sdk-contract 自动覆盖数组——session/compact、session/polish 入 ENDPOINTS 即自动要求 POST 实现。

## 1. 本批裁定（三阶段）

### 阶段 1：会话内消息搜索（零协议改动）
- 移动端本地实现：会话页搜索框（250ms 防抖），对 stream.store 现 history 做匹配——规则与桌面一致（仅 text blocks 拼接、大小写不敏感、非重叠、排除 system）。
- 命中数 + 上/下导航 + 命中消息滚动定位（RN ScrollView scrollToIndex 或退化为高亮+计数 v1）。i18n 双语。
- **纯 mobile 阶段**，不动协议/双端。

### 阶段 2：session/compact
- `ENDPOINTS.session.compact: "session/compact"`，载荷 `{sessionId}`。
- **异步语义（对齐 send 先例）**：POST 立即 202 受理 → 被控端异步执行 → 完成后 publish `session.updated`（enriched 口径）——移动端订阅事件后重拉 getById 刷新压缩条。同步 await 有 HTTP 超时风险，不用。
- 桌面 face：routes 包装 chat.service.compact（既有实现零改动）。
- 无头端：**移植 compact 写链路**——清旧态 → 压缩指令 sendRound → 写 summary/compactedUpToId；语义逐行对齐桌面（中止不回填）。复用其 chat-runner 的 round 机制。
- 协议投影：RemoteSessionRow/remote-session.ts 补 `summary`/`compactedUpToId` 透传（spec §1 增列）；移动端 SessionBrief 或会话详情消费压缩提示（v1 仅透传+会话页提示条，可选展示摘要轮）。

### 阶段 3：session/polish
- `ENDPOINTS.session.polish: "session/polish"`，载荷 `{workspaceId?, text, style}` → `{text}`；同步 30s 超时（对齐桌面 AbortSignal.timeout(30_000)）。
- 桌面 face：包装 chat.service.polish。无头端：移植（模型解析同语义：workspace 默认模型 → 首个启用模型；provider type/baseUrl/apiKey/extraHeaders）。
- 移动端：新任务页/会话输入区加「润色」入口（style 固定 professional，对齐桌面现状；替换草稿文本）。

### 非目标
搜索 thinking/工具输出块（桌面也不搜）；全局跨会话搜索（遗留 message:search 前端已移除，不复活）；compact 摘要轮完整 UI（桌面有，移动端 v1 提示条即可）。

## 2. 测试与验收
- 阶段 1：移动端搜索纯逻辑钉测试（拼接规则/大小写/非重叠/system 排除/文件引用前缀剔除）+ 导航计数。
- 阶段 2：桌面 face 用例（202 受理/事件发布/参数校验）；无头端 compact 写链用例（摘要写库/compactedUpToId/中止不回填，照桌面 chat.service 测试口径）；SDK 自动覆盖。
- 阶段 3：双端 polish 用例（mock LLM 30s 超时/模型解析回退链）；SDK 自动覆盖。
- 根 typecheck + 双仓全量绿；分阶段提交。

## 3. 风险
- **compact 无头端移植量最大**：round 机制两仓形态不同（chat.service vs chat-runner.service），移植时以桌面行为为 golden，不重构无头端 runner。
- **polish 30s 同步窗口**：relay 帧与 HTTP 均需容忍长响应；超时错误口径 5000 + 有用 message。
- **事件乱序**：compact 完成事件与 message.chunk 乱序到达，移动端以重拉 getById 为准（刷新信号语义，同 automation.changed 先例）。
