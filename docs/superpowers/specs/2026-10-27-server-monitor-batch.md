# 无头端监控面批（monitor/stats + 事件埋点）设计 spec

日期：2026-10-27
状态：直接开工（用户「继续推进」授权；monitor 批留档「无头端事件埋点移植与 monitor 端点（另批）」之兑现）
关联：mobile-monitor-batch（2026-10-25——移动端 /monitor 页连无头端时不可达的根因）；移动端差集清零后的能力补齐

## 0. 事实基线

- **移动端 /monitor 页按 capability 判定**：无头端 `CAPABILITIES` 无 `monitor` → 连无头端主机时监控页不可达（协议注释「仅桌面被控面实现，无头端不报即不可达」）。
- **mirror 面**：`monitor.repo.getStats`（7 天窗口 llm/tool 两查 + model 名补位）+ `computeMonitorStats` 纯函数（monitor-stats.ts 175 行）+ `monitor-events.ts` 埋点（**纯函数 + PrismaLike 注入、fire-and-forget 吞错**——可收编）；三处埋点：chat.service 轮次 usage/工具调用、graph-executor trace 收尾、automation-runner 390/403。
- **无头端**：无 llmCallEvent/toolCallEvent 表、无埋点、无端点。server chat-runner/graph-executor/automation-runner 为 mirror 移植副本（对应埋点位可同款接线）。
- **表结构**：两表均带 userId+createdAt 索引（聚合主路径）+ toolCallEvent 的 userId+toolName（排行分组）。

## 1. 本批裁定

1. **core 收编**（`@tianshu/core`）：`monitor-stats.ts`（computeMonitorStats）+ `monitor-events.ts`（recordLlmCall/recordToolCall/usageFromBlocks/buildGraphMonitorEvents——Log 依赖改静默 catch + 可选注入 warn 钩子，core 零依赖纪律）；mirror 原位 re-export（context-usage 先例）；mirror tests/ai/monitor-events.test 改直测 core。
2. **prisma 摘表**：server schema 增 llmCallEvent/toolCallEvent（逐字段 + 双索引照 mirror；server 无版本化迁移，ensureDatabase db push 即建）。
3. **server 三处埋点**（`void recordXxx(prisma, {...})` fire-and-forget 同款）：chat-runner.service（轮次 usage from blocks + 工具调用 done/denied/error）、graph-executor（trace 收尾 buildGraphMonitorEvents 一次写）、automation-runner（LLM 轮次 + 工具事件，scene='automation'）。
4. **端点 + capability**：`monitor/stats` POST（service 薄包三查 + compute；scene 可选过滤）+ 协议 `CAPABILITIES` 增 `"monitor"`（钉测试 CAPABILITIES 断言同步；移动端监控页对无头端连接自动出现，消费端零改动）+ SDK 契约 monitor 组入册（响应面顺带标注——@ApiWrappedOk）。
5. **测试**：server monitor 端点用例（空表零值/埋点行聚合/scene 过滤）；chat-runner 既有测试基建断言埋点行落库（一轮对话 → llm 行 usage 值 + tool 行 state）；mirror 收编面 monitor-events/stats 测试改 import 后零红。

## 2. 非目标（留档）

- 桌面被控端零改动（monitor face 端点已在）；移动端零改动（capability 驱动）。
- 监控页 UI 增强/告警面（只读聚合现状）。
- 历史数据回填（从启用时点起记）。

## 3. 风险

- 埋点写入量：fire-and-forget + 吞错（失败不影响主流程——mirror 同语义）；高频对话下 SQLite 写入（WAL 已开）可承受。
- 收编 core 后 mirror 原文件改 re-export——drift 巡检基线重置（收编对增删同步 manifest）。
