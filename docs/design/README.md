# 天枢模块技术方案总览

> 调研基线：main 分支 995bf652（2026-11-05），由 9 路并行代码实况调研生成。
> 每篇统一结构：模块定位 → 数据模型 → 核心技术方案（真实路径/函数/字段佐证）→ 三端布局 → 业界主流做法对比 → 改进空间（按优先级）。
> 路径基准：桌面端 `apps/tianshu-desktop/`（`electron/` 主进程、`src-react/` 渲染进程），server 端 `apps/tianshu-server/`，移动端 `apps/tianshu-mobile/`，共享包 `packages/*`。

## 文档索引

| # | 文档 | 模块 | 核心方案一句话 | 最高优先级改进 |
|---|------|------|----------------|----------------|
| 1 | [memory-personalization.md](memory-personalization.md) | 记忆管理 | 三层记忆：option 13 key 显式配置 + `memoryProfile` 单文档画像（每夜 LLM 从近 7 天对话提炼、全量注入 system）+ 会话级上下文管理（工具输出瘦身/滞回截断/压缩摘要/search_history 按需召回） | 复用 vectorChunk 做条目级语义检索替代 8000 字符全量注入；记忆无 userId 隔离且跨主机不同源（换主机失忆） |
| 2 | [security.md](security.md) | 安全机制 | 六层体系：scrypt+JWT 认证 / tool-gate 五级审批链（命令门→危险分级→文件门→批量删除→记忆豁免）/ 网络四层拦截+进程监控 / relay E2E（X25519+GCM+滑动窗重放拒）/ safeStorage+AES-GCM 信封静态加密 / 哈希链防篡改审计 | TOFU 指纹无用户确认 UI（P0）；E2E 无前向保密；OS 级沙箱缺位 |
| 3 | [workflow-graphs.md](workflow-graphs.md) | 工作流 | zod DSL（30 种节点 kind，Coze 式）→ validateGraph 保存期校验 → LangGraph StateGraph 编译（reducer state + 条件路由 + recursionLimit 25）单 invoke 执行；React Flow 画布⇄JSON 双模式编辑器；graphRunNode 节点级三层留痕 | checkpointer/interrupt 未接（HITL 缺位）；无断点恢复、无版本化发布 |
| 4 | [automation-scheduled-tasks.md](automation-scheduled-tasks.md) | 定时任务 | 30s tick 决策树调度器（六态纯函数 + 60s 冷却×3 重试 + inflight 进程互斥）驱动 prompt/graph 两类执行体；ScheduleConfig 六 kind 周期 + interval（无 cron 表达式）；missedPolicy=skip/catchUpOnce 错过补偿 | 重试无 backoff；无分布式锁（同库多实例场景）；时区语义 |
| 5 | [project.md](project.md) | 项目 | 「指令+资产空间+能力挂载+计划+会话+自动化」六合一容器；projectBinding 绑三类 AI 能力源（专家/技能/MCP）；planItem 扁平单表 + planView 五视图（引擎已下沉 @tianshu-core）；AI 经 todo_write/todo_read 与人共享清单（只增不删） | 项目记忆无自动沉淀；成员写面未开；删除项目无审计；plan 无层级/时间盒 |
| 6 | [library-rag.md](library-rag.md) | 资料库 | libraryItem 树 + ID 寻址磁盘存储；vectorChunk 存 JSON 向量无索引（全表载入余弦）+ 内存 BM25（Intl.Segmenter 分词）+ RRF(k=60) 融合 + /rerank 重排，全部以图节点形态内建 | **桌面端写侧自动向量化缺失**（仅 server 有，集合恒空）；library_search 两端同名异构；引用溯源 UI 缺位（P0） |
| 7 | [experts.md](experts.md) | 专家与专家团 | 专家=assistant 表人设（七步运行时拼装）；专家团=expertType="team" 携 1-13 成员、主理人四段 system 组装 + dispatch 工具调度成员真并发补全（LangGraph ToolNode），非 subagent 派生；技能 SKILL.md 三跳渐进披露；连接器=MCP 产品化皮（4K token 工具面折叠）；59 专家市场单源 core | 专家团成员调用无监控埋点；调度过程对用户不可见 |
| 8 | [monitoring.md](monitoring.md) | 监控 | 零载荷事件表 llmCallEvent/toolCallEvent（只记 token/耗时/终态）；埋点与聚合纯函数单源 @tianshu/core，桌面与无头端六处对称埋点，全量无采样；usage 源于 LangChain usage_metadata 流式多轮记账 | 桌面监控页未接 host-route（远程遥看只有移动端能看）；无成本核算；无 trace 下钻 |
| 9 | [chat-core.md](chat-core.md) | 聊天核心 | 引擎单源 `packages/tianshu-core/src/run-chat-stream.ts`：langgraph createReactAgent + streamEvents(v2) 工具循环（recursionLimit 保险丝），7 型 ChatStreamChunk 三承载同构（IPC/SSE/relay）；blocks 七型 JSON 列持久化；滞回式历史截断（headroom 0.2 保前缀缓存）；中断=非错误、内容保留落库 | 三层 contextWindow 兜底已修 672 万 token 失控，余留静态 128K 假设与 len/2 粗估；无自动重试、无会话分叉树 |
| 10 | [provider-model.md](provider-model.md) | 服务商/模型管理 | 五协议类型收口 createChatModel（LangChain 四家 ChatModel 分派，栈在 devDependencies 内联+external 互锁）；apiKey AES-256-GCM 信封（safeStorage/TIANSHU_MASTER_KEY 主密钥）+ 传输脱敏 | ⚠️ 疑似未收口：桌面 chat.service 四处直读 provider 行未走 openSecret（加密机器上或致 AUTH_FAILED，需核实）；无 fallback 路由/测速/价格元数据 |
| 11 | [skills-tools-mcp.md](skills-tools-mcp.md) | 技能/工具/MCP | SKILL.md（name/description frontmatter）每 send 重扫 + system 清单注入 + read_skill 渐进披露；约 30 件内建工具静态注册、场景门控+用户禁用两层注入过滤；20 老名→15 新名别名单源 core；MCP http（StreamableHTTP+SSRF 门）+ stdio 读面、4K token 超线折叠；权限核心在执行侧 runToolCall 硬门 | 每 send 重扫无缓存（性能）；注入过滤与执行门禁的边界需在文档与代码中持续对齐 |
| 12 | [multi-host-server-relay.md](multi-host-server-relay.md) | 单UI多主机/无头端/中继 | data-source 层 routeInvoke 双通道（本地 invoke / 远程适配器闭包）令 UI 零感知，caps 九面按连接运行时上报门控；被控端两类（NestJS 无头端/桌面 server-face）；Direct 与 Relay 同构 Transport，relay 链路 X25519+HKDF+AES-GCM 对中继零明文；relay-admin 多租户（Ed25519 AK→短效 access+CRL+kick） | queryKey 主机化；E2E 密钥棘轮（前向保密）；relay 多副本水平扩展 |

