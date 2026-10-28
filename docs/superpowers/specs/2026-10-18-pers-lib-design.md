# 天枢服务端二期：personalization/memory + library 无头化设计（读侧）

- 日期：2026-10-18
- 状态：已与用户对齐（方案 A 读侧最小；待入库）
- 前置：共享 core 管道；GA（vectorChunk 表/vector-store 副本）；TB 备案（librarySearch 恒空召回——本设计兑现）

## 1. 目标与非目标

**目标**：无头端 chat 的 system prompt 注入个性化+记忆（Profile）；`library_search`/读工具接真向量检索。
**非目标**：memory 写侧（编辑指令/手动整理/定时整理调度——控制端无 UI 需求）；library 写侧（上传/导入/管理端点——无头端资料来源属「library 同步/上传」后续批）；graph/automation 链的个性化注入（mirror 侧核后再说，MVP 只接 chat）。

## 2. 方案

### 2.1 personalization/memory 读链

- `personalization.prompt.ts`（buildPersonalizedSystem 纯函数）**物理入 `@tianshu/core`**（mirror 原位 re-export）；`personalization.config.ts` 的 PERSONALIZATION_KEYS/defaultPersonalization 若为纯常量随之入包（repo 侧 option 读写留消费方）
- server `src/core/personalization.ts`：`loadPersonalization()`（option 表读+默认回退+异常不断对话——mirror 语义逐字：现查不缓存/回退全默认+日志）；chat-runner 的 system 组装点接入 `buildPersonalizedSystem`（含 memory Profile 段——Profile 数据形态与 mirror 一致，读 option）
- memory：Profile 即编译产物（option 存储）——读侧零额外表；无头端 Profile 初始为空（默认行为与 mirror 未配置时一致）

### 2.2 library 检索链

- server Prisma +`libraryItem` 表（逐字段摘取，@@map 保留）
- `src/core/library/library.repo.ts`：检索面最小摘取（`search`/按 id 读——mirror library.repo 对应方法，prisma 指 server 自有）；**写面不摘**
- `library_search` 工具（mirror `agent/web-tools` 或独立——核 mirror 工具名与实现位）：server 版执行体接 `src/core/graph/vector-store.ts`（已在）真检索——embedding 模型配置沿用 mirror 语义（vector-store 内已含）；空库返回空结果（语义如实）
- 工具注册：chat-runner `collectToolsDefinitions` 增补；graph LLM 节点经 registry 自动获得

### 2.3 漂移治理

manifest 入册：server personalization.ts ↔ mirror personalization.repo.ts（读段）、library.repo（检索段）、library 工具对；prompt.ts 入包后零双份。

## 3. 测试

- core：buildPersonalizedSystem 既有 mirror 用例照跑（搬移）
- server：loadPersonalization 回退语义（option 空/异常两态）；chat system 组装含个性化段（fake model 断言 system 内容）；library_search 真检索（seed vectorChunk+检索命中/空库空结果）；drift 首跑固化
- E2E：直连会话往返断言 system prompt 含个性化段（可选——单测覆盖即可）

## 4. 假设与偏离

1. memory Profile/个性化配置键位与 mirror 同名同值域（跨端不互写——各自 option 库独立配置）
2. library 数据写侧后置；空库检索语义如实（不伪造）
3. embedding 依赖 vector-store 既有配置形态（无新增配置面）
4. graph/automation 链暂不注入个性化（与 mirror 侧现状对齐后扩展）
