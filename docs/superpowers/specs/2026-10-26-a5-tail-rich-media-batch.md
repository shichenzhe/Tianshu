# A5 尾资料库富媒体批（HTML/CSV/图片分流）设计 spec

日期：2026-10-26
状态：直接开工（事实面已核实，见下）
关联：[[user-rulings-2026-10-26]]；A5 资料库批（2026-10-26-mobile-library-batch.md）留档裁剪的回填

## 0. 事实基线（Explore 核实）

- 移动端 `FilePreviewModal` 已有 HTML WebView 分支（`apps/tianshu-mobile/src/components/FilePreviewModal.tsx:57-60,163-175`），library 页未把 `html` 路由进去；library 页文本预览只开放 `markdown/text/code`（`src/app/library.tsx:55-57`）。
- CSV 内容可复用 `library/read`（512KiB 文本上限），移动端无表格预览，现提示「请在桌面端预览」。
- 图片 `readImage` 白名单仅 `png/jpg/jpeg/webp/gif`（`electron/domains/server-face/library-tap.ts:21-33`）；`svg/bmp/ico` 被 face 拒绝但移动端按 `fileType=image` 尝试请求→模糊失败。
- relay 4MiB 单帧硬约束（`apps/tianshu-server/src/relay/relay-main.ts:41-44`）——base64 膨胀 33%，任何整文件二进制端点天然受限。
- 无头端无 library 管理模块（A5 spec 裁定另批，本批不碰）。

## 1. 本批裁定

### 1.1 mirror 面（小）
- 契约 `library/readImage` 注释与 face 白名单扩 `svg`（`image/svg+xml`）——svg 是文本型图像，base64 后走 WebView data URL 可渲染；bmp/ico 不扩（RN Image 跨平台支持差）。
- 无新增端点、无新增错误码。

### 1.2 移动端面（主）
1. **HTML 只读预览**：library 页可预览类型加 `html` → FilePreviewModal 现有 WebView 分支（沙箱属性沿用组件内既有值，不新造）。
2. **CSV 只读表格**：library 页 `csv` 路由到新表格预览——纯客户端解析 `library/read` 文本；渲染上限：最多 200 行 × 20 列，超限行/列截断并在表尾显提示行（i18n）；单元格文本单行省略号。只读，不做单元格编辑、不做 CSV 写回。
3. **图片分流**：按扩展名前置——`svg` → `readImage`（白名单已扩）→ WebView `data:image/svg+xml` 渲染；`bmp/ico` → 前置显式「请在桌面端预览」提示（不发 readImage 请求）；既有五型不变。
4. **错误码准确化**：`readImage` 失败的 `LIBRARY_TOO_LARGE`（10MB 上限）与 `LIBRARY_BINARY` 分别映射独立 i18n 文案，不再统一「图片加载失败」。
5. i18n 双语同步（skills 命名空间外的 `library` ns）。

### 1.3 留档（本批不做，后续各另批）
- PDF/音频/视频预览：需播放器依赖（`expo-video`/`react-native-pdf` 类）+ relay 分块传输协议，独立批裁定。
- 文件上传/导入、Markdown/CSV 编辑、缩略图：A5 spec 已另批。
- 无头端 library 管理模块：另批。

## 2. 测试与验收
- face：readImage svg 白名单放行的 tap 用例（既有测试文件扩）。
- mobile：预览分流纯函数用例（html/csv/svg/bmp/ico/五型各分支 + 扩展名大小写）；CSV 解析与截断策略用例（200×20 边界、引号内逗号/换行）；错误码映射用例；既有 510 零红。
- 根 typecheck + mobile typecheck + prettier；分提交。

## 3. 风险
- CSV 解析手写 splitter 需处理引号包裹（`,`、`"`、`\n` 转义）——用例钉死边界；不引第三方库。
- WebView 在 Android 真机 data: URL 兼容性——svg/html 均经 FilePreviewModal 既有分支先例（聊天图片链已定案），按同手法。
