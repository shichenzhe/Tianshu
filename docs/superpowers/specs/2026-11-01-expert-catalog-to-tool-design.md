# 专家目录出 system 段：list_experts 两跳化设计 spec

日期：2026-11-01
状态：已批直接开工（对话内用户「就这么干」授权；方案对照 WorkBuddy recommend-experts 逆向结论）
关联：专家 2.0（buildExpertCatalogPrompt 既有批）；SP6 注入层过滤裁定；新会话上下文瘦身调研（2026-11-01，对话内）

## 0. 事实基线

- 现状：59 条 `MARKET_EXPERTS` 目录像 `buildExpertCatalogPrompt`（electron/domains/ai/chat/expert-catalog.ts）拼进 system，注入条件三合一「未绑专家 + agent 模式 + recommend_expert 未被禁用」（chat.service.ts assembleContext）——**每轮 2970 字符**，占默认新会话 system 的 86%。
- `recommend_expert` 工具全局注册（assistant.repo registerExpertTools），所有会话注入 schema（description 一句话）——含 ask/plan 与已绑专家会话。
- WorkBuddy 同功能形态（逆向，v5.9.3）：system 只注入信号规则（无目录数据）；候选经 `search_plugins` 工具运行时查询返回；渲染走 `suggest_plugin_install`。目录数据零常驻。
- token 账核算：目录整体挪进工具 description **不省**（工具 schema 同为每轮 payload，2970→~3000 白搬）；两跳化（list_experts 返回目录）默认会话净省 ~2800 字符，仅推荐真实发生时付一次性目录成本（当轮工具结果 + 历史留存）。

## 1. 本批裁定

1. **双工具两跳**（recommend-expert-tool.ts）：
   - 新增 `list_experts`：无参；description 含信号规则（「任务明显受益于某专业角色（专业判断/深度研究/多角色协作）且当前会话未绑定专家时调用」+「选出候选后用 recommend_expert 渲染」）；execute 返回 59 条目录行（格式沿用 `- slug｜名称（头衔）：描述`）。
   - `recommend_expert`：description 收敛为渲染语义 + 行为规则（每回复至多一次/未采纳不重复/不代启用/已绑专家禁止）；未知 slug 错误文案改为指引先调 list_experts。
   - 导出 `EXPERT_RECOMMEND_TOOL_NAMES`（两名集合）供注入面收口。
2. **system 目录段删除**：chat.service 删 withCatalog 拼接与 G1 门控逻辑（工具缺席即能力缺席，filterDisabledTools 天然覆盖）；buildExpertCatalogPrompt 双端删除（mirror + apps/tianshu-server/src/core/expert-catalog.ts 同删，drift 对 chat-expert-catalog 同步）。
3. **注入面收紧**（原三合一条件平移到工具层）：collectToolDefinitions 增 `expertRecommend` 参（= `mode === "agent" && !assistantRow`），false 时剔除两名；三调用点（sendRound/probeSendCost/getUsageBreakdown）同表达式传参；无工作空间白名单两名字补入（未绑目录会话同权）；automation-runner collectTools 剔除两名（无人值守语境无推荐卡消费方）。
4. **ask/plan 与已绑专家**：由「system 不注入但工具在场」改为「工具一并缺席」——目录与推荐能力同生同灭。
5. 前端渲染层零改动（group-blocks 消费 recommend_expert args 不变；list_experts 无渲染语义，纯文本工具结果）。

## 2. 非目标（留档）

- 候选状态面（已装/已绑状态返回，WorkBuddy search_plugins 有）——本地 MARKET_EXPERTS 静态目录无此数据。
- 目录行瘦身/摘要化（另行裁定）。
- server 端专家推荐面（移植件同删保持 drift 同构，功能本就未接线）。

## 3. 风险

- 两跳多一次工具往返——WorkBuddy 同构已验证形态可行；description 内「先查后荐」指引明确。
- 模型不调 list_experts 直接编 slug——execute 既有未知 slug 剔除护栏兜底（错误文案回指目录获取路径）。
