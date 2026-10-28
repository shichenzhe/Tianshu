# 资料库编辑批（library/writeContent + 移动端文本编辑面）设计 spec

日期：2026-10-26
状态：直接开工（事实面已由 A5 尾/全表扫描批探索覆盖）
关联：A5 资料库批与 A5 尾留档项（「资料库内容编辑（另批）」）之兑现

## 0. 事实基线

- 桌面本地编辑已完整：LibraryMarkdownEditor 左编辑右预览 800ms 防抖写盘（`src-react/domains/ai/library/components/LibraryMarkdownEditor.tsx`）、Markdown/CSV 自动保存（LibraryPreviewContent.tsx:71-109）——但全走本地 IPC，**被控面无端点**。
- face read 守卫（`electron/domains/server-face/library-tap.ts:163-174`）：mustFile 归属校验 + diskPathOf 解析 + readTextFileGuarded（≤512KiB/NUL 判二进制）——writeContent 复用同链对称设计。
- 移动端 MarkdownLite 纯只读渲染器（`apps/tianshu-mobile/src/components/MarkdownLite.tsx`），编辑面零基建；FilePreviewModal 50,000 字符截断只读。
- 无头端无 library 管理模块（另批），本批 writeContent 先落 mirror face，无头端随 library 模块批补。
- relay 4MiB 帧限制对文本写回：512KiB 上限内远低限值，无风险。

## 1. 本批裁定

### 1.1 协议 + face（mirror）
- ENDPOINTS.library 增 `writeContent` 段；载荷 `LibraryWriteContentPayload {id, content}`；DTO 回传更新后条目（复用 LibraryItemDto）。
- face library-tap `writeContent(userId, payload)`：mustFile 归属 + diskPathOf + 写守卫（content ≤512KiB 对齐 read 口径——超限 LIBRARY_TOO_LARGE；写失败 LIBRARY_READ_FAILED 同类语义或新码 LIBRARY_WRITE_FAILED 随现有码表风格定）；写盘 utf8；回传刷新 DTO（size/updatedAt）。
- 协议包全表断言同步（library 组在钉测试覆盖内）。

### 1.2 移动端编辑面
- 文本类条目（markdown/text/code）预览态加「编辑」入口（详情弹层/预览 modal 内）；进入编辑视图：多行 TextInput（内容经 library/read 拉取）+ 保存/取消 + i18n 双语。
- 保存走 writeContent，成功后刷新列表条目与预览态；失败按错码 toast（TOO_LARGE/回退）。
- 编辑视图不做实时预览分屏（桌面双栏先例移动端不做，保存后回预览看效果——v1 从简）。

### 1.3 非目标
- 二进制上传/图片入库（relay 4MiB，另批）；CSV 单元格编辑；无头端 writeContent（随 library 模块批）；桌面本地编辑不动（已有）。

## 2. 测试与验收
- face：writeContent 归属拒/路径解析/上限拒/写盘成功回传 DTO/写失败码用例。
- mobile：store 写方法（enqueueWrite 纪律对齐 skills 写面）+ 编辑视图组件用例（保存成功刷新/取消不改/失败 toast）+ i18n 齐平；既有 560 零红。
- 根 typecheck + mobile typecheck + prettier + drift；分提交。

## 3. 风险
- 写盘与桌面本地并发编辑冲突——v1 不做乐观锁，最后写赢（注释留档）。
- content 全量覆盖写（非 diff）——大文件编辑体验受限，512KiB 上限内可接受。
