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

## 全局优先改进汇总（跨模块 P0/P1）

| 优先级 | 事项 | 来源 |
|--------|------|------|
| P0 | 核实并修复桌面 chat.service 直读 provider 未走 openSecret（潜在密文请求） | #10 provider-model |
| P0 | 资料库桌面端写侧向量化补齐 + chat 引用溯源角标 | #6 library-rag |
| P0 | TOFU 指纹用户确认 UI（relay 中间人防御闭环） | #2 security |
| P0 | 监控页接入 host-route + server 事件表保留期裁剪 | #8 monitoring |
| P1 | 记忆 userId 隔离与跨主机同源（换主机失忆） | #1 memory |
| P1 | 模型元数据三件套：contextWindow 权威值 / 价格表 / 能力矩阵（联动截断、成本核算、fallback） | #9 #10 #8 |
| P1 | 工作流 checkpointer + interrupt（断点恢复与 HITL） | #3 workflow-graphs |
| P1 | 专家团成员调用监控埋点 + 调度过程可视 | #7 experts |
| P2 | sqlite-vec 真向量索引（schema 注释钦定路径）与语义切块 | #6 library-rag |
| P2 | E2E 密钥棘轮（前向保密）、relay 多副本 | #12 multi-host / #2 security |
| P2 | 定时任务 backoff 重试与分布式锁 | #4 automation |

## 阅读约定

- 各篇「业界主流做法对比」一节为撰写时的业界参照（ChatGPT Memory/Mem0/Letta、LangGraph/Dify/Coze/n8n/Temporal、sqlite-vec/混合检索/GraphRAG、Langfuse/Helicone/OTel、Claude Code 权限模式、VS Code Remote/Signal 协议等），用于定位天枢的相对位置；技术细节部分则以当次代码实况为准。
- 「未实现/未找到」均如实标注；已知历史裁定（如 stdio MCP 写面不做、移动端不做编排页）在各篇改进建议中已尊重，未反向建议。
