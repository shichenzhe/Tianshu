# 聊天附件体验优化（参照 WorkBuddy）设计

日期：2026-10-17
状态：已与用户确认方向（FileBlock 块型卡片 + 编辑态附件可管理）

## 1. 背景

粘贴/引用多张图片或文件到聊天框的三个体验问题：

1. **附件无显式删除按钮**：`AttachmentPill`（`ChatInput.tsx`）点击 pill 本体即删除，
   但无 X 图标、无 tooltip，交互不可发现。
2. **编辑重发附件不可理解**：后端 `editAndResend` 保留 image 块（不丢图）；非图片
   文件内容以注入文本 `[引用文件 X]\n全文` 回填进 EditBar——行为不丢附件，但编辑框
   被注入文本灌满，用户无法分辨「附件」与「正文」，也无法单独移除某附件。
3. **多文件竖排占满面板**：非图片文件发送时全文注入 user 消息 text 块
   （`buildInjectedContent`），多个文件内容从上往下堆一大坨；图片已有 ImageBlock
   横排缩略图（体验已达标）。

### WorkBuddy 参照（asar 解包确认）

- 输入框附件为块式编辑器内联元素：文件 = 带图标紧凑卡片（title + filePath +
  icon），图片 = 内联缩略图，均带管理入口
- 消息面板：图片 `cr-image-block` 点击放大；文件引用为紧凑卡片，**不展开全文**
- 天枢差距根源：非图片文件没有对应 ImageBlock 的独立块型

## 2. 目标 / 非目标

**目标**

- 输入框附件 pill：显式 X 删除按钮；图片附件显示缩略图预览
- 消息面板：文件附件渲染为紧凑卡片（图标 + 文件名 + 大小），默认折叠可展开，
  与图片缩略图同一横排区
- 编辑重发：EditBar 顶部附件行（图片缩略图 + 文件卡，各带 X 单删），正文区只
  回填用户原输入
- 模型侧行为零变化（回喂文本顺序与口径不变）

**非目标（YAGNI）**

- 输入附件拖拽排序、多图 lightbox 翻页
- WorkBuddy 式全内联块编辑器（P3 期已刻意迁移到 pill 行 + 镜像层，不回退）
- new-task / ProjectChatBar 主动改造（协议就绪后自然兼容，不单独动）
- automation 域附件链路改造

## 3. 设计

### 3.1 FileBlock 协议（@tianshu/protocol）

```ts
/** 用户消息文件附件块：注入内容随块落库（与旧全文注入 text 块数据量等价），
 *  UI 紧凑卡片展示，模型回喂展开为前缀文本 */
export interface FileBlock {
  type: "file";
  fileName: string;
  content: string;
  refKind?: "file" | "skill" | "todo";
}
```

- **不存磁盘路径**：临时文件会失效、泄露本机路径；渲染层发送前已读好内容
  （512KB 预检上限），随块传递即最终态
- `refKind` 区分引用来源（@ 工作空间文件 / 资料库 pill / 粘贴附件统一
  `"file"`；`"skill"` 技能；`"todo"` 待办），仅影响 UI 图标与回喂前缀文案
- `MessageBlock` 联合类型加入 FileBlock
- 同步点：`packages/tianshu-core/src/blocks.ts` 的 `isValidBlock` 增加
  `case "file"`（`fileName`、`content` 均 string；refKind 可选不校验值域，
  与历史容错口径一致）；渲染层 `src-react/.../chat/model/blocks.ts` 的本地
  `isValidBlock` 同步（该文件已 re-export 类型但保留本地实现）

### 3.2 发送链路

- `@tianshu/protocol` `ChatSendParams` 增加：
  `files?: ChatSendFile[]`，`ChatSendFile = { name: string; content: string; refKind?: "file" | "skill" | "todo" }`
