# 资料库（Library + RAG）技术方案

> 调研基线：main @ 995bf652（2026-11-05）。文中路径均相对仓库根；桌面端代码位于
> `apps/tianshu-desktop/`，服务端 `apps/tianshu-server/`，移动端 `apps/tianshu-mobile/`，
> 共享包 `packages/tianshu-protocol`、`packages/tianshu-core`。所有函数名/字段名/常量
> 均出自当前代码，未实现能力如实标注。

## 1. 模块定位与总览

资料库是「文件管理 + 向量检索（RAG）」双面模块：

- **文件管理面**：类网盘的文件夹/文件/链接三级条目树，DB 为真相源 + 磁盘 ID 寻址存储
  （`{dataRoot}/library/{itemId}/{原文件名}`）。桌面端 18 个 IPC 通道
  （`library:list/search/createFolder/createFile/importFolder/addLink/rename/move/delete/
  addFiles/uploadFileBuffer/tree/writeFileContent/toggleFavorite/markViewed/listRecent/
  listFavorites/revealItem/subtreeCount`），前端路由 `/module/ai/library`
  （`src-react/routes/index.tsx` L223 `path: "library"`）。
- **RAG 面**：向量化入库与检索并非资料库页的内建功能，而是拆成两层——
  1. **图编排节点族**（`packages/tianshu-core/src/graph-schema.ts` 节点 union 中的
     `docExtract / vectorize / vectorSearch / hybridSearch / rerank / librarySearch` 六种节点），
     由 `graph-executor.ts` 执行，落库到 `vectorChunk` 表；
  2. **chat 工具 `library_search`**（桌面与 server 各一份实现，同名不同形态，见 §3.3）。
- **写侧自动向量化两端已统一**（server 2026-11-02 批、桌面批2 2026-11-05
  跟进）：资料库写面（server `uploadFile/writeContent`、桌面
  `addFiles/uploadFileBuffer/writeFileContent`）写成功后 fire-and-forget
  向量化到 `library` 集合，编排本体单份在 `@tianshu/core`
  `vectorizeLibraryContent`（db/embed/upsert 必填注入面，两端接线壳补平台
  缺省）；失败哲学两端同源——skip+日志绝不炸写面（原 §6 P0-1 缺口已闭合）。

模块跨五处分布：

| 端 | 位置 | 角色 |
|---|---|---|
| 桌面主进程 | `electron/domains/ai/library/`（library.repo.ts / library.utils.ts） | 文件管理仓储 + IPC |
| 桌面编排 | `electron/domains/ai/orchestration/vector-store.ts`、`graph-executor.ts` | 向量存取/节点执行 |
| 桌面渲染 | `src-react/domains/ai/library/`（api/components/views/lib） | 上传/列表/预览/编辑 UI |
| server | `src/modules/library/`（controller/service/module/dto）+ `src/core/library/`（repository/tools/vectorize） | 无头端资料库面 + 写侧向量化 + 语义检索工具 |
| 移动端 | `src/app/library.tsx` | 遥控桌面资料库（capability 门禁） |

## 2. 数据模型

定义于 `apps/tianshu-desktop/prisma/schema.prisma`（server 经 golden 移植同构消费）。

### 2.1 libraryItem（L414-432，文件树）

```prisma
model libraryItem {
  id           Int      @id @default(autoincrement())
  parentId     Int?              // 树形，null=根层
  name         String            // 同层唯一（uniqueDbName 序号去重）
  kind         String            // "folder" | "file" | "link"
  fileType     String?           // 扩展名分类表推断（classifyFileType）
  mimeType     String?           // mimeOf 推断
  size         Int?
  originalPath String?           // 拷贝入库的源路径；上传固定 "upload"
  url          String?           // 仅 link 条目，http(s) 校验
  favorite     Boolean  @default(false)
  lastViewedAt DateTime?         // 预览/打开打点（NEW 标记随其消失）
  userId       Int?              // 多用户隔离
  @@index([parentId])
  @@index([userId], map: "libraryItem_userId_index")
}
```

folder/link 无磁盘实体（纯 DB 行）；file 的磁盘路径是**派生值**
`path.join(libraryDir(), String(id), name)`（`toClientItem`，前端契约字段 `storagePath`），
rename/move 撞名必须磁盘双写（`renameDiskThenDb` 断裂补偿），这是本表最重要的不变量。

