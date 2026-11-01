# 技能引用消息块结构化设计（skill_ref block，参照 WorkBuddy）

- 日期：2026-10-30
- 状态：已实施（2026-11-01，merge 632d9f37 四提交全链落地——§3.1-3.5 与 §5 顺序执行；§6 不动面维持另批）
- 影响面：`packages/tianshu-protocol/src/chat-contract.ts`、`packages/tianshu-core/src/blocks.ts`、桌面 chat 发送/渲染链（ChatInput/ChatPane/useChatSend/MessageItem/chat.service）、`apps/tianshu-server`（chat-runner/messages API）、`apps/tianshu-mobile`（session 页发送/渲染、blocks）

## 1. 背景与根因

引用 `⚡技能` 发送时（桌面 `ChatInput.submit` / 移动端 session 页 onSend），`readSkill` 读全文以 `[引用技能 name]\n<全文>` 前缀拼进消息 text 落库——「文件引用注入在渲染层完成（spec §5），主进程零改动」的既定设计。

移动端渲染 `splitFileRefPrefix`（`apps/tianshu-mobile/src/logic/file-refs.ts:76`）按 `\n\n` 空行平面切段、只认头部连续命中段、「首个不匹配段即止」当正文。**该策略假定注入块内不含空行，而 markdown 技能全文必然含空行**（workflow-creator 实测 4719 字、28 处空行）→ 技能段在首个空行处被切断，卡片只拆出第一片，**其余全文全部留在 rest 进气泡**，与用户原文混排。已用移动端真实源码构造复现验证（含空行 → 泄漏；无空行 → 拆分完美）。

桌面端 `file-ref-lines.ts` 同源同策略，但**技能块有意不拆**（注释明示"技能/待办前缀不在此列，保持原样显示"）——桌面气泡原样显示头+全文。

本质缺陷：**引用块与正文的边界在纯文本上歧义**（块内 `\n\n` 与块间分隔同形），渲染侧从扁平文本逆推无完美解。文件内容注入式（本地文件/ask 回退）同病，本批不动（见 §6）。

## 2. 用户裁定与 WorkBuddy 参照

用户裁定：与桌面端保持一致；参照 WorkBuddy 做法。

WorkBuddy 逆向（asar 解包 `contexts-B8WkfybU.js`，2026-10-30）：

- 技能引用是消息 `contentBlocks` 里的**结构化 `resource_link` 块**：`{type:"resource_link", uri:"skill://<skillId>", _meta:{type:"skill", mentionType:"skill", displayText, skillId}}`（`buildSkillBlock`）。
- 气泡渲染 inline chip（readOnly、无关闭钮）；队列预览同款 chip + 文本行。
- **消息文本里没有技能全文**——全文由 agent 层（codebuddy CLI SkillProductProvider）在模型消费时按块解析。
- 文本序列化（引用 token 回显/预览提取）用 `@skill:<name>` 形态。

即 WorkBuddy 是「消息结构化块」方案：技能引用独立成块、渲染天然无歧义、模型消费时展开。

## 3. 方案：skill_ref 消息块

天枢 blocks 体系已单源化（块类型 `@tianshu/protocol`、实现 `@tianshu/core`，三端 re-export；server MessageRecord 已有 blocks JSON 列），加块型是顺理成章的扩展，且**模型语义逐字不变**（组装时展开同款前缀注入）。

```
发送侧（桌面/移动）                     组装侧（core 单源）                渲染侧（桌面/移动）
⚡token → skillRefs: string[] ──→ blocks: [skill_ref..., text] ──→ blocksToModelMessages
                                        │                    ├─ loadSkill 展开：
乐观/落库消息只存技能名                  │                    │  [引用技能 name]\n<全文>\n\n<正文>
（消息库不膨胀；技能改版后               │                    └─ text 块照旧（历史消息零变化）
 重发取新版全文）                        └─ 模型行为与现状完全一致
```

### 3.1 协议块型（tianshu-protocol）

`chat-contract.ts`：

```ts
/** 技能引用块（user 消息）：引用 ⚡技能 落块的形态——只存技能名，
 * 全文由组装侧 loadSkill 展开注入（对齐 WorkBuddy resource_link 语义） */
export interface SkillRefBlock {
  type: "skill_ref";
  /** 技能名（readSkill 键） */
  name: string;
}
```

`MessageBlock` 联合加入。位置约定：**引用块前置**（`[skill_ref..., text]`），与现注入前缀语义同序。

