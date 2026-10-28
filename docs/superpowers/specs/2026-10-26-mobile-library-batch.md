# 移动端资料库批（A5）设计 spec

日期：2026-10-26
状态：已裁定开工（差集 spec 优先级第 1 批；调研报告基于双 Explore 全量摸底）
关联：差集 spec `2026-10-25-mobile-desktop-gap.md`（A5 条目）；A1 provider 批写面范式、A6 监控批三段式先例

## 1. 背景与裁定

### 1.1 现状盘点（调研结论，file:line 证据见调研报告）

- **桌面端资料库域完整**：`library.repo.ts` 19 个 IPC 通道（list/search/tree/recent/favorites/createFolder/createFile/addFiles/importFolder/addLink/openLink/rename/move/delete/revealItem/subtreeCount/writeFileContent/toggleFavorite/markViewed），仓储自管磁盘同步（`{libraryRoot}/{id}/{name}` 布局）与重名序号；`LibraryRepository` 构造函数注册全部 IPC handler——**被控面装配不可二次实例化**，须由 `Application.ts` 保留实例注入 face。
- **被控面协议零资料库端点**；`files/read` 只接受 workspace 相对路径，与资料库 id 寻址语义不通用。
- **无头端**：有 `libraryItem/vectorChunk` 表但只有检索读面（search/getById/findFilesByNames 服务向量检索），管理写面、模块路由、磁盘操作全缺；做全需另起 Nest module + OpenAPI/SDK 同步批。
- **移动端**：providers/monitor 消费范式成熟（wireRequest 信封解析、请求序号防迟到、enqueueWrite 串行、双重 capability 门禁）。

### 1.2 本批裁定

- **Ruling：本批只做桌面被控面**，`library` 进 `DESKTOP_CAPABILITIES`、不进无头端 `CAPABILITIES`（无头端管理面另批，同 A6 监控先例）。移动端对无头连接不显示资料库入口。
- **Ruling：远程 DTO 剔除 `storagePath`/`originalPath`**。本机绝对路径不作远程读取凭证；内容读取只走按 id 的新端点，服务端校验归属 + kind=file 后自行解析磁盘路径。
- **Ruling：移动端 v1 功能面**＝浏览（list+面包屑回退）/搜索/最近/收藏（含 toggleFavorite）/新建（文件夹/Markdown/链接）/重命名/移动/删除（文件夹 subtreeCount 确认）/文本·Markdown 只读预览（markViewed 联动最近）/图片预览。
- **Ruling：移动端 v1 不做**——上传/导入（`addFiles/importFolder` 收桌面主机路径，移动端内容上传需新上传协议，另批）；`revealItem`（宿主机 GUI 动作）、`openLink`（宿主机浏览器动作）；pdf/音频/视频等富媒体预览（无移动实现，UI 提示「请在桌面端预览」）；`writeFileContent` 编辑（预览只读，编辑另批）。
- **Ruling：单端点直映射仓储方法**（不做 save 式聚合 upsert）——资料库操作相互独立，无事务跨项语义；每项失败即该项报错，与桌面端本地行为一致。
- **Ruling：`Application.ts` 将 `LibraryRepository` 实例存为应用字段并注入 `attachServerFace`**，face 侧建 `library-tap` 适配器（转 DTO + 路径剔除 + 读取守卫），路由层只做形状校验。

### 1.3 非目标

- 无头端资料库管理模块（另批）；移动端文件上传到资料库（另批）；资料库内容编辑（另批）；向量检索移动入口。

## 2. 三层设计

### 2.1 协议包：library 契约收编（新文件 `library-contract.ts`，纯类型+常量）

- `LibraryItemDto`：id/parentId/name/kind("folder"|"file"|"link")/fileType/mimeType/size/url/favorite/lastViewedAt/location(string[])/createdAt/updatedAt——**不含 storagePath/originalPath**。
- `LibraryListResult { items: LibraryItemDto[]; breadcrumbs: LibraryItemDto[] }`。
- 载荷类型：`LibraryCreateFolderPayload {name, parentId: number|null}`、`LibraryCreateFilePayload {name, parentId}`（移动端固定 .md，name 须带扩展名校验）、`LibraryAddLinkPayload {url, title: string|null, parentId}`（http/https only 由服务端守卫）、`LibraryRenamePayload {id, name}`、`LibraryMovePayload {ids: number[], targetParentId: number|null}`、`LibraryDeletePayload {ids: number[]}`、`LibraryIdPayload {id: number}`。
- `LibraryReadResult { kind: "text"; content: string }`（服务端守卫：归属+kind=file+512KB+NUL 二进制拒绝，错误码语义对齐 files/read：`LIBRARY_NOT_FOUND/LIBRARY_NOT_FILE/LIBRARY_TOO_LARGE/LIBRARY_BINARY/LIBRARY_READ_FAILED`）。
- `LibraryReadImageResult { mime: string; dataBase64: string }`（归属+file+mime∈png/jpg/jpeg/webp/gif+10MB；relay 大图帧限制由移动端按既有 MessageImage 降级占位处理）。
- `ENDPOINTS.library` 14 段 + `ENDPOINTS.libraryReadImage`；`DESKTOP_CAPABILITIES` 增 `"library"`；`index.ts` 聚合 export（八模块 → 九模块）。