### 2.2 vectorChunk（L464-477，向量块）

```prisma
model vectorChunk {
  id         Int      @id @default(autoincrement())
  userId     Int?
  collection String            // 集合名；server 资料库专用 'library'
  sourceName String            // 条目名（检索回联 libraryItem.name 的键）
  seq        Int               // 条目内块序号
  text       String            // 块文本
  vector     String            // JSON.stringify(number[])——不是 BLOB 二进制
  model      String            // String(modelId)，embedding 模型标识（维度混用防线）
  createdAt  DateTime @default(now())
  @@index([userId, collection])
  @@index([userId, model])
}
```

schema 头注释原文裁定 v1 形态：**「embedding 分块落库，vector 存 JSON number[]，检索全量
载入内存余弦（桌面单机万级 chunk 够用；sqlite-vec 为后续升级路径——同库加扩展，
VectorStore 接口不变）」**。即：**无向量索引、无维度列、无 FTS 虚表**，检索是全表
`findMany` → `JSON.parse` → 内存余弦全扫。server 的 PG 后端另有一张物理分身的
`tianshu_search.vector_chunk`（§4.2）。

### 2.3 embedding 模型来源

`model` 表 `type` 列值域 `"llm | embedding | tts | reranker | asr"`（schema 默认 `"llm"`）。
向量化统一走 **OpenAI 兼容 `POST {baseUrl}/embeddings`**（`embedTexts`，
`graph-executor.ts` L3542）：Bearer 鉴权 + provider 级 extraHeaders、
`EMBED_BATCH_SIZE = 16` 分批串行防限流、按返回 `index` 归位防乱序。维度由服务商模型
决定，代码不感知。

## 3. 核心技术方案

### 3.1 入库链路（解析 → 切块 → embedding → 落库）

**路径 A：图节点手动链（desktop 与 server 同构）**

```
docExtract 节点（makeDocExtractNodeHandler）
  └─ extractDocumentText（orchestration/doc-extract.ts）
       ├─ 纯文本直读：txt/md/markdown/csv/log/yml/yaml/toml/json/html/xml
       ├─ PDF：pdf-parse v2（new PDFParse({data}).getText()，懒加载）
       └─ Word：mammoth extractRawText（仅 .docx，丢格式）
vectorize 节点（makeVectorizeNodeHandler，graph-executor.ts L3605）
  ├─ chunkText(text, chunkSize=500, chunkOverlap=100)   // @tianshu/core retrieval.ts
  │    递归字符切分（批2 升级）："\n\n"→"\n"→"。"→" " 层级回退，同级相邻
  │    子段按该级分隔符贴回（句子带句号/段落带换行），全部层级切不动退
  │    固定字符窗口+重叠（v1 兜底）；每块 ≤ size 硬不变量，overlap 以旧块
  │    尾部整段子块携带；两端 vector-store 再导出同源消费
  ├─ embedTexts(node.modelId, chunks, AbortSignal.any([ctx.abort, timeout 120s]))
  └─ upsertChunks（vector-store.ts）：$transaction 内同
       userId+collection+sourceName deleteMany → 逐块 create（重跑幂等）
```

节点参数（`vectorizeNodeSchema`，graph-schema.ts L582）：`collection/sourceName/text/modelId/
chunkSize(100-4000，默认 500)/chunkOverlap(0-500，默认 100)/timeoutMs`。

**路径 B：资料库写面自动链（两端同构，编排单份在 `@tianshu/core`）**

编排本体 `vectorizeLibraryContent`（`packages/tianshu-core/src/library-vectorize.ts`，
批2 自 server 收编三端单份；db/embed/upsert 必填注入面）——两端接线壳：
server `src/core/library/library-vectorize.ts`（db=graphExecutorRuntime、
embed 动态引 graph-executor、upsert 含 PG 路由）、桌面
`electron/domains/ai/library/library-vectorize.ts`（db=进程 prisma、embed 同
动态引、upsert=vector-store 真身、onSkip=Log.warn）。挂载点：server
`LibraryService.uploadFile/writeContent`、桌面 `LibraryRepository.
addFiles/uploadFileBuffer/writeFileContent`（repo 即桌面 IPC 面，无独立
service 层），写成功后 fire-and-forget：