### 3.2 组装展开（tianshu-core）

`blocksToModelMessages(blocks, role, options)` 已有 `loadImage?: ImageDataUrlLoader` 依赖注入先例，同款加：

```ts
loadSkill?: (name: string) => Promise<string | null>;
```

- `skill_ref` 块 → 展开为 `[引用技能 name]\n<全文>`，多块间 `\n\n`、与 text 间 `\n\n`（与现 `buildInjectedContent` 拼装口径逐字一致）。
- 读失败（null/抛错）：降级行 `[引用技能 name]（内容读取失败）`，不阻断流。
- 未传 loader（纯函数测试/窄 stub）：降级行同上。
- text 块照旧——**旧消息（text 前缀注入格式）零变化**。

### 3.3 桌面链

- `chat.service.ts`：调 `runChatStream` 处注入 `loadSkill`（与 `read_skill` 工具 execute 同源读全文）。
- 发送侧：`ChatInput.submit` 技能不再 `SkillApi.readSkill` 拼文本——`PendingFile kind:"skill"` 分流出为独立 `skillRefs: string[]`（`onSend` 签名扩展）；`ChatPane.handleSend` → `useChatSend.send` → 用户消息 blocks 组 `[skill_ref..., {type:"text",text:正文}]`（乐观插入与落库同构）。
- 渲染侧：`MessageItem` blocks 分发 `skill_ref` → 技能卡片（新建，形态对齐 `MessageFileRef`；点击 `readSkill` 弹层预览全文）。原样显示全文的旧行为随 text 前缀消息保留（历史），新消息不再出现全文。
- `splitFileRefPrefix`（桌面份）不动：继续兜历史消息的 text 前缀格式（文件块照旧消费）。

### 3.4 server 链（apps/tianshu-server）

- `chat-runner.service.ts`（runChatStream 薄包装）：注入 `loadSkill`（skills repo 读取，与 skills/read API 同源）。
- messages send API：加 `skillRefs?: string[]` 上行参数（与 images 参数同模式），server 侧组 blocks 落库。移动端不再上行全文（**省「files/read 拉全文到手机再上行回服务端」双程流量**——引用式批同款动机）。
- 自动化 `resolve-attachments.ts` 注入链**不动**（自动化 prompt 另路，无渲染拆分消费）。

### 3.5 移动端链（apps/tianshu-mobile）

- 发送侧：session 页 onSend 技能循环（`skills/read` 全文 → refs）改为 `skillRefs` 直传；乐观消息 blocks 同步组块。
- 渲染侧：`MessageItem` blocks 分发 `skill_ref` → 现有 `SkillRefCard`（点击 skills/read 预览，已就位）。
- `file-refs.ts` 的 `SKILL_REF_HEADER` 拆卡逻辑保留：兜历史消息的 text 前缀格式。**历史消息的空行泄漏维持现状，不做启发式猜测**（技能引用为 10 月新功能，历史量少；正文边界歧义无完美解）。

## 4. 历史兼容

| 消息形态 | 模型侧 | 渲染侧 |
|---|---|---|
| 旧：text 前缀注入全文 | 照旧（text 原样进 prompt） | 桌面原样显示 / 移动拆卡片（含泄漏，现状） |
| 新：skill_ref 块 + text | loadSkill 展开同款前缀，逐字一致 | 双端技能卡片 |

编辑重发旧消息：EditBar 全文口径不变（text 原样回填）；新消息编辑回填只含 text 块正文（skill_ref 块随行保留，与图片块同语义）。

## 5. 实施顺序

1. protocol 块型 + core 展开 loader + core vitest；重建 dist（`npm run sync:core`）。
2. 桌面链（loader 注入 → 发送侧块化 → 渲染卡片 + i18n 双语）。
3. server 链（loader + API）与移动端链（发送/渲染），server jest + mobile vitest。
4. 终验：历史兼容双端验证、`npm run check:drift`、跨段终验三项清单（错码存在性/载荷字段接线/状态联合同形）。

## 6. 不动面（另批）

- **文件内容注入式**（本地文件/ask 回退路径）同源泄漏——低频，待后续批（可顺势块化为 file_ref 块，协议本批已铺路）。
- fileRef 引用式（单行路径行）无空行问题，不动。
- 待办引用（todo 注入）同文本注入形态，暂不动。
- 自动化 inline-tokens / resolve-attachments 注入链不动。
