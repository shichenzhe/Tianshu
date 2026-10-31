# 混合检索与重排节点设计（hybridSearch + rerank）

日期：2026-10-30
状态：设计定稿，待实施排期（Phase 1 本期实施；Phase 2 设计定稿、下期实施）

## 背景与目标

工作流（编排图）节点库已有 `vectorize`（向量化入库）与 `vectorSearch`（语义检索，
内存余弦）两个检索类节点。目标：

1. **Phase 1**：新增 `hybridSearch` 节点——BM25 全文检索 + 向量检索 + RRF 融合，
   单节点覆盖 semantic / keyword / hybrid 三模式（对齐 Dify「知识检索」、Coze 知识库
   节点的用户心智模型）。
2. **Phase 2**：新增 `rerank` 节点——cross-encoder 重排，对接业界事实标准的
   `/rerank` 端点（Cohere/Jina/vLLM 兼容形态），独立于检索节点（组合式，可作用于
   任何检索来源的候选列表）。

## 业界方案综述（决策依据）

标准混合检索管线：**全文检索（BM25 稀疏）+ 向量检索（稠密）→ 融合（RRF）→
可选 rerank**。ES 8.x、Azure AI Search、Qdrant、Weaviate、LangChain、LlamaIndex
均为该形态。

- **全文引擎**：**纯 JS 内存 BM25**（Okapi，k1=1.5/b=0.75，Lucene 式 +1 平滑
  IDF）——LangChain `BM25Retriever`+`EnsembleRetriever` 的业界主流形态，零原生
  依赖零 SQLite 版本赌注，且与现有 `searchChunks`「全表读出+内存余弦」完全
  同构（SQLite 只当行存储）。**SQLite FTS5 已否决**（2026-10-30 实施期裁定）：
  双端 Prisma 驱动异构——mirror 走 `@prisma/adapter-better-sqlite3`（FTS5 可用），
  server 走 `prisma-client-js` 内置 engine（不编译 FTS5）且 alpine/musl 补装
  better-sqlite3 撞依赖铁律与构建风险；FTS5 虚表生命周期（建表/回填/单飞/
  optimize）相对内存检索是不对称复杂度。flexsearch 等外部引擎与 SQLite 数据面
  割裂，不可接受。
- **中文分词**：BM25 以词为 term，中文不切词则整句作单 term、IDF 失效。裁定用
  `Intl.Segmenter`（Node/Chromium 内建 ICU 词典，零依赖零原生编译，mirror 与
  server 双端可用，node 侧已实测）；@node-rs/jieba 为质量升级位（分词器抽单点
  函数，替换只动一处，但 +1 原生依赖须另行裁定依赖铁律）。
- **融合**：RRF（Reciprocal Rank Fusion，`score = Σ 1/(k + rank)`，k=60）为业界
  事实标准——只看排名不看分值，天然免疫余弦（0~1）与 BM25（无界）的量纲差异，
  无需调参（k=60 为论文值，与 ES `rank_constant` 默认一致，不做成参数）。加权
  归一化（Dify 可调权重做法）量纲敏感需校准，本期不做。
- **分数阈值（业界标配项的裁剪）**：ES `min_score` / Dify Score 阈值 / Azure
  threshold 均为标配，但 RRF 分数无量纲、阈值无意义（Dify 对 RRF 模式同样置
  N/A）；semantic 模式余弦与 Phase 2 rerank 的 relevance_score 均为 0~1 可阈值
  化——v1 不加参数，rerank 期评估 minScore（业界「rerank + 阈值」标准组合）。
- **rerank 端点形态**：Cohere Rerank 定形、Jina/vLLM/SGLang（BGE-reranker、
  Qwen3-Reranker）/SiliconFlow 兼容；DashScope 端点路径与信封形态有差异，
  兼容性以实测为准：
  `POST /rerank {model, query, documents[], top_n}` →
  `{results: [{index, relevance_score}]}`。

## 已裁定决策

| # | 决策 | 结论 |
|---|------|------|
| 1 | 数据面范围 | 本期只作用于 vectorize 入库的 vectorChunk 集合；资料库 librarySearch 语义化是独立一期 |
| 2 | 中文分词 | Intl.Segmenter（零依赖）；分词器单点抽象留升级位 |
| 3 | 节点形态 | 新增 hybridSearch 单节点（三模式），融合逻辑内置不暴露；老 vectorSearch 原样保留双轨 |
| 4 | 融合算法 | RRF 默认（k=60），不加权重参数 |
| 5 | rerank | 独立节点（非检索节点内置），Phase 2 实施但本期埋 hits 旁路 |
| 6 | rerank 模型挂接 | 复用 provider/model 体系，model.type 已预留 `reranker` 类型位，零 schema 变更 |
| 7 | 全文引擎（2026-10-30 pivot） | FTS5 否决（server Prisma 内置 engine 无 FTS5、双端驱动异构、musl 构建风险）→ 纯 JS 内存 BM25（LangChain BM25Retriever 形态，与内存余弦同构） |