1. `isTextualContent` 白名单判定（`mimeType` 以 `text/` 开头，或 `fileType` ∈
   `txt/md/markdown/code/json/csv/log/yaml/yml/xml/html`）——**binary/image/office 一律
   跳过**（两端上传的 PDF/docx 不经 docExtract，不入向量库）；
2. `chunkText(content)` 缺省 500/100（递归切分，批2 升级）；桌面另有 3MB
   读回上限（对齐 server uploadFile 上限，超限文本不自动向量化）；
3. 缺省 embedding 模型：`model.findFirst({ where: { enabled: true, type: 'embedding' },
   orderBy: { id: asc } })`（确定性取第一个启用的）；
4. `embedTexts` → `upsertChunks`（collection 固定 `LIBRARY_VECTOR_COLLECTION = 'library'`，
   `sourceName` = 条目名）。

失败哲学（core 头注释原文）：「非文本内容/无可用 embedding 模型/embed 失败一律跳过 +
日志，绝不炸写面」。删除/改名联动清块：两端 delete 先取行名 → 清块 →
`deleteSourceChunks(userId, 'library', sourceName)` 防**孤儿块**（upsert 只覆盖同名写
路径；桌面 vector-store 已补齐该函数，批2 对齐 server）。已知对称缺口：两端
move 撞名改名路径暂不清旧名块（server service.move/desktop repo.move 均未挂，留待
后续对称补齐）。

### 3.2 检索链路（query → 向量化 → 相似度 → 输出）

**语义检索 `searchChunks`**（vector-store.ts L90）：`findMany({ userId, model, collection? })`
全表载入 → 逐块 `JSON.parse(vector)` → `cosine`（零向量防除零）→ 降序切 topK。
**同 model 过滤是维度混用防线**（不同 embedding 模型维度不同，余弦无意义）。
`collection` 空串 = 检索全集合。无任何 ANN 索引，复杂度 O(全表 × 维度)。

**BM25 全文 `searchFts`**（L118）：同样全表载入 → `@tianshu/core` `rankBm25`
（`packages/tianshu-core/src/retrieval.ts`）：
- 分词 `tokenize`：`Intl.Segmenter("zh-Hans", { granularity: "word" })`（Chromium/Node 内建
  ICU 词典，零依赖；单点抽象，升级 jieba 只动这一处）；
- Okapi BM25（`BM25_K1 = 1.5`、`BM25_B = 0.75`，Lucene 式 +1 平滑 IDF 防负）；
- **不是 SQLite FTS5**：FTS5 已否决（`history-search-tool.ts` 注释「FTS5 仅 mirror 栈有，
  server 本仓 Prisma 引擎栈无」），为三端同源 pivot 为内存 BM25（LangChain
  BM25Retriever 形态），每查询实时读行评分。

**混合检索 hybridSearch 节点**（`makeHybridSearchNodeHandler`，L3732）：
- 三模式 `mode: "hybrid" | "keyword" | "semantic"`（对齐 Dify 知识检索心智）；
- hybrid：embedding 与 FTS **两路并行**，各自取满候选池 `poolSize = max(50, topK×5)`，
  再 `rrfFuse`（RRF，k=60 论文值/ES `rank_constant` 默认；按 chunkId 累加 `1/(k+rank)`，
  量纲免疫）→ 融合后重编 rank、切 topK；
- 结构化 `hits`（`FusedHit[]`：chunkId/sourceName/collection/text/score/rank）旁路落
  节点 state，供 rerank 节点消费；
- 输出文本形态统一：`【{sourceName}｜相关度 x.xx】{text}` 多段拼接。

**重排 rerank 节点**（`makeRerankNodeHandler`，L3830）：消费上游 hybridSearch 的 hits 旁路
（`sourceNodeId` 指定，图边保证先执行）→ `POST {baseUrl}/rerank`
（`{ model, query, documents, top_n }`，业界事实标准，Cohere/Jina/vLLM 同形）→ 按
`relevance_score` 降序切 topN 回挂 hits。防线：模型须 `model.type = "reranker"`
（否则 `rerank_model_type`）；`RERANK_MAX_CANDIDATES = 250`、单候选截断
`RERANK_DOC_CHAR_LIMIT = 2000`（cross-encoder 输入上限惯例）；空召回透传不调 API。

