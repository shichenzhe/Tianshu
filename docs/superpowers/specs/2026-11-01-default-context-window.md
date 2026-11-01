# contextWindow 空配置兜底 128K 设计 spec

日期：2026-11-01
状态：已批直接开工（对话内用户「默认 128K 吧」授权；收敛清单第 1 项）
关联：上下文瘦身调研（对话内实测：model 表 6 模型 contextWindow/maxTokens 全 NULL，会话 7 单轮 input 失控至 672 万 token）

## 0. 事实基线

- `truncateHistory`（contextWindow undefined → 不截断）、自动压缩（阈值 0.8×contextWindow，probeSendCost 中 `?? 0` → 恒 null → 永不触发）、getUsageBreakdown 面板分母（null → 前端显示 --）三消费均以 model.contextWindow 为据，NULL 即全失效。
- 前端已有同语义缺省：ModelDialog 新建预填 131072 + model-summary 默认判定 `!== 131072`（src-react/domains/ai/provider/lib/model-summary.ts:6）——存量 NULL 模型多建于该预填机制之前或经同步链写入。

## 1. 本批裁定

1. **core 单点常量**：`DEFAULT_CONTEXT_WINDOW = 131_072`（packages/tianshu-core/src/param-merge.ts）——1024 进制 128K，与前端既有缺省同数（128000 会造成同概念两数打架：摘要「仅显示非默认项」判定失真）。
2. **消费侧兜底（DB 仍存 NULL）**：默认语义单点可调，不写死存量数据。
   - mirror chat.service：probeSendCost（`?? 0` → `?? DEFAULT_CONTEXT_WINDOW`）、streamAndPersist→runChatStream 截断入参（`?? undefined` → 兜底）、getUsageBreakdown 分母（`?? null` → 兜底，面板显示生效值 128K）。
   - server chat-runner.service：assembleContext 源头一处兜底（截断/usage 两消费同源）。
3. **前端零改动**（预填与默认判定已同数）；纯函数 computeUsageBreakdown/truncateHistory 的 null/undefined 透传语义不动（兜底在调用侧，context-usage.test 的 null 语义用例保留）。

## 2. 非目标（留档）

- DB 存量数据回填 131072（不做——NULL=默认语义可调）。
- 按模型 id 识别真实窗口（如 qwen/glm 家族查表预填）——后续产品化可做。
- maxTokens 空配置兜底（estimateReserveTokens 已有 4096 兜底）。

## 3. 风险

- 真实窗口 < 128K 的模型（如本地 8B 部署 32K）按 128K 截断会超窗报错——用户可在模型配置显式填写真实值覆盖；128K 是多数主流模型下限基线。
