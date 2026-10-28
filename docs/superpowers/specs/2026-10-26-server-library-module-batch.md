# 无头端 library 管理模块批设计 spec

日期：2026-10-26
状态：直接开工（A5 批裁定「无头端资料库管理模块（另批）」之兑现）
关联：A5 资料库批（2026-10-26-mobile-library-batch.md）；资料库编辑批（writeContent 已落 face，本批随带）

## 0. 事实基线

- **无头端现状**：无 LibraryModule（`app.module.ts` 无注册）；`src/core/library/library.repository.ts` 仅检索最小摘取（search/getById/findFilesByNames），供 graph 检索内部用；capability 常量（`packages/tianshu-protocol/src/server-event.ts:149-153`）无 `library`——移动端连无头端主机时资料库全功能缺失。
- **蓝本**：mirror `electron/domains/ai/library/library.repo.ts`（磁盘管理：{libraryDir}/{id}/{name} 布局、originalPath、addFiles 复制入库、递归导入跳隐藏文件/软链、move/delete 目录级联、subtreeCount）+ `library-tap.ts`（守卫：归属/512KiB read 守卫/readImage 白名单+10MB/writeContent 写守卫）+ `electron/domains/server-face/routes.ts:2225-2254` library 17 端点注册形状。
- **协议已备**：ENDPOINTS.library 17 段（list/tree/search/listRecent/listFavorites/createFolder/createFile/addLink/rename/move/delete/subtreeCount/toggleFavorite/markViewed/read/readImage/writeContent）+ LibraryItemDto 全字段（刻意排除 storagePath/originalPath）。
- **移植先例**：A3 尾 skill-installer/skill-archive 按桌面 golden 移植（`apps/tianshu-server/src/core/tools/`），头注释留档声明逐行对齐；skillStat 摘表 @@map 先例（server prisma schema）。
- **表**：server prisma schema 需摘 libraryItem 表（@@map 对齐 mirror），迁移语义照 skillStat 先例（仅新库全量，既有库需幂等 DDL——ensureDatabase 在库就绪时直接返回，故摘表同 skillStat 走启动幂等 create-if-absent 或留档说明）。

## 1. 本批裁定

1. **Nest LibraryModule**（controller+service+repository，POST 风格照 skills 模块先例）——17 端点全对齐全行 face 语义；service 层复用/扩展 `src/core/library/` 磁盘原语（不与 graph 检索摘取冲突，可重构其共用）。
2. **磁盘管理 golden 移植**：mirror library.repo 的目录布局与级联语义逐行对齐（头注释留档）；文件内容读守卫（512KiB/NUL）与 readImage 白名单（含 A5 尾 svg）同口径移植 core 守卫（`packages/tianshu-core/src/workspace-files-scan.ts` 如可经 workspace 依赖消费则消费，否则本地同语义移植+留档）。
3. **capability**：server-event.ts CAPABILITIES 增 `library` 常量；无头端连接上报 capability 含 library（找 capability 上报点）；mirror face 不受影响（capability 是连接级）。
4. **DTO 不泄路径**：LibraryItemDto 全字段可回传，storagePath/originalPath 绝不透出（钉测试）。
5. **SDK 契约**：library 组进 sdk-contract 显式覆盖（参照 assistant/skills 组先例）；openapi/sdk 产物跟踪提交。
6. **writeContent 随批**：服务端写守卫 ≤512KiB + LIBRARY_WRITE_FAILED 同码。

## 2. 测试与验收
- server jest：17 端点 service/controller 用例（真 tmp 磁盘 + Prisma 替身，照 skills-tail 先例）——重点：目录级联 delete/move、归属拒、DTO 无路径泄漏、read/readImage/writeContent 守卫边界、subtreeCount 聚合。
- capability 上报含 library 用例；SDK 契约测试。
- 根 typecheck + server jest 全量 + drift 巡检；分提交。

## 3. 风险
- 磁盘操作 golden 移植与 mirror 分叉风险——头注释留档 + drift 基线登记（本批后 library 相关双份入 manifest）。
- graph 检索现有 core/library 依赖不回归（既有测试零红是底线）。
- 既有库摘表：若 ensureDatabase 不自动补表，本批 schema 仅覆盖新库——启动幂等补表（CREATE TABLE IF NOT EXISTS 同 skillStat 先例）或代码内防御；结论写提交信息。
