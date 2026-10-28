# 移动端本地产物（artifact）收藏面板批设计 spec

日期：2026-10-27
状态：直接开工（用户「推进移动端」授权；render-align 批留档「artifact 收藏面板另行立批」之兑现）
关联：mobile-desktop-gap（A 类差集收官后的最后实体缺口）；A5 library 批先例（DTO 不泄路径/桌面被控面专属/端点缺失自隐藏）

## 0. 事实基线

- **表只在桌面端**：`artifact`（write_file 结构化登记，userId+workspaceId+relPath 唯一）与 `artifactFavorite`（workspaceId+relPath 键收藏）在 mirror prisma；**无头端无表无面**（chat-runner 移植未含 artifact 落库）——本批同 A6 monitor/A5 先例为桌面被控面专属，无头端零改动。
- **桌面链路现成**：`session.repo.listArtifacts(userId)`（聚合 workspace/session 名 + favorite 态 + 并行 stat 剔已删文件 + 历史首查回填）；`ArtifactApi` 五通道（readFile/revealFile/exportFile/listArtifacts/toggleArtifactFavorite）；UI 挂 LibraryView「artifacts 视图」（LibraryArtifactsView）。
- **`ArtifactListItem.path` 是绝对路径**（桌面本地面）——协议 wire 契约必须剔除（library 批「DTO 不携带本机路径」纪律）。
- **移动端挂点**：`app/library.tsx`（资料库页，单树视图无 segment）——桌面信息架构即「资料库内本地产物视图」，移动端同构。

## 1. 本批裁定

1. **协议**（`@tianshu/protocol`，冻结后重建 dist）：
   - `ENDPOINTS.artifact` 三段：`list` / `toggleFavorite` / `read`；
   - 契约类型 `ArtifactWireItem`（与桌面 ArtifactListItem 同形**减 path**：relPath/name/fileType/workspaceId/workspaceName/sessionId/sessionTitle/writtenAt/size/favorite 十字段）；`ArtifactToggleFavoritePayload {workspaceId, relPath}` → `boolean`；`ArtifactReadPayload {workspaceId, relPath}` → 判别联合 `{kind:'text', content} | {kind:'image', mime, dataBase64}`（对齐 library read/readImage 口径）；webview 类（html/pdf/音视频）业务错 `ARTIFACT_PREVIEW_UNSUPPORTED`（移动端 toast 桌面端预览——A5 尾同款语义）。
   - 不加 capability 字——移动端以 `artifact/list` 首 404 隐藏视图（网络等其他错误显可重试态；端点缺失自隐藏先例：MT 权限胶囊）。
2. **face**（mirror server-face）：routes 三端点注册 + artifact-tap 薄包（list 调 `session.repo.listArtifacts`（repo 层注入，face 组装 spread 丢原型陷阱注意——类方法点名包装）；toggleFavorite/readFile 走对应既有主进程实现；DTO 剔 path 钉测试）。
3. **移动端**：library.tsx 页头增视图切换（文件夹树 ↔ 本地产物）：
   - 列表：行 = 文件类型图标 + name + sessionTitle + writtenAt（相对时间）+ 收藏星（toggleFavorite 就地翻转）；按 workspace 分组（桌面先例）；
   - 预览：text 全屏只读（复用 library 文本预览组件）；image 走 dataBase64 图片；webview 类错误 toast「请在桌面端预览」；
   - 404 隐藏视图（入口不渲染）；store 防迟到序号按资源拆分纪律（list/toggle 各自 seq）。
4. **i18n 双语**；**不做留档**：revealFile/exportFile（宿主动作/下载分享，expo-sharing 另批）；无头端 artifact 面；桌面渲染层零改动。

## 2. 测试与验收

- mirror：协议钉测试 artifact 三段入册；face tap 用例（聚合行形/收藏切换/文本读/图片读/不支持类 ARTIFACT_PREVIEW_UNSUPPORTED/DTO 无 path——`JSON.stringify(result)` 不含 `"path":` 钉断言）。
- mobile：store 用例（404 隐藏语义/收藏就地翻转/防迟到）；UI 用例（视图切换/列表行渲染/预览打开）；i18n 齐平；既有全量零红。
- 根 typecheck + prettier；分提交。

## 3. 风险

- `listArtifacts` 含「历史消息首查回填」重逻辑（LIKE 扫）——face 首拉可能慢，移动端 loading 态显式；不做超时裁定（数据量级同桌面本地面）。
- readFile 的守卫语义（512KB/二进制拒）与 library/read 同口径——face 复用同一实现源避免双份。