## 跨模块共性观察

调研 12 个模块后提炼出的天枢全局架构特征（非单模块事项）：

1. **单源下沉三件套贯穿全仓**：`packages/tianshu-core`（纯逻辑：chat 引擎、图 DSL/编译器、监控埋点与聚合、专家市场数据、工具别名表、E2E 加密、plan 视图引擎、RAG 检索栈）+ `packages/tianshu-protocol`（契约/事件/能力常量）+ 仍双份文件的 drift manifest 守护——这是三端对称一致性的根基，任何新逻辑默认先考虑下沉。
2. **端角色分工固定**：桌面端=执行权威与数据宿主，server 端=无头副本（摘取收编），mobile 端=纯遥控（无编辑器，2026-10-27 裁定）。
3. **双层安全模型**：注入侧过滤（场景门控/禁用清单）只做体验收敛，安全边界一律在执行侧硬门（runToolCall 五级判定）——「注入过滤非安全边界」是多模块共同设计信条。
4. **普遍缺口模式一：写侧不对称**。桌面与 server 的写链路多处不同源——library 向量化仅 server 有（#6）、provider 密钥解密仅 server 收口（#10）、记忆数据仅桌面持有（#1）。跨主机一致性是单 UI 多主机架构（#12）的下一阶段主战场。
5. **普遍缺口模式二：元数据缺失**。model.contextWindow 曾全 NULL 致截断失控（#9 已修但余静态假设）、无价格表致成本无法核算（#8）、无能力协商致 fallback 路由缺失（#10）。
6. **HITL 断层**：工具级审批门禁成熟（#2），但工作流级 interrupt/审批未接（#3）、专家团调度过程不可见（#7）——人机协同在「图」与「团」两个多步执行体上是共同短板。

## 全局优先改进汇总（2026-11-05 落地批后状态）

以下为原汇总表的执行结果：**P0/P1 中 9 项已落地**（2026-11-05 落地批，19 commit 自 32a176de 起），其余按规模挂账。

### ✅ 已落地（2026-11-05 落地批，各篇 §6 已标 ✅）

