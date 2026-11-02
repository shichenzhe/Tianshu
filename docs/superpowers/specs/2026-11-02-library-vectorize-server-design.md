# server 资料库向量化入库批设计 spec

日期：2026-11-02
状态：已入库（对话内 2026-11-02 用户「都做」授权立 spec 并实施；audit 余项 #5）
关联：audit-remaining-batch ⑨（"向量版 library 检索双端统一待 server library 写入批"）；library-tools.ts LIBRARY_COLLECTION 入库契约注释；2026-10-31-server-pg-search（upsertChunks 已含 PG 路由）

## 0. 事实基线

- **server library 写面已全**：`uploadFile`（buffer 落盘+建行）/`writeContent`（写文件内容）端点 + disk repo `uploadFileBuffer`/`writeFileContent` 均在——#5 原认知"缺写入面"不成立，真缺口是**写后向量化**这一环。
- `library_search`（PL-2 向量版）检索面就位但 `LIBRARY_COLLECTION='library'` 集合**无任何写入方恒空**——工具长期空转（检索侧取"最新块的 model"定模型，无块即空结果文案）。
- `embedTexts(modelId, texts)`（graph-executor）OpenAI 兼容 /embeddings 分批串行，modelId 必传；`Model.type` 值域含 `embedding` 标记。
- `chunkText`（server vector-store 导出，500/100 窗口分块）、`upsertChunks`（同 user+collection+sourceName 先删后插，幂等；PG 路由已含）现成。
- mirror 侧 library 同样零向量化（library.repo 无 vectorChunk 面）——双端都未接线，本批先行 server。

## 1. 本批裁定

1. **新文件 `src/core/library/library-vectorize.ts`**：`vectorizeLibraryContent({ userId, sourceName, content, fileType, mimeType })` 纯编排函数——
   - **文本判定**：mimeType text/* 或 fileType 属可文本集（txt/md/markdown/code/json/csv/log/yaml/xml/html）才继续，二进制/图片直接跳过（返回 skipped 态）；
   - **分块**：`chunkText(content)` 空块集（空内容）跳过；
   - **缺省 embedding 模型**：`model.findFirst({ where: { enabled: true, type: 'embedding' }, orderBy: { id: 'asc' } })`——确定性取首个；无模型 → 跳过（日志），**不炸写面**；
   - **入库**：`embedTexts` → `upsertChunks({ userId, collection: 'library', sourceName, model: String(model.id), chunks })`。
2. **接线两处**（library.service）：`writeContent` / `uploadFile` 写成功后 **fire-and-forget**（`void promise.catch(warn)`）——上传/写内容响应不被 embedding 往返拖慢；上传 buffer 路径内容经 `content.toString('utf8')`（文本判定已滤二进制，无损路径）。
3. **孤儿块清理**：`delete`（级联删）与 `rename` 后清该 sourceName 旧块——`vector-store` 新增 `deleteSourceChunks(userId, collection, sourceName)`（本地 prisma deleteMany + PG 路由，search-pg.ts 补对应 DELETE）；重建面 = 重新写内容/上传自动 + 既有 graph `vectorize` 节点手动跑。
4. **单测**（jest）：文本判定矩阵（text/*、md/code 白名单、png/pdf 跳过）、缺省模型选择（无 embedding 模型跳过不炸）、service 接线（注入 fake embed 断言 fire-and-forget 与 upsert 参数 collection='library'）、delete/rename 清块调用。
5. drift：library-vectorize 为 server 独有新文件不入册；library.service/modules 对不在册（形态不同构）。

## 2. 非目标（留档）

- mirror 侧接线与 library_search 双端统一（server 验收后另批——mirror 现为关键词版，统一时升向量版）。
- 手动重跑/批量重建端点（graph vectorize 节点已覆盖）。
- 二进制/图片 OCR、网页链接（addLink）抓取向量化（内容根本不在库，无从分块）。
- rename 后按新名自动重向量化（清块即可，重建走手动/下次写）。
- embedding 模型 per-用户配置面（本批缺省取法够用，配置化后续按需）。

## 3. 风险

- **fire-and-forget 静默失败**：embedding 挂了用户无感知（条目在、检索不到）——日志 warn 留观测；graph 节点手动重跑是恢复路径。
- **大文件分块 embedding 时长**：批 16 串行，千块级分钟——后台跑不挡端点；无并发限流（多文件同时上传时多个 fire-and-forget 并发打 /embeddings——EMBED_BATCH_SIZE 分批+串行已缓冲，个人量级可接受）。
- **sourceName 即文件名**：同层重名 uniqueDbName 加序号后 sourceName 天然唯一；跨层同名文件共享块（upsert 按 sourceName 先删后插会互相覆盖）——**已知取舍**：library_tools 检索侧回联按 name 查本就同名同 feed，语义自洽。