- `ChatApi.send` 归一化扩展：空 files 归一化掉（同 images 现状，无附件载荷不变）
- 渲染层 `ChatInput.submit`：非图片 `PendingFile` 不再经
  `buildInjectedContent` 拼进 content；`ChatPane.handleSend` 将 textFiles 转为
  `ChatSendFile[]` 随 send 传递（`splitImageFiles` 扩展为三分流：
  textFiles / images 结构不变，textFiles 即转 files）；`PendingFile.kind →
  refKind` 映射：`"file" | "localFile" | undefined → "file"`、
  `"skill" → "skill"`、`"todo" → "todo"`
- `buildInjectedContent` 保留（new-task / 项目 dispatch 等纯文本注入消费方不变）
- 后端 `sendRound`（`chat.service.ts`）落库顺序：
  `[...fileBlocks, { type: "text", text: content }, ...imageBlocks]`
  - **顺序理由**：`blocksToModelMessages` 回喂时 parts 保序、image part 由
    `mergeTextPreamble` 前置——file → text 的块序使模型视角（图片 → 文件前缀
    → 正文）与现状完全一致
  - fileBlocks 由 params.files 直接映射（后端不重读磁盘，渲染层已读）
- 回喂：`blocksToModelMessages`（tianshu-core）`file` 块展开为 text part，
  前缀口径复用 `referencePrefix`——该函数从渲染层
  `build-injected-content.ts` **收编 core 并导出**，渲染层改 import
  （两处文案单一来源，new-task 注入行为不变）

### 3.3 消息面板渲染（问题 3）

- 新组件 `MessageFileCard`（`src-react/.../chat/components/`）：
  - 折叠态：`FileText`（按 refKind：skill=`Zap`、todo=`ListTodo`）图标 +
    fileName + 内容大小（`formatBytes` 风格）+ 展开箭头（`ChevronDown`）
  - 展开态：content 以 `whitespace-pre-wrap` 文本展示，`max-h-64` 限高滚动
  - 点击卡片头部切换展开/收起
- `MessageItem` user 分支：file 块与 image 块统一汇入附件横排区（现有
  `imageThumbnails` 容器扩为 `attachmentRow`：文件卡 + 图片缩略图 flex-wrap）
- `groupBlocks`：file 块不进 texts/thinking（user 消息不走 groupBlocks 主流程，
  仅确认 parse 后 filter 即可；assistant 消息理论无 file 块，防御性忽略）
- 折叠内容**不参与**会话内搜索命中计数（`countHits` 只走 text 块，现状不变）

### 3.4 编辑重发三层同改（问题 2，memory 三层同构陷阱）

- **后端** `editAndResend(messageId, content, attachments?)`：
  - 第 4 参可选；缺省 = 保留原消息全部 file/image 块（对齐现 keptImages 语义）
  - 传入 = 完整剩余附件块数组，落库 `[...fileBlocks, text, ...imageBlocks]`
    （file 在前 text 在后，同 send；attachments 中 file 块在前 image 块在后
    由前端保证顺序，后端不重排）
  - `chat.service.ts` IPC handler 注册与 `ChatApi.editAndResend` 签名同步
- **前端乐观更新** `truncateMessagesForEdit(messages, messageId, text, attachments?)`：
  同口径——缺省保留原 file/image 块，传入则用传入块
- **编辑态 UI**：
  - `handleEdit`：解析目标消息 blocks，text 块拼接为回填文本，file/image 块
    解出附件列表存入 editing state（`{ messageId, text, attachments }`）
  - `EditBar` 新 props：`attachments: EditableAttachment[]`（file 块含
    fileName/refKind、image 块含 imagePath/name）、`onRemoveAttachment(index)`
  - EditBar 顶部附件行：图片缩略图（复用 `MessageImage` 的读取通道
    `file:readMessageImage`，只读小尺寸）+ 文件卡（复用 `MessageFileCard`
    折叠态，不可展开），各带 X 移除；移除即从本地 state 剔除，提交时以剩余
    附件传 `onEditSubmit(text, attachments)`
  - 提交空文本且有附件时允许重发（现状空文本禁用；附件在即有效输入）
- **旧消息兼容**：注入文本时代的旧 user 消息编辑时，text 块即注入全文——
  回填行为同现状（编辑框含注入文本），不强拆（正则拆注入文本不可靠，明确
  不做）；新消息（FileBlock 落库后）自然分离

