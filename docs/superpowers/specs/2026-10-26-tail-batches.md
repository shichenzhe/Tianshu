# 尾部批次设计 spec（A2 尾导入导出 / A3 尾 zip 上传+统计 / P1 尾桌面角标）

日期：2026-10-26
状态：直接开工（事实面已核实）
关联：[[user-rulings-2026-10-26]]；A2/A3/A4 批与 P1 批的 v1 裁剪回填

## A2 尾：专家导入导出（JSON 内容面）
**事实**：`assistant.repo` 已有纯函数 `serializeExpert`（剔除 id/builtin/sourceSlug/时间戳，产 `{kind:"tianshu-expert",version:1,...8字段}`）/`parseExpertJson`/`dedupeName`，桌面 expert-io 测试钉死形状。
**裁定**：
- 端点 2 新段：`assistant/export {id}` → `{json: string}`（归属校验；builtin 同样可导——内容是用户可见的）；`assistant/import {json}` → 新建记录（parse 失败/缺 name/kind 不符 → ASSISTANT_INVALID；重名经 dedupeName）。
- 桌面 face expert-tap 包纯函数；移动端 /experts 我的段加导入（粘贴 JSON/文件选入 → expo-document-picker 读文本）与导出（详情页导出 → 剪贴板/分享）入口。成员团 JSON 含 members 时透传（编辑面不做，但导入允许携带——与桌面导入同语义，先核对桌面 import 是否支持 members，支持则透传）。
- 移动端 i18n 双语；DTO 不泄本机路径（纯内容面零路径）。

## A3 尾：技能 zip 上传 + 统计面
**事实**：`skill-installer.ts:154 installFromBuffer` 已存在（桌面本地 zip 安装同链路）；`skillStat` 表存在（schema:190）。
**裁定**：
- 端点 1 新段：`skills/installUpload {name, base64}`——base64 zip ≤5MB（对齐 files/uploadImage 3MB 还是放宽 5MB？取 3MB 同 files 口径，relay 单帧 4MiB 余量约束）；服务端解码落临时文件走 installFromBuffer 同语义（冲突/覆盖/builtin 拒口径复用）；手机文件经 expo-document-picker 选 zip。
- 统计面端点 1 新段：`skills/stats {}` → `{name, usedCount, lastUsedAt}[]`（skillStat 表结构先读——字段名以 schema 为准；移动端技能详情弹层加统计行）。
- SDK：skills 不在自动覆盖组——显式补。

## P1 尾：桌面未读角标 UI（本地面）
**事实**：P1 批已落 `listAllSessionsSummarized(userId)`（含 unreadCount/lastMessage）与 markSessionRead 单调游标；但桌面**本地**会话列表仍走旧 listAllSessions（SessionTreePanel），桌面 UI 无角标；桌面会话打开也无已读推进。
**裁定**：
- repo：`listAllSessions` 本地面不动（IPC 兼容性）；新增本地 read 推进：打开会话/消息定稿时 `markSessionRead(sessionId, maxMessageId, userId)`——挂载点在 ChatPane/MessageList 数据就绪后（参照移动端 loadHistory 后上报的先例）。
- 桌面 UI：SessionTreePanel 会话行加未读计数点（≥100 显 99+，主色调；与移动端同视觉语言）；**不做**末条消息预览第二行（桌面行高紧凑，角标即可）——预览仅移动端。
- 本地 session:list IPC 切 enriched（前端 SessionRecord 加可选 unreadCount/lastMessage——本地全量列表，两条 groupBy 开销可接受）；既有桌面测试同步。
- 不做：app 图标推送角标（无推送通道，留档）；多设备已读（实例级共享已读裁定不变）。

## 通用
- 端点入 ENDPOINTS 即触发 mirror 钉测试 + 无头端 SDK（session 组自动；assistant/skills 组显式补）。
- 无头端同步：assistant export/import、skills installUpload/stats 同批（toolPermission 先例：表在双端，写面两端同语义）；桌面 face 与无头端共享 skill-installer 语义（无头端有无 installer 先读，无则按桌面 golden 移植 installFromBuffer 语义）。
- 分提交；全量测试绿收口。