| 原优先级 | 事项 | 落地 commit |
|----------|------|-------------|
| P0 | 桌面 chat 引擎 provider apiKey 解密收口（实况 6 处裸读点）+ 加密降级状态透出 | 59ea9f00 |
| P0 | 监控页 host-route 化 + 主机页用量摘要卡 + server 事件 90 天保留期裁剪 | 50fc70e6 |
| P0 | TOFU 指纹用户确认仪式（首连确认卡+确认后强制校验）+ 连接详情指纹常显 | 4e644049 |
| P0 | server 操作日志启用（配置驱动）+ 非 loopback 无 TLS 启动告警 | 1787a8cb |
| P0 | 资料库桌面写侧向量化（vectorizeLibraryContent 收编 core）+ 递归切块 + library_search 语义版 | d1befe67 |
| P1 | 记忆 userId 命名空间隔离（迁移三态不断忆）+ 注入预算治理 + 条目溯源逐条删除 + 「记住这个」入口 + 导出/导入 | 1712db39 |
| P1 | 模型元数据：capabilities/价格/fallback 四列 + 内置模型目录回填 contextWindow + 成本折算三端 + benchModel 测速 + comfyui 显式分支 | 3dcb4af8 |
| P1 | 瞬态错误重试 + fallback 按备选自身参数/窗口构造（修复环） | 3dcb4af8 + a2608dbf |
| P1 | 专家团成员调用埋点（llmCallEvent meta 列）+ memberReport 块（三份 blocks 同形+折叠卡）+ 截断丢失提示 | 6a60b9e3 |
| — | 图运行快照留痕 + webhook 触发互斥 + notify 无头端降级标注 | 2249f375 |
| — | 自动化重试指数退避（classifyError 可重试面）+ 错过补跑参数化 + 统计每日 rollup | 6c1ca49b |
| — | queryKey 主机隔离（hash 中心收口）+ protocolVersion 协商 + 直连明文警示徽标 | c1d089aa |
| — | MCP 调用进监控聚合（mcp__ 分组+按 server 视图） | 1787a8cb |
| — | 技能级工具声明（SKILL.md tools 字段）+ MCP 折叠会话自适应 + toolPermission lastUsedAt 治理 + 审批参数级 pattern（元字符守卫 7 例红线） | 1b917a78 |
| — | 项目记忆沉淀（memory.md 双层上下文+无标记内容保留）+ 项目域三类审计 + 附件死链治理 + 失效挂载清理 | 07c4e17f + 26d08a33 |

### 📋 挂账（需单独立项或用户裁定）

**大工程类（建议独立 spec 立项）**：
- 工作流 checkpointer/断点恢复 + HITL/interrupt（需审中心支撑）｜#3
- sqlite-vec 真向量索引（双 ABI 链纳入 setup:native）｜#6
- E2E 密钥双棘轮（前向保密，wire 契约演进）+ OS 级沙箱（sandbox-exec/Landlock）｜#2 #12
- chat.service 拆分（六域职责巨石）｜#9
- 多主机并发会话（per-host 会话视图）+ relay 多副本/注册表外置｜#12
- 会话分叉树 + text/thinking 块 id 协议变更｜#9
- 专家知识库绑定（libraryIds 列+检索收窄）+ 专家附带连接器 + 成员受限 subagent + builtin 种子 + server 专家团对齐｜#7
- 记忆语义检索化 P1/P5（复用 vectorChunk，依赖检索立项）+ 跨主机同源方案 A/B/C 裁定｜#1
- GraphRAG / 多模态入库 / OTel GenAI 导出（长线）｜#6 #8

**中小项（随手批可收）**：
- 资料库引用溯源 UI（角标+跳转定位，P0-2 后半）｜#6
- 记忆即时性 P3（会话事件驱动增量整理）｜#1
- automation 时区 tz 字段 / powerMonitor suspend-resume / 分布式锁 / webhook 任务级触发｜#4
- workflow 编辑器体验（dag 布局/连线预检/子图下钻）+ executor 双副本 drift 纳基线｜#3
- provider 导入预填 / vision 前置拦截 / Ollama /api/show 窗口元数据｜#10
- 桌面监控事件周期裁剪 + 会话级 trace 下钻 + 错误/中止轮补行（outcome 列）｜#8
- 移动端 TOFU 确认仪式 + planView valid 消费 UI｜#12 #5
- 文件门 block 面从 askLevelActive 剔除（安全加固优先，Task 11 minor-1）｜#2
- 各任务 review 过程沉淀的 deferred minor（见 .superpowers ledger，随 final review triage）

## 阅读约定

- 各篇「业界主流做法对比」一节为撰写时的业界参照（ChatGPT Memory/Mem0/Letta、LangGraph/Dify/Coze/n8n/Temporal、sqlite-vec/混合检索/GraphRAG、Langfuse/Helicone/OTel、Claude Code 权限模式、VS Code Remote/Signal 协议等），用于定位天枢的相对位置；技术细节部分则以当次代码实况为准。
- 「未实现/未找到」均如实标注；已知历史裁定（如 stdio MCP 写面不做、移动端不做编排页）在各篇改进建议中已尊重，未反向建议。
- 各篇 §6 改进空间节的 ✅ 标记对应 2026-11-05 落地批（19 commit），标注与代码实况经逐任务独立 review 核实。
