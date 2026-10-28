# 资料库二进制上传批（移动端文件入库）设计 spec

日期：2026-10-26
状态：直接开工（用户「继续」滚动授权；先例与蓝本齐备）
关联：A5 资料库批留档「移动端文件上传到资料库（另批）」之兑现；skills installUpload 3MB 上传先例

## 0. 事实基线

- mirror face library 17 端点已齐（含 A5 尾 writeContent），**无上传端点**；桌面 addFiles 收宿主文件路径（移动端无法给路径），但落盘入库语义可复用——需 buffer 内容入口。
- skills installUpload 上传链全链先例：base64 ≤3MB（对齐 files/uploadImage 口径，relay 单帧 4MiB 余量）+ SKILL_UPLOAD_INVALID 错码 + repo buffer 包装方法 + 移动端 document-picker→fetchBlob→blobToBase64 链（`apps/tianshu-mobile/src/logic/skill-import.ts`）。
- 无头端 LibraryModule 17 端点刚落（本批同步第 18 端点）。
- library.utils 扩展名分类表（fileType/mime 推断）双份已在（mirror + server golden 移植）。
- relay 4MiB：3MB 原始 → base64 4MB 在限内（同 skills 先例）。

## 1. 本批裁定

### 1.1 协议（主会话先落，三 agent 并行引常量）
- `ENDPOINTS.library` 增 `uploadFile` 段；`LibraryUploadFilePayload {parentId?, name, base64}` → 回传 `LibraryItemDto`。
- 错误码：`LIBRARY_UPLOAD_INVALID`（坏 base64/超 3MB/文件名非法）入契约码表；归属拒沿用 LIBRARY_NOT_FOUND 口径。

### 1.2 mirror face 段
- library-tap `uploadFile(userId, payload)`：base64 解码 ≤3MB 前置拒（utf8 字节计）+ 文件名清洗（照 repo createFile 清洗/重名序号先例）+ repo 新增 buffer 落盘入口（复用 addFiles 的 {libraryDir}/{id}/{name} 布局与 libraryItem 建行语义，源记 source 为 "upload"）+ fileType/mime 经 library.utils 分类表推断。
- 协议钉测试全表断言 17→18 段。

### 1.3 无头端段
- LibraryModule 第 18 端点 uploadFile，disk repo buffer 入口同语义（golden 双份对齐，drift manifest 基线登记）。

### 1.4 移动端段
- library.store `uploadFile(parentId?, name, base64)`：enqueueWrite 串行纪律（writeContent 同链）+ 成功就地插入列表行。
- 库页导入入口：document-picker 单选（不限 mime，扩展名守卫防误选）→ fetchBlob→blobToBase64（复用 file-read 原语，同 skill-import 链）→ 3MB 客户端预检 → uploadFile；i18n 双语。
- 路由分流：folder 内导入传 parentId，根目录不传。

### 1.5 非目标
- 多文件批量/文件夹上传（v1 单文件）；>3MB 文件（提示桌面端导入）；图片直接拍照入库（移动端已有拍照入链在聊天面，资料库拍照另批）。

## 2. 测试与验收
- face：tap 用例（解码达 repo/超限拒 LIBRARY_UPLOAD_INVALID/文件名清洗/分类推断/DTO 回传）；routes 注册。
- server：service 用例（tmp 磁盘落盘 + 建行 + 分类）；SDK 契约 18 段同步。
- mobile：store 串行/防迟到/就地插入；上传链 logic 用例（扩展名守卫/3MB 预检/取消分支）；i18n 齐平；既有 571 零红。
- 根+mobile typecheck + prettier + drift；分提交。

## 3. 风险
- 文件名冲突：重名序号语义与 createFile 对齐（用例钉）。
- mime 推断不可靠（Android octet-stream）：以扩展名分类表为准，mime 参数仅记录参考——与桌面 addFiles 同口径。