**关键词内容扫描 librarySearch 节点**（`makeLibrarySearchNodeHandler` L2454 →
`searchLibrary` L2489）：keywords 空格分词 **AND 匹配**资料库文本文件内容——逐 file 行
读盘全文（`LIBRARY_TEXT_EXTENSIONS` 白名单、`LIBRARY_SCAN_LIMIT = 1MB` 上限、坏行静默跳过），
命中取首词前后 `LIBRARY_SNIPPET_RADIUS = 120` 字符片段，输出 `【文件名】片段`（≤maxResults
默认 5）。这是最原始的"暴力 grep"检索，v1 形态（schema 注释自认「向量语义检索为后续演进，
对齐 Coze 知识库节点的召回形态」）。

### 3.3 chat 链路接入点

**桌面 chat 工具 `library_search`**（`electron/domains/ai/agent/library-search-tool.ts`，
批2 升级语义向量版，server 形态同构）：library 集合有块时——最新块的 `model` 列定
embedding 模型 → `embedTexts(query)` → `searchChunks`（collection='library'，同模型
余弦 topK）→ `libraryItem` 精确名批量读回联条目号 → 输出
`【名称（条目 #id）｜相似度 x.xx】片段`（孤儿块无行时回退纯 sourceName，不丢命中）。
降级两径：空库（未配 embedding 模型或尚无文本写入，不发起向量化）/语义零命中 →
2026-11-01 的文件名关键词版（`libraryItem.findMany({ kind: "file", name: { contains:
keyword 截 100 }, userId })`，返回 `条目 #id｜名称（mime，KB，更新日期）` 列表）。
embed 失败/块模型标识异常 → fail 文案不静默。注册：`chat.service.ts`
`registerTools([makeLibrarySearchTool()])`；`collectToolDefinitions` 中与
`bash/search_history/browser_*` 同列**无工作空间白名单**——未绑定目录的会话同权可用。

**server chat 工具 `library_search`**（`src/core/library/library-tools.ts`）：**语义向量版**——
空库短路（`vectorChunk.findFirst(collection='library')` 无块即返回
`LIBRARY_EMPTY_OUTPUT`，不发起向量化）→ 取最新块的 `model` 列定 embedding 模型 →
`embedTexts(query)` → `searchChunks(topK 默认 5)` → `LibraryRepository.findFilesByNames`
回联条目号 → 输出 `【名称（条目 #id）｜相似度 x.xx】片段`（孤儿块无行时回退纯
sourceName，不丢命中）。注入：`chat-runner.service.ts` L1283 常驻
`makeLibrarySearchTool({ db: this.prisma })`。

**@ 引用注入（RAG 的"手动版"）**：`ChatInput.tsx` @ 联想候选来自
`LibraryApi.search`（react-query `librarySearchQuery`，L329）；`PlusMenu`/`LibraryPickerDialog`
选择器与 @ 联想两入口统一挂 `libraryFiles` pill（`attachLibraryFile` L728：非图片先经
`file:readExternalFile` 预检——512KB 上限/二进制/授权门）。发送时（L635-662）逐 pill 读
全文进 `contentRefs: { path, content }[]` → 块化注入消息（**引用注入文件全文，非切块检索**）；
图片附件分流多模态 image part。读取失败恢复输入不发送（防静默丢引用）。

综上：**聊天时的资料库触达 = 模型自主调 library_search 工具（两端语义向量版，桌面
未建索引时降级文件名）+ 用户手动 @ 注入全文 + 用户搭图（hybridSearch/rerank）**；
没有"会话挂载知识库自动检索
注入 prompt"的自动 RAG 链路（§6 P1）。

## 4. 三端布局与两端异构

### 4.1 桌面端（better-sqlite3 栈）

- Prisma 经驱动适配器接 better-sqlite3（`electron/commons/prisma-client.ts`：
  `@prisma/adapter-better-sqlite3`，`PrismaBetterSqlite3`），原生 SQLite 引擎理论上可用
  FTS5，但检索层已按三端同源裁掉 FTS5；
- `LibraryRepository`（library.repo.ts）在 `electron/Application.ts` L278 构造单实例
  （构造函数即注册全部 IPC handler），并被被控面 `server-face/library-tap.ts` 复用
  （十六端点桥，严禁 face 侧二次构造）；DTO 显式剔除 `storagePath/originalPath`
  （本机绝对路径不作远程读取凭证）；