## Phase 1：hybridSearch 节点（本期实施）

### 1. 节点 schema（`packages/tianshu-core/src/graph-schema.ts`，单份）

```
kind: "hybridSearch"
searchQuery: string          // {{}} 渲染
collection: string?          // 空串 = 全集合（对齐 vectorSearch 语义）
mode: "hybrid" | "keyword" | "semantic"   // 默认 hybrid
topK: int 1~50 默认 5
modelId: number?             // semantic/hybrid 必填（embedding）；keyword 不需要
timeoutMs                    // 同现有节点惯例
```

`modelId` optional + 执行时校验：keyword 用户零模型门槛；semantic/hybrid 缺失抛
`GraphNodeFailure`（错误码 `hybrid_model_missing`，人话提示）。老 `vectorSearch`
schema 与 handler 均不动，AddNodeMenu 两者并存（假设：双轨过渡，后续观察再决定
是否收编）。

### 2. 检索纯逻辑下沉 `packages/tianshu-core/src/retrieval.ts`（新增，单份三端）

零运行时依赖（Intl.Segmenter 为 Node/Chromium 内建），把最易漂移的逻辑从双份
文件抽走：

- `tokenize(text): string[]`——`Intl.Segmenter("zh-Hans", {granularity:"word"})`，
  仅保留含文字/数字的词元（标点/符号天然剥离）
- `rankBm25(queryTokens, docs, topK, k1=1.5, b=0.75): Bm25Hit[]`——Okapi BM25
  内存评分（公式见 §3），Lucene 式 +1 平滑 IDF；零命中剔除、按分降序切 topK
- `rrfFuse(vecHits, ftsHits, k=60): FusedHit[]`——按 chunkId 融合累加
  `1/(k+rank)`，融合后按分数降序
- FusedHit 形态：`{chunkId, sourceName, collection, text, score, rank}`（chunkId
  为融合键；两路结果都携带）

### 3. 全文检索数据面（`vector-store.ts`，mirror 与 server 双份薄改）

**内存 BM25，无持久化索引**（2026-10-30 pivot 裁定，见综述段）：`searchFts`
按 userId [+collection] `findMany` 读行（select 限定 id/collection/sourceName/
text，不拉 vector 大字段）→ 纯函数 `rankBm25(queryTokens, docs, topK)` 内存评分
→ 返回 FusedHit 形态。性能与现有全表余弦同量级（万级 chunk 毫秒级）：每次查询
全量分词评分、不做进程级索引缓存（YAGNI；十万级规模再演进为进程级倒排缓存，
vector-store 头注释的引擎升级位同样覆盖此路径）。

- **零 DDL/零迁移**：无虚表、无回填、无单飞——`upsertChunks` 完全不动（BM25
  每查询实时读行，天然与 vectorChunk 一致）。
- **评分公式**（`packages/tianshu-core/src/retrieval.ts` 单份纯函数）：
  `idf = ln(1 + (N - df + 0.5)/(df + 0.5))`（Lucene/ES 同款 +1 平滑防负），
  `score = Σ idf·(f·(k1+1))/(f + k1·(1 - b + b·len/avgLen))`，k1=1.5、b=0.75
  （rank-bm25/LangChain 默认）；term 为 `tokenize` 分词词元，中文按词命中。
- 停用词不额外处理：IDF 天然压低高频词权重（业界 BM25 实践同）。
- BM25 路不过滤 model（全文与 embedding 模型无关）；向量路保持同 model 过滤。
  两路集合不同源不影响 RRF（只看排名）。`searchChunks` 返回值增加 chunkId 字段
  （现有消费方只用 sourceName/score/text，不破坏）。
- 空词元短路：`queryTokens` 为空直接返回 `[]`（不发查询）。

### 4. 执行器 handler 与 hits 旁路（`graph-executor.ts`，双份）

`makeHybridSearchNodeHandler`：render → 按 mode 分路：