### 2.2 桌面被控面：library-tap + 路由

- `deps.ts` 增 `ServerFaceLibrary` 接口（list/tree/search/listRecent/listFavorites/createFolder/createFile/addLink/rename/move/delete/subtreeCount/toggleFavorite/markViewed/read/readImage 十三面，全部 `(userId, ...)` 前置）。
- `library-tap.ts` `createLibraryFace(repo: LibraryRepository)`：逐方法转 DTO（`toDto` 剔除路径字段）；`read` 用 repo 行校验归属后从 `{libraryRoot}/{id}/{name}` 读文本（复用 files-tap 的大小/二进制守卫口径）；`readImage` 校验 mime/大小读 base64。注入的 repo 实例由 Application 复用，不二次构造。
- `routes.ts` 每端点一个 handler：形状校验（数字 id 过滤、name 非空截断、url 协议守卫前置）→ `withUserId` → `faceDeps().library.*` → `ok/bizError`；注册进 `ROUTES`。
- 安全面注记：token 鉴权面与 provider 同级；DTO 不泄本机路径；read 系列服务端解析路径，移动端无法越界读。

### 2.3 移动端：library store + /library 页

- `src/store/library.store.ts`（仿 providers.store：请求序号 + activeConnId + transport 三重校验、enqueueWrite 串行）：`load(parentId)`/`search(keyword)`/`loadRecent()`/`loadFavorites()`/`createFolder/createFile/addLink/rename/move/remove/toggleFavorite/markViewed`（写后局部刷新：浏览态重拉当前目录，其他态标记失效）、`readText(id)`/`readImage(id)` 直通。state：当前模式（browse/search/recent/favorites）、items、breadcrumbs、keyword、loading/error/saving。
- `src/app/library.tsx`（Stack 注册 headerShown:false + PageHeader 顶栏）：
  - 页内双重 capability 门禁（无连接/无 library 能力 → 降级引导页，对齐 providers 页）。
  - 顶栏下搜索框（输入即 search 模式，清空回浏览态）；分段 [浏览|最近|收藏]。
  - 浏览态：面包屑横滚 + 目录列表行（kind/fileType 图标、名称、meta 行 size/时间、收藏星）；文件夹点击进入、文件点击预览；行长按/⋯ 动作：重命名（Dialog）、移动（文件夹选择 Dialog）、删除（Alert 确认，文件夹先 subtreeCount 提示 N 项）、收藏切换。
  - 新建：顶栏 right「+」ActionSheet——新建文件夹/Markdown/链接（链接带 url+标题输入）。
  - 预览：`FilePreviewModal` + `loadContent` 接 `library/read`（text/markdown/code 经 MarkdownLite）；图片类型走 `library/readImage` 自绘 Image 预览（relay 失败占位）；其余类型提示桌面端预览。
  - 打开文件预览即 `markViewed(id)`。
- settings 我的页：monitor/provider 入口后增资料库行（`LibraryBig`/`FolderOpen` 图标，`capabilities?.includes("library")` 门禁）。
- i18n 新命名空间 `library`（zh/en 同步注册）。

## 3. 测试与验收

- 协议包：`tests/ai/server/protocol-package.test.ts` 同步（DESKTOP_CAPABILITIES 精确断言 + ENDPOINTS toEqual）；build dist 后 face/mobile typecheck 绿。
- face：`tests/ai/server-face/routes.test.ts` 补 library fake deps 用例（参数映射/withUserId/未装配/非法载荷/业务错误）；新增 `library-tap.test.ts`（DTO 路径剔除、read 守卫全错误码、readImage mime/大小拒绝、真临时目录读写闭环）。
- 移动端三件套：typecheck + vitest（store：端点 method/path/body、迟到响应、写串行、业务错误）+ prettier；既有测试不得红。
- 根侧 `npm run typecheck` + server-face vitest 绿。
- 真机验收（移交用户）：浏览/搜索/最近/收藏/新建三类/重命名/移动/删除回环；md 预览与图片预览（direct）；无头连接不出现入口。

## 4. 风险

- **写面开放**：token 泄露者可删/改资料库元数据与文件。缓解：与 provider delete 同级既有裁定（token 即完全信任）；DTO 不泄路径，read 服务端解析，越界面窄。
- **图片 relay 4MiB 帧限制**：大图 readImage 走 relay 失败——按既有 MessageImage 降级占位呈现，与差集文档「已知协议级限制」一致。
- **仓储实例共享**：face 与 IPC 共用同一 repo 实例，行为一致；重复注册 IPC handler 的风险由注入式装配根除。