- **写侧向量化挂载（批2，P0-1 闭合）**：repo 三写面（addFiles/
  uploadFileBuffer/writeFileContent）后 fire-and-forget 向量化（文本白名单 +
  3MB 读回上限；接线壳 `library/library-vectorize.ts`，构造函数第二参 deps
  注入面供测试替身），delete/rename 联动 `deleteSourceChunks` 清孤儿块
  （vector-store.ts 补齐，对齐 server）；`library` 集合自此非空，
  library_search 语义版/vectorSearch/hybridSearch 检索面在桌面生效；
- 前端 `src-react/domains/ai/library/`：`views/LibraryView.tsx`（左树形栏
  `LibrarySidebarTree` + 列表/详情两态、⌘K 命令面板搜索、**拖拽入库**、最近/收藏/产物
  视图）、`components/LibraryPreviewContent`（文本/MD/CSV/图片预览）、
  `LibraryMarkdownEditor/LibraryCsvEditor`（详情面板编辑 → `library:writeFileContent`）、
  `LibraryPickerDialog`（chat @ 选择器）；`api/library.api.ts` 封装 18 通道
  （`LibraryItem` 契约被后端反向 import）。

### 4.2 server 端（Prisma 引擎栈 + 可选 PG 检索后端）

- **主库**：Prisma 自带引擎（SQLite 缺省 / `prisma/pg/schema.prisma` PG 变体），
  **无 better-sqlite3**——这是"FTS5 类特性选型不可跨端假设"的根源（FTS5 否决的直接
  原因）；`src/modules/library/library.controller.ts` 17 个 `@Post` 端点
  （`@Public()` 豁免 JWT——无头端 token 为实例级），归属用户恒 `COMPANION_USER_ID`
  （无头端伴生用户）；
- **双份守护**（`packages/tianshu-core/scripts/drift-manifest.json`）三对：
  `library-utils`（纯函数 golden 逐行移植，期望 diff 恒 0）、`library-disk-repository`
  （写面移植，基线 153 行：去 IPC/openLink/revealItem、Log→onWarn 注入、libraryRoot
  构造注入）、`library-repository-search`（检索段摘取，基线 674 行）；
- **协议单份**：`packages/tianshu-protocol/src/library-contract.ts`（`LibraryItemDto`
  剔除 storagePath/originalPath、`LibraryUploadFilePayload` base64 ≤3MB、
  `LIBRARY_ERROR_CODES` 7 个稳定码）；
- **PG 检索后端**（`src/core/graph/search-pg.ts`，server 独有）：`SEARCH_DB_URL` 指向
  独立 PG（或主库为 postgres 时跟随主库）即启用，`vector-store.ts` 四函数
  （upsert/search/searchFts/count/deleteSource）入口处分派路由。DDL 幂等建
  `tianshu_search.vector_chunk`（**独立 schema 与 migrate 体系正交**）：
  `vector vector` 列 + `text_tsv tsvector` + GIN 索引；向量检索
  `1 - (vector <=> $1::vector)` 余弦距离排序——**无 HNSW 索引**（顺序扫，注释留
  「HNSW 留 v2 维度策略」）；FTS 侧 `to_tsquery('simple', 词元 OR 连接)` + ts_rank，
  分词仍用 @tianshu/core `tokenize`（与内存 BM25 行为同源）。
  桌面端没有这条 PG 路径。

### 4.3 移动端

`apps/tianshu-mobile/src/app/library.tsx`（A5 批）：浏览/搜索/最近/收藏 + 新建（文件夹/
Markdown/链接）、重命名/移动/删除、文本与图片预览（markViewed 联动最近）。**双重
capability 门禁**：`settings.tsx` L353 仅当连接上报 `capabilities.includes("library")`
（即桌面被控端 library-tap）才显示入口，页内再降级引导。上传
`logic/library-upload.ts`（`pickLibraryFile` → base64 → `library/uploadFile`，≤3MB）。
移动端**不做本地检索**，纯遥控桌面资料库。

## 5. 业界主流做法对比

### 5.1 向量存储与索引