- keyword：分词 → `searchFts`（内存 BM25）
- semantic：`embedTexts`（复用现有）→ `searchChunks`
- hybrid：两路 `Promise.all` 并行；候选池各取 `max(50, topK×5)`，RRF 融合后切
  topK

输出文本形态对齐现有惯例（直连 AI 节点）：

```
【条目名｜相关度 0.87】片段文本     （hybrid/keyword 模式，RRF/BM25 分）
【条目名｜相似度 0.87】片段文本     （semantic 模式，余弦分）
```

空命中输出空串不炸图；searchQuery 渲染后为空/纯符号时 tokenize 产出空词元，
keyword 路直接短路返回空结果——hybrid 模式下向量路
照常（空串 embedding 仍可出语义结果），keyword 模式输出空串。hybrid
双路任一失败（如 embedding API 挂）即节点整体失败，**不做单路静默降级**（对齐
rerank 的显式失败哲学，防掩盖配置错误）。

**hits 旁路（为 Phase 2 rerank 预埋，Phase 1 实现）**：节点 state update 除
output 文本外挂 `hits` 结构化数组（即 §2 的 FusedHit 形态，含 score 与 rank）。
`toNodeUpdate` 扩展支持旁路字段；旁路字段名独立于 output，`renderNodePrompt` 的
`{{nodes.x.output}}` 模板取值互不干扰（实施时确认 renderNodePrompt 的 nodes 数据
面，不改模板语义）。trace 里 hits 序列化截断存储（防大 JSON 膨胀运行留痕）。

### 5. 前端 + i18n（单份，mirror 渲染层）

- `AddNodeMenu`：检索分组加「混合检索」
- `NodeCard`：图标 + 名称
- `NodePropertiesPanel` / `GraphNodeEditor`：mode 三态单选；模型选择器过滤
  `type=embedding`（与 Phase 2 reranker 过滤对称，防选到 llm 模型执行时才炸）；
  keyword 模式下模型选择禁用（视觉提示该模式无需模型）
- `graph-editor-model.ts` / `graph-canvas-model.ts`：kind 注册
- i18n：`chat` 命名空间 zh-CN / en-US 双语同步

### 6. 双份同步与测试

- 改动面：`vector-store.ts` + `graph-executor.ts` mirror↔server 双改；core 重建
  dist（server 侧 `npm run sync:core`）；drift 容差核算（vector-store/
  graph-executor 为 drift 活跃对，基线 217 行）
- 纯函数（tokenize/rankBm25/rrfFuse）：mirror vitest 直测（零 DB 依赖——
  BM25 纯函数化后 FTS 无真表交互测试需求，server jest 真表线整个取消）；
  tokenize 用例覆盖中英混合、专有名词、长句、空串等代表性样本；rankBm25
  用例钉住「双词命中 > 单词命中 > 零命中剔除」的排序语义与 IDF 平滑
- handler 级（mock prisma + fetch 打桩，先例 `tests/ai/graph-vector.test.ts`）；
  `test:e2e:graph` 冒烟补端到端（真 server 子进程跑 keyword 模式中文查询）
- **前置实证一项**（已过，2026-10-30）：`Intl.Segmenter` node 侧可用
  （server jest 实测）；Electron 主进程为 Chromium V8 内建 ICU，同 API 零风险。
  FTS5/Windows 复验随 FTS5 路线否决一并作废。

## Phase 2：rerank 节点（设计定稿，下期实施）

### 1. 节点 schema（core 单份）

```
kind: "rerank"
query: string            // {{}} 渲染（重排查询，可与检索时的 query 不同）
sourceNodeId: string     // 上游检索节点 id，消费其 hits 旁路
modelId: number          // model.type = "reranker" 的记录（表已预留类型位）
topN: int 1~50 默认 5
timeoutMs
```

`sourceNodeId` 显式引用（下拉选图中检索节点）而非 `{{nodes.x.hits}}` 模板表达式：
类型安全、UI 直观；任意 JSON 候选场景（jsonParse/code 节点产出）v2 再评估。
**执行顺序依赖**：图执行顺序由边决定，引用须经图边保证上游先执行（对齐 Dify
变量引用惯例）——用户配了引用但未连线时 hits 缺失，落入 `rerank_source_invalid`
报错并提示需连线，此为预期行为而非 bug。

### 2. 执行器（graph-executor 双份）

- render query → `loadModelRuntime(modelId)`（复用 embedTexts 同款解析）→ 校验
  model.type 为 reranker，不是则人话报错（`rerank_model_type`）
