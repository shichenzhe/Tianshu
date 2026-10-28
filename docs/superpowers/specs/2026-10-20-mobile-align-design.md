# 天枢移动端能力对齐（MB 批：Mobile UI Align 单 UI 面同步）

- 日期：2026-10-20
- 状态：设计定稿（自主决策口径），待用户审阅
- 前置：HD spec P1-P3（桌面单 UI 多主机）、FA 批（远程文件面）
- 上游决策：E 任务「移动端对齐桌面单 UI 交互形态」

## 1. 背景与目标

**问题**：桌面单 UI 这轮（HD/FA）把远控协议面推到了新水位——workspace 分组、
files 三端点、send images、regenerate——移动端（apps/tianshu-mobile，Expo/RN
独立 UI）全部未消费，能力面断层扩大。

**目标（P1 裁剪）**：移动端接上**价值最高的三项**对齐桌面交互：

| 能力 | 桌面现状 | 移动端落地（本批） |
|---|---|---|
| 图片多模态发送 | 粘贴/上传 → files/uploadImage → sessionSend.images | 选图（系统选择器）→ uploadImage → send images |
| 会话列表 workspace 分组 | HD-A2 侧栏分组树 | workspace/query → SectionList 分组 |
| 消息重生成 | regenerate 端点 | 长按 assistant 消息 → 重生成 |

**非目标（P2+ 长尾）**：@ 文件联想（移动端无键盘联想场景）、编辑重发、
权限胶囊、usage、技能/专家子菜单、orchestration 深化——按需后续批。

## 2. 设计

### 2.1 图片发送链（MB-T1）

- 依赖：`expo-image-picker`（Expo SDK 57 配套；`npm install -w` 装入 mobile）
- Composer 增附件按钮：`files` capability 门禁（connections 层缓存已有
  `useConnectionCapabilities`——含 files 才渲染）；选图（质量压缩 0.7，
  上限 3MB 对齐被控端/relay 余量）
- 上传时点：**发送时**（对齐桌面 FA 口径——挂图仅暂存本地 URI，send 时
  `files/uploadImage` → imagePath → `session/send` images）
- stream.store `startSend` 扩可选 `images?: string[]`；发送中附件锁定
- 渲染侧零改动（MessageImage 已闭环：ImageBlock → POST image → dataUrl
  缓存）；乐观插入不携图（live 块外图片发送后经历史重拉呈现——简化，
  对齐移动端既有乐观插入只做文本的现状）

### 2.2 会话列表分组（MB-T2）

- `workspace/query` 拉概要（新 transport 面 `logic/workspace.ts` + 单测）
- index 屏 FlatList → SectionList：按 workspaceId 分组（组头空间名），
  未匹配会话进「未归属」组（对齐桌面 HD-A2 兜底语义）
- workspaceId 从 session.query 行透传（face/headless 均已透——HD-A2）

### 2.3 消息重生成（MB-T3）

- MessageItem assistant 轮长按菜单（`Pressable onLongPress` + 简易
  ActionSheet）：「重新生成」→ `session/regenerate`（messageId 缺省=末条）
- sending 态互斥（流中禁用菜单项）；错误 toast 既有通道

### 2.4 测试与冒烟（MB-T4）

- 单测：workspace 分组纯函数（对齐 sessions.store 既有测试风格）、
  startSend images 载荷、选图上限预检
- `npm run test -w apps/tianshu-mobile`（vitest）+ typecheck 绿

## 3. 风险与假设

1. **假设 1（依赖）**：expo-image-picker 装包与 SDK 57 兼容（Expo Go 内置
   支持）；若 native 重构建受限（Expo Go 场景），退化为 `expo-document-picker`
   （同样 base64 可读）
2. **base64 读取**：expo-image-picker 返回 URI → `expo-file-system` readAsText
   (base64)——file-system 是 Expo 必带依赖，无新增
3. **relay 3MB**：与桌面同口径——选图压缩参数（quality 0.7 + allowsMultiple
   false）控制体积，超 3MB 前置拒并提示
4. **旧被控端**：capabilities 无 files 时按钮不渲染（零迁移同桌面）