| 方案 | 形态 | 与天枢的关系 |
|---|---|---|
| Chroma | 嵌入式/服务端向量库，HNSW | 引入新进程/依赖，桌面单机场景重 |
| LanceDB | 嵌入式列存向量库 | 同上，无 Node 原生生态负担小的优势 |
| Qdrant | 独立服务，payload 过滤 + HNSW | vector-store.ts 头注释点名「远端（Qdrant 等，配置切换）」为升级路径 |
| pgvector | PG 扩展，IVFFlat/HNSW | **server 已用**（`<=>` 余弦），但无索引列顺序扫 |
| sqlite-vec | SQLite 扩展，brute-force + SIMD 扫描，零外部服务 | **schema 注释钦定的升级路径**：「同库加扩展，VectorStore 接口不变」，与 better-sqlite3 桌面栈天然契合 |

天枢现状（JSON 列 + 内存余弦全扫）≈ sqlite-vec 的朴素前身：万级 chunk 毫秒级成立，
十万级起 JSON.parse 与全扫会成为瓶颈。业界共识是**本地单机优先 sqlite-vec/LanceDB，
服务端多租户优先 pgvector(Qdrant)**——天枢两端恰好各占一半。

### 5.2 切块策略

- **固定窗口 + 重叠**（v1 形态，已退为递归切分的最细层级兜底）：最简单，
  语义被硬切断；
- **递归字符切分**（LangChain `RecursiveCharacterTextSplitter`）：按
  `\n\n→\n→。→空格` 层级回退，语句边界感知，是业界默认起点——**批2 已落地**
  （`@tianshu/core` retrieval.ts `chunkText` 三端单份，签名/缺省 500/100 不变，
  两端 vector-store 再导出）；
- **语义切块**（`SemanticChunker`）：embedding 相邻句相似度断点，块内主题一致但成本
  翻倍（每句向量化）；
- **结构化切块**（`MarkdownHeaderTextSplitter`/HTML 解析）：按标题层级切，保留元数据
  头路径（检索命中可报 `A 章 > B 节`）。
  天枢 vectorize 节点已把 chunkSize/chunkOverlap 做成**节点参数**，算法本体批2 起为
  递归切分；资料库自动链（路径 B）的 chunk 参数仍不可配（option 面板为剩余项，§6 P1-2）。

### 5.3 混合检索与融合

BM25（词法精确匹配：型号/编号/专名）+ 向量（语义泛化）+ RRF 融合是 2023 以来的标准
配方（Cormack et al. 2009 RRF；Elasticsearch `rank_constant`、Weaviate/Qdrant 混合
内置；LangChain `EnsembleRetriever` 权重法是另一派）。**天枢已内建全套**
（rankBm25 + rrfFuse k=60 + 候选池 max(50, topK×5)），差距不在配方在数据面：全文
检索每查询全量读行评分，PG 后端有 GIN 索引而 SQLite 侧无倒排。

### 5.4 Rerank 重排

cross-encoder 对 query-doc 对精排：Cohere Rerank（SaaS 事实标准）、BGE reranker
（BAAI 开源可本地）、Jina、vLLM 自托管 `/rerank`。两段式（召回 50-250 → 精排 top5）
显著优于纯向量 topK。**天枢已内建** rerank 节点（业界同形 API、250/2000 上限、
reranker 类型校验），模型侧只需用户配一个 rerank 端点。

### 5.5 GraphRAG 与知识图谱增强

微软 GraphRAG（LLM 抽实体/关系建图 → 社区层级摘要 → local/global 双查询模式）解决
"跨文档全局性问题"（整库总结/多跳推理），代价是索引成本高（多次 LLM 调用）。轻量替代
是知识图谱增强（实体链接/上下文扩张）。天枢已有 graph 运行时与 llm 节点，具备自搭
GraphRAG 管线的积木，但无任何内置支持。

### 5.6 RAG 评估

RAGAS 四指标（faithfulness 忠实度 / answer_relevancy / context_precision /
context_recall）是事实标准，需 LLM-as-judge；配合检索命中率离线回归。天枢有
`llmCallEvent/toolCallEvent` 监控骨架但无 RAG 质量度量——检索效果目前只能人工体感。

### 5.7 产品侧参照

- **NotebookLM**：回答**逐句源引用**（角标 → 源文档高亮定位），信任感核心；上传即建
  索引零配置；
- **Coze 知识库**：分段面板（分段标识符/最大分段长度/重叠）+ 检索面板（topK、score
  阈值、混合检索开关、rerank 模型选择）全量用户可配；Agent 挂载知识库即自动 RAG；