- 从 `state.nodes[sourceNodeId].hits` 取候选；无该节点或无 hits 旁路（老
  vectorSearch / 非检索节点）→ 明确错误码 `rerank_source_invalid`，提示改用
  hybridSearch
- fetch `${base}/rerank`（Bearer + extraHeaders + 超时/取消 AbortSignal.any 组装，
  全对齐 embedTexts 错误链路）：`{model: sdkId, query, documents, top_n}` →
  results 按 index 回挂元数据（sourceName/collection/text），relevance_score
  降序切 topN
- 输出文本 `【条目名｜相关度 0.87】片段`（relevance_score 0~1 语义明确）；
  rerank 自身同样挂 hits 旁路（形态沿用 FusedHit：score=relevance_score、
  rank=重排名次，下游可再加工）
- 边界：候选空 → 透传空输出；documents 上限 250（对齐融合候选池），超限截断
  并在 trace 标注；单文档超 2000 字符截断（chunk 500 字天然安全，防御手动
  构造的旁路数据）
- 不做静默降级（API 失败退回原序会掩盖配置错误，显式失败对齐现有节点哲学）

### 3. 前端 + 测试

- 模型选择器过滤 type=reranker（embedding 选择器同款模式）；sourceNodeId 下拉
  列图中检索类节点；i18n 双语
- handler 薄（fetch + 映射）：mock fetch 单测（mirror vitest）；e2e:graph 补段

## 后续路线图（本期不做，防堵死）

1. 资料库语义化（librarySearch 升级走同一检索底座）
2. sqlite-vec 向量升级 / 远端向量库（vector-store 头注释已预留接口位）
3. 查询改写节点（multi-query / HyDE）
4. 加权融合参数（若 RRF 实测不满足再评估）

## 假设与开放问题

- **假设**（已向用户呈现并认可）：双轨保留 vectorSearch；rerank 排期下期但旁路
  本期埋；不加权融合参数。
- **假设**：`Intl.Segmenter` 双端可用（node 已实测，Electron 内建 ICU 零风险）。
  移动端 Hermes 支持未实测——`tokenize` 采用**惰性初始化** Segmenter 单例
  （首调创建），移动端 bundle 加载 core barrel 时不执行任何 Intl 构造，
  非检索链路零风险；移动端若未来接入检索，届时实测再放行。
  ~~better-sqlite3 预编译含 FTS5~~ 已随 FTS5 路线否决作废（2026-10-30 pivot，
  见综述段）。
- **对齐现状（非本期范围，防误判为遗漏）**：图执行链路不写 llmCallEvent 等
  监控事件（监控覆盖聊天链路），hybridSearch 的 embedding 调用对齐现状；图无
  导入/导出/复制功能（graph.repo.ts 查证），节点 kind 无跨版本分发面，老版本
  兼容场景不存在。
- **开放**：graph-templates.ts 是否补 RAG 模板（不扩本期范围，实施后视情况）；
  手动重建 FTS 索引入口（Dify 有「重建索引」按钮，我们 count 对比自动兜底已
  够，UX 糖 v1 不做）；~~rerank 期评估 minScore 阈值参数~~ 已关账（2026-10-31
  rerank 落地时显式关账：v1 未实现，保持 defer——minScore 评估随首个真实
  reranker 配置进行）。

## 影响面清单

| 文件 | 份数 | 变更 |
|------|------|------|
| `packages/tianshu-core/src/graph-schema.ts` | 单份 | hybridSearch + rerank schema、FusedHit 类型；重建 dist |
| `packages/tianshu-core/src/retrieval.ts` | 单份（新增） | tokenize / rankBm25 / rrfFuse 纯函数 |
| `electron/domains/ai/orchestration/vector-store.ts` | 双份 | searchFts（内存 BM25 读行评分）、searchChunks 加 chunkId |
| `electron/domains/ai/orchestration/graph-executor.ts` | 双份 | makeHybridSearchNodeHandler（Phase 2 加 rerank handler）、toNodeUpdate 旁路 |
| `src-react/domains/ai/orchestration/*` | 单份 | 节点注册 + 属性面板 + 模型选择器；`GraphTestRunDialog`/`GraphRunTraceView` 确认零适配（预期泛化渲染） |
| `src-react/i18n/locales/{zh-CN,en-US}/chat.json` | 双语 | 节点文案 |
| server 侧 `src/core/graph/` 对应副本 | 双份 | 与 mirror 同步改 + drift 容差核算 |
| 测试 | — | core 纯函数 + handler mock 单测（mirror vitest）、e2e:graph 冒烟 |
