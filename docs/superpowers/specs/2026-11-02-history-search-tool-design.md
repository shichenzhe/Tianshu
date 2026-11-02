# 会话历史检索工具 search_history + 压缩摘要回捞线索设计 spec

日期：2026-11-02
状态：已入库（实施待排批；对话内 2026-11-02 用户「整个spec 入库」授权立 spec，未授权开工）
关联：WorkBuddy conversation_search 逆向（v5.9.3 `prompt-common/fragments/workbuddy-memory-system.md`，2026-11-01 提取件）；上下文三级裁剪既有批（tool-output-trim spec §18 项 1 / autoCompact §18 项 2）；2026-11-01-default-context-window（裁剪链兜底已落地，本批不再涉及）

## 0. 事实基线

- **三级裁剪全部单向有损，丢了的细节对模型永久不可达**：tool-output-trim 注释自认「DB 原文对模型不可达，防误导」；autoCompact 后 `compactedUpToId` 之前的消息整体不回喂（摘要 system 注入替代）；truncateHistory 滞回硬截丢头部。摘要若丢了某个文件路径，模型只能瞎猜——WorkBuddy 敢做有损压缩的前提是检索工具兜底（需要时一次调用捞回原文）。
- **WorkBuddy 同功能形态**（逆向）：`conversation_search` 工具检索用户**全部历史会话**（服务端 ranking）；三个刻意设计——①**对当前会话零访问**，查询必须自包含（描述找什么+已知时间/背景，防拿当前上下文指代偷懒）；②**检索路由分层**（当前上下文已有→不查；本项目历史→本地日志；跨项目/不确定→检索）；③职责隔离（只查过去具体事件/讨论，不查偏好习惯——那是画像的事）。
- **天枢已有检索类工具先例**：`electron/domains/ai/agent/library-search-tool.ts`（资料库检索，2.7K）与 `read-skill.ts`——新工具形态对齐即可；工具注册走 `registerTools` + `filterDisabledTools` 禁用面统一收口。
- **数据面**：`message` 表 blocks 为 JSON 字符串（text/thinking/tool_call/image 块数组），无 userId 列——隔离须经 `session.userId`（v12 冗余列）关联；`session` 有 title/summary/workspaceId/projectId/lastMessageAt。检索命中 tool_call 的 args/output 是特性不是噪音（找回被瘦身掉的旧输出正是本工具价值）。
- **FTS5 跨端约束**：mirror better-sqlite3 栈有 FTS5，server Prisma 引擎栈没有（SQLite 特性选型不可跨端假设）——检索实现 LIKE 起步，不假设 FTS5。

## 1. 本批裁定

1. **新增 `search_history` 工具**（`electron/domains/ai/agent/history-search-tool.ts`，首批 mirror 单侧）：
   - 参数：`query`（必填，自包含描述）、`limit`（默认 5 会话，上限 10）。无当前会话参数——execute 闭包持有 currentSessionId，**查询范围天然排除当前会话**（对齐 WB「零访问」设计，模型侧无绕过面）。
   - 实现：`message.blocks LIKE '%query%'`（Prisma `contains`），经 session 关联过滤 `session.userId = 当前用户`；按会话聚合返回，会话排序取 `lastMessageAt` 倒序。命中片段提取优先 text/thinking 块文本，tool_call 命中则取 output 头部；每会话至多 3 个命中片段、每片段 ≤300 字符（头尾截断加省略号），总返回量控制在 tool-output-trim 的 6000 字符阈值内（防工具自身即被瘦身）。
   - 返回形态：纯文本工具结果（无渲染语义，前端零改动），行格式 `- 〈会话标题〉（YYYY-MM-DD）：片段…`；空结果返回明确文案「未命中历史会话」+建议改写查询（自包含+时间范围）。
   - 注入面：常驻注册（同 read_skill），agent/ask/plan 全模式可用；禁用走 filterDisabledTools 既有收口。
2. **description 写明检索路由分层**（WB 逆向原样吸收）：「仅当需要当前上下文中不存在的过去事件/讨论/文件路径时调用；查询必须自包含（描述目标+已知时间范围）；当前上下文已有或任务自包含时不调用」。
3. **COMPACT_DIRECTIVE 增补回捞锚点**（chat.service.ts:197）：摘要指令追加「关键事项保留发生日期与文件路径原样」——日期/路径既是摘要语义本就该保留的信息，也是 search_history 的天然查询词；AUTO_COMPACT_DIRECTIVE 前缀继承自动生效。两项改动同批落地才有意义（检索工具先行亦可独立验收）。
4. **单测**：片段提取纯函数（多块型命中/超长截断/text 优先）+ 查询组装（userId 过滤/当前会话排除/limit 边界）；COMPACT_DIRECTIVE 变更同步既有 compact 用例断言。

## 2. 非目标（留档）

- server 端同构（apps/tianshu-server 工具面）——首批 mirror 验收后另批移植；drift 不涉及（mirror 单侧新文件，无既有双份基线变动）。
- FTS5/向量化会话检索（LIKE 起步；个人桌面量级 message 表可控，性能不足再演进——vectorChunk 体系是资料库的，不混入会话历史）。
- 按模型名 contextWindow 查表预填（2026-11-01-default-context-window 已裁定非目标，不翻案）。
- 会话收尾实时写记忆/工作区日志（2026-10-23 产品级决策搁置，不借本批重启）。
- WB 大基座条件模板体系（反向教训：天枢 3.5K 小基座是优势，不抄）。
- 跨用户/跨 workspace 收紧开关（默认全用户历史对齐 WB 价值面，后续按反馈加作用域参数）。

## 3. 风险

- **LIKE 全表扫**：无 FTS5 时 `contains` 走全表；桌面单用户 message 量级（万条级）SQLite 可承受，先按 session.userId 过滤收敛扫描面。若实测慢，限近 N 个月会话兜底（记入实现注释，不做预设）。
- **模型滥用（每轮先查一遍）**：description 路由分层指引 + WB 同构已验证该形态可行；工具结果空文案回指改写建议，二次无效调用模型自会放弃。
- **检索结果引入旧会话敏感内容进当前上下文**：userId 隔离已保下限（同用户自己的历史）；同用户跨 workspace 语义上等同 WB 全历史，属设计选择而非泄漏。
- **摘要锚点指令效果依赖模型遵从**：日期/路径保留本就是摘要常识任务，指令是强化非引入新能力；不遵从也不损既有语义（检索仍可全文命中）。