- **Dify 知识库**：分段 + 索引方式（高质量 embedding/经济关键词）+ 检索设置（混合
  检索权重或 RRF、rerank 开关、topK/score 阈值），召回测试面板可逐条看命中。

对照：天枢的检索能力参数（topK/mode/rerank）**只在图节点上暴露**，资料库页与 chat
会话零配置面板；引用溯源 UI 完全缺位（检索输出纯文本拼接，chunkId/sourceName 有
回联数据但前端无消费）。

## 6. 改进空间（按优先级）

### P0-1 桌面端写面向量化补齐（两端 `library` 集合统一）——✅ 已落地（批2，2026-11-05）

落地形态：`vectorizeLibraryContent` 收编 `@tianshu/core`（db/embed/upsert 必填注入面，
`packages/tianshu-core/src/library-vectorize.ts`），server 接线壳保持公开面不变、桌面
新增接线壳挂 `LibraryRepository.addFiles/uploadFileBuffer/writeFileContent` 后
fire-and-forget（文本白名单 + 3MB 读回上限，skip+日志不炸写面同 server 哲学）；
`vector-store.ts` 补齐 `deleteSourceChunks`，delete/rename 联动清孤儿块；桌面
`library_search` 工具升级语义版（最新块 model → embed → searchChunks → 条目回联），
无 embedding 模型/零命中降级文件名关键词版。遗留对称小缺口：两端 move 撞名改名路径
不清旧名块（见 §3.1 路径 B 尾注）。

<details><summary>原缺口记述（落地前现状，存档）</summary>

桌面 `library_search` 工具头注释明示「向量语义版等 server『library 写入批』
落地后两端再统一」——server 侧 2026-11-02 已落地，桌面侧未跟进，`library` 集合在桌面
恒空，语义检索（chat 工具/vectorSearch/hybridSearch 指向 library 集合）在桌面全为空转。
做法：把 `vectorizeLibraryContent`（纯函数 + deps 注入面）收编进 `@tianshu/core` 或
desktop 侧同构复刻，挂到 `LibraryRepository.addFiles/uploadFileBuffer/writeFileContent`
之后 fire-and-forget（server 同款失败哲学）；delete/rename 联动
`deleteSourceChunks`（vector-store.ts 需补该函数——server 版已有）。同步把桌面
`library_search` 工具升级语义版（server 形态已验证：取最新块 model → embed →
searchChunks → findFilesByNames 回联），文件名版保留为降级。

</details>

### P0-2 引用溯源 UI（NotebookLM 式）

`VectorHit.chunkId/sourceName` 与 libraryItem 回联（server `findFilesByNames`）链路已在，
但检索结果只是拼进 prompt 的纯文本。落地：检索节点输出附结构化引用（FusedHit 已含
chunkId/sourceName），chat 回答侧渲染引用角标 → 点击跳资料库详情面板并定位块
（`collection+sourceName+seq` 三键可精确定位）；这与既有 artifact 块化渲染（blocks
体系）同构，改造面集中在消息块渲染与 LibraryDetailPanel。

### P1-1 sqlite-vec 真向量索引

schema 与 vector-store 头注释钦定的路径：better-sqlite3 `loadExtension` 加载 sqlite-vec
→ 新表/虚表 `vec_chunk(chunk_id, embedding float[维度])` → `searchChunks` 内核换
KNN 扫描，接口零改动。注意三点：维度随模型（建多张按维度分表或存模型维度映射）；
**双 ABI 链**（`setup:native` 三件套要纳入 vec 扩展的下载/校验，Windows dev 机存在，
平台二进制永不硬声明）；server Prisma 栈不受益（那边走 PG 路径），改动严格限定桌面
vector-store.ts 单文件。

### P1-2 切块升级与参数可配置化——递归切分 ✅ 已落地（批2）；配置面板部分开放

`chunkText` 递归字符切分已落地（`\n\n→\n→。→空格` 层级回退，约 30 行级纯函数，
`@tianshu/core` retrieval.ts 三端同享，两端 vector-store 再导出、签名与缺省
500/100 不变）。剩余：资料库自动链的 chunkSize/overlap/是否含 PDF（复用
doc-extract 的 pdf-parse/mammoth）提为 option 表配置项 + 资料库设置面板
（Coze/Dify 式），默认值不变。