### 3.5 输入框附件 pill（问题 1）

- `AttachmentPill` 重构：
  - pill 本体不再是删除按钮；布局 = 图标/缩略图 + 文件名 + **常显 X 按钮**
    （`X` icon，button 嵌套注意：pill 改为 div，X 为唯一 button）
  - X 按钮：`aria-label`（i18n）+ hover 高亮（`hover:bg-primary/10`）
- 图片缩略图：`PastedFileEntry` 为图片路径（`isImagePath`）时，pill 图标位
  以缩略图呈现——经 `file:readMessageImage`（imagePath 参数须为数据根相对
  路径；粘贴截图已落盘 attachments/ ✓，Finder 复制图片为外部绝对路径 ✗）
  - 外部绝对路径图片：缩略图读不到时图标兜底（不新增授权 IPC，YAGNI）
- 现有横排布局不变

### 3.6 i18n

`chat` 命名空间新增（zh-CN / en-US 同步）：

- `chat:attachment.remove`（X 按钮 aria/tooltip：「移除附件」/ "Remove attachment"）
- `chat:message.fileExpand` / `chat:message.fileCollapse`（文件卡展开/收起）
- `chat:message.editAttachmentHint`（EditBar 附件行说明：「重发将携带以下附件」）
- `chat:attachment.emptyResendForbidden` 场景如有需要（空文本无附件禁用提示沿用现状）

## 4. 双仓协同

- `@tianshu/protocol`、`@tianshu/core` 均为双仓共享：改源码后须
  `npm --prefix packages/tianshu-core run build` 重建 dist（tianshu-server 经
  file: symlink 消费）
- tianshu-server 侧伴生（实施时核查）：
  - server 的 chat send 落库点若独立构造 user blocks，需同步 files →
    fileBlocks 映射
  - `blocksToModelMessages` 由 core 提供，server 自动获得 file 块回喂
  - relay 帧透传 ChatSendParams：`files` 字段原样透传（ChatStreamChunk 全透传
    先例），server 接收端 schema 校验如有需放行
- `npm run check:drift` 基线：涉及双份文件（`build-injected-content` 等）若
  有收编调整，按流程 `--rebase` 重置并人工复核

## 5. 兼容性

- **历史消息**：旧注入 text 块原样渲染（全文展示，无回归）；`parseBlocks`
  对未知 type 丢弃（旧版本读新库时 file 块被静默滤除——可接受，与 ImageBlock
  引入时同口径）
- **模型行为**：回喂文本内容与前缀口径不变、顺序不变（图片前置 → 文件前缀 →
  正文），模型侧零变化
- **乐观消息**：`buildOptimisticUserMessage` 附带 fileBlocks（渲染层发送时
  手上有全部数据，发送瞬间即见文件卡片，不等流末 invalidate）

## 6. 测试计划

- `tests/ai/blocks.test.ts`：FileBlock parse/serialize 校验用例（畸形丢弃、
  refKind 缺省）
- `packages/tianshu-core` 侧 blocksToModelMessages：file 块展开顺序（file 前
  text 后、图片前置不变）
- `tests/ai/chat-input-paste.test.tsx`：pill X 按钮移除单个附件
- `tests/ai/message-item-edit.test.tsx`：编辑态附件行渲染、X 移除、提交携带
  剩余附件
- `truncate-messages-for-edit.test.ts`：attachments 缺省保留 / 传入替换
- 后端 sendRound / editAndResend：落库块顺序断言（如现有测试覆盖模式允许）
- 全量：`npm run test`、`npm run typecheck`、`npm run check:drift`

## 7. 风险

- **三层同构**（memory 教训）：editAndResend / truncateMessagesForEdit /
  EditBar UI 漏一处 = 附件丢库或视觉消失——实施清单逐点核对
- **server 伴生滞后**：core dist 未重建或 server 未放行 files 字段 → server
  侧发送丢附件；实施时同步验证 relay 链路
- **块序敏感**：fileBlocks 前置于 text 的落库顺序是模型视角等价的关键，测试
  锁定