### P1-3 会话挂载资料库自动 RAG

当前只有"模型主动调工具 + 用户手动 @"。加"会话/专家绑定 collection"（assistant 表
或 option），send 前自动 query→hybridSearch→topK 注入 system prompt 上下文段（对齐
Coze Agent 挂知识库心智）。桌面 chat 链路组装点在 `chat.service.ts` 会话装配段，
server 在 `chat-runner.service.ts` 装配段，两端已有 hybridSearch 全套可复用。

### P2-1 PG HNSW 索引

`search-pg.ts` 顺序扫在块量大后成为瓶颈；建 `CREATE INDEX ... USING hnsw(vector
cosine_ops)` 需固定维度列（`vector(1024)` 类）——与"维度随模型"冲突，注释已留
「HNSW 留 v2 维度策略」：按 model 分维度建部分索引或维度分表，随 P0-1 落地后的
真实块量再决策。

### P2-2 检索质量与观测

- 分词升级：`tokenize` 单点换 jieba 级词典（Intl.Segmenter 对未登录专名弱）；
- RAGAS 式评估：借 llmCallEvent 监控骨架加"检索命中 → 引用点击/采纳"漏斗指标，
  先观测后调参；
- server 上传 PDF/docx 现不入向量库（isTextualContent 白名单拦下）——doc-extract
  与 vectorize 打通后白名单扩到 office/pdf（解析失败走既有 skip 哲学）。

### P3 长线

- GraphRAG 管线（实体图 + 社区摘要）以图编排模板形式提供（llm/vectorize/iterate
  节点已够搭原型），按需立项；
- 多模态入库（图片 OCR/vision 模型产文本描述后切块）与语音（model.type 已预留 asr）。

## 附：关键文件索引

| 职责 | 路径 |
|---|---|
| 表定义 | apps/tianshu-desktop/prisma/schema.prisma（libraryItem L414 / vectorChunk L464） |
| 桌面仓储/IPC | apps/tianshu-desktop/electron/domains/ai/library/library.repo.ts |
| 桌面写侧向量化接线壳 | apps/tianshu-desktop/electron/domains/ai/library/library-vectorize.ts |
| 桌面向量存取 | apps/tianshu-desktop/electron/domains/ai/orchestration/vector-store.ts |
| 节点执行器 | apps/tianshu-desktop/electron/domains/ai/orchestration/graph-executor.ts（embedTexts L3542 / vectorize L3605 / vectorSearch L3672 / hybridSearch L3732 / rerank L3830 / librarySearch L2454） |
| 文档提取 | apps/tianshu-desktop/electron/domains/ai/orchestration/doc-extract.ts |
| 桌面 chat 工具 | apps/tianshu-desktop/electron/domains/ai/agent/library-search-tool.ts |
| 检索纯函数 | packages/tianshu-core/src/retrieval.ts（tokenize/rankBm25/rrfFuse/chunkText 递归切分） |
| 写侧向量化编排（三端单份） | packages/tianshu-core/src/library-vectorize.ts（vectorizeLibraryContent/isTextualContent） |
| 节点 schema | packages/tianshu-core/src/graph-schema.ts（L582-641 向量节点族） |
| 协议契约 | packages/tianshu-protocol/src/library-contract.ts |
| server 模块 | apps/tianshu-server/src/modules/library/（controller/service/module） |
| server 检索工具 | apps/tianshu-server/src/core/library/library-tools.ts |
| server 写侧向量化接线壳 | apps/tianshu-server/src/core/library/library-vectorize.ts（编排本体已收编 @tianshu/core） |
| PG 检索后端 | apps/tianshu-server/src/core/graph/search-pg.ts |
| 被控面桥 | apps/tianshu-desktop/electron/domains/server-face/library-tap.ts |
| 前端视图 | apps/tianshu-desktop/src-react/domains/ai/library/views/LibraryView.tsx |
| 前端 API | apps/tianshu-desktop/src-react/domains/ai/library/api/library.api.ts |
| 移动端页 | apps/tianshu-mobile/src/app/library.tsx |
| 双份基线 | packages/tianshu-core/scripts/drift-manifest.json（graph-vector-store / library-* 三对，批2 过账注记见 note） |
