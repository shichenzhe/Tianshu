# 移动端专家/技能/MCP 写面批（A2/A3/A4）设计 spec

日期：2026-10-26
状态：调研完成（Explore 三域通道级摸底），按调研建议分阶段实施
关联：差集 spec `2026-10-25-mobile-desktop-gap.md`（A2/A3/A4 条目）；A1 provider/save 掩码三态范式、A5/A7 三段式先例

## 0. 调研关键发现（裁定依据）

- **专家市场是前端打包的静态 TS 分片**（12 分类分片→marketplace.ts 聚合，无 COS 运行时链路）；`assistant/query` 被控面是裁剪概要（不透 systemPrompt/调参），不够编辑。
- **`skillhub:*` 是已实现的远端 SkillHub 客户端**（api.skillhub.cn，宿主侧 zip 下载安装）——手机只传查询参数/slug，zip 不过手机。
- **`mcp/setEnabled` 被控面现存 bug**：只 `prisma.updateMany` 不调 McpRepository/McpManager（进程/工具注册态不切换），且不存在/越权也返回成功；McpRepository 在 attachServerFace 之后创建、未保留实例。**写面批的前置修正**。
- MCP `env/headers`（及 `args`）是秘密面；stdio `command/args` 是**被控宿主机进程执行面**——移动端自由创建/编辑 stdio 属高权限能力，本批不做。
- 专家 `systemPrompt`/专家团是用户私有内容——不做掩码编辑，走归属校验详情读面。
- 三域仓储均构造注册 IPC：A2/A3 已注入 face 复用实例；A4 需调整 Application 装配顺序。

## 1. 本批裁定

### 1.1 阶段 0（前置修正，先落）
- **修 `mcp/setEnabled`**：改经 `McpRepository.setEnabled`（联动 McpManager 进程生命周期），`updateMany.count===0` 报 MCP_NOT_FOUND；`mcp/query` 装配同步切到 repo（对齐 deps.ts 注释宣称的口径）。
- **A4 装配顺序**：mcpManager+McpRepository 创建移到 attachServerFace 之前、保留实例注入；tap 内严禁 new。

### 1.2 A2 专家（阶段 1）
- **Ruling：专家市场数据收编 packages/tianshu-core**（`expert-market/` 模块：12 分片+聚合+类型+toCreateParams 纯数据零依赖，lucide 图标映射等 UI 件留桌面）——src-react 改 re-export 兼容；移动端经 face 端点消费，**概要列表不带 systemPrompt，按 slug 取单条全文**（不全量下发长 prompt）。
- 端点（5 新）：
  - `assistant/detail` {id}→完整记录（归属校验；systemPrompt/调参/技能/专家团全量——用户自己的内容）
  - `assistant/save`——单条 upsert：无 id 建 / 有 id 更，字段三态（undefined 保留/null 清空）；`expertType:"agent"` 清 team 列语义沿用；内置专家拒绝删除/改名（ASSISTANT_BUILTIN）
  - `assistant/delete` {id}（builtin 拒）
  - `assistant/marketList`→概要数组（slug/name/icon/description/profession/tags/categoryId/team 标记，无 systemPrompt）
  - `assistant/marketDetail` {slug}→单模板全文（含 systemPrompt/调参/quickPrompts）
- 移动端 v1：我的专家（列表/详情/新建/编辑/删除）+ 市场（分类/搜索/排序/详情/添加并启用）；**不做**：GUI 导入导出（另批 JSON 内容面）、专家团成员可视化编辑器（update 不传 members=保留，防丢）、对话式创建（聊天+写工具产品流另批）。

### 1.3 A3 技能（阶段 2）
- **Ruling：`skills/query` 契约增量扩展**（RemoteSkillBrief 加可选 scenarios/source/builtin——两端同实现，无头端读 skillRecord 补齐，既有消费方不受影响）；技能市场面走 **DESKTOP_CAPABILITIES 新增 "skillhub"** 能力字（无头端不报，移动端对市场区降级隐藏）。
- 端点（6 新）：`skills/setScenarios` {name,scenarios}；`skills/uninstall` {name}（builtin 拒+skillsDir 边界复用 repo）；`skillhub/list` {keyword?,category?,page?,pageSize?,sortBy?,order?}（宿主转发）；`skillhub/top`；`skillhub/categories`；`skillhub/install` {slug,overwrite?}（**宿主下载 zip 落盘**，手机零流量）。
- 移动端 v1：已装列表（扩展概要+enabled 开关）/正文预览（复用 skills/read）/场景打标/卸载确认/市场浏览+宿主安装。**不做**：本地路径导入/openDir/手机 zip 上传（installFromBuffer 留另批）、统计面（桌面亦无 UI 消费）。

### 1.4 A4 MCP（阶段 3）
- 端点（4 新）：`mcp/statuses`→{id,name,state,toolCount,error?}[]（运行态透出）；`mcp/save`——**HTTP transport 单条 upsert**（无 id 建/有 id 更；headers/env 掩码三态复用 REDACTED_SECRET 与 A1 fail-closed 语义：undefined 保留/null 清除/含掩码按未传；非 http(s) url 拒）；`mcp/delete` {id}；`mcp/reconnect` {id}。
- **Ruling：stdio 配置移动端只读摘要**（name/transport/enabled/status），可启停/重连/删除，**不可创建/编辑参数**（宿主机进程执行面，另行单独裁定）；`mcpServer:sync` 全量语义不暴露移动端。
- detail 读面：`mcp/query` 保持现裁剪形状不动，编辑表单数据从 `mcp/save` 的响应/详情取——补 `mcp/detail` {id}→{id,name,transport,command,url,enabled,args,env,headers}（headers/env 全掩码、args 透传——HTTP 场景 args 通常为空；stdio 类型的 detail 仅返摘要字段，args/env 不回传）。

### 1.5 非目标
对话式创建专家；专家导入导出 JSON 面；手机 zip 上传技能；stdio 自由写；MCP 连接器市场模板（桌面静态模板流不改）；统计面。

## 2. 分层要点

- **协议包**：新 `expert-contract.ts`（AssistantDetailResult/AssistantSavePayload 三态注释/MarketExpertSummary/MarketExpertDetail/ASSISTANT_BUILTIN 码）+ `skill-contract.ts`（SkillManage 扩展/SkillHub* DTO 收编 skillhub-client 形状/Scenario 三值）+ mcp 相关进 `mcp-contract.ts`（McpStatusItem/McpSavePayload 掩码注释/MCP_NOT_FOUND）；ENDPOINTS assistant 5 段+skills 2 段+skillhub 4 段+mcp 4 段；DESKTOP_CAPABILITIES 增 "skillhub"。协议钉测试同步。
- **桌面被控面**：assistant-tap 扩（detail/save/delete 走 AssistantRepository；market 两端点走 core 收编数据，marketDetail 按 slug 查分片）；skills-tap 扩（setScenarios/uninstall 走 repo；skillhub 四端点走 SkillHubClient 现有实例——查 Application 是否已持有，未持有则注入，client 构造零 GUI）；mcp-tap 新建（阶段 0 修正 + statuses/save/delete/reconnect/detail 走 McpRepository，掩码适配参照 providers-tap）。全部 withUserId + 形状校验 + Face*Error 码透传。
- **core 收编**：expert-market 数据模块（纯数据，图标映射/前端过滤器留桌面——过滤排序逻辑若纯函数可随数据下沉，桌面 re-export）。
- **移动端**：experts.store + /experts 页（我的/市场分段，市场区 skillhub+assistant 市场统一在专家页还是分开展示照桌面双页——**统一 /experts 页内分段 [我的|市场]**）；skills 管理升级（SkillsSection 扩场景/卸载入口 + 市场子页嵌发现区，skillhub 能力门禁）；McpSection 升级（statuses 状态点 + HTTP 新建/编辑 Dialog（url+headers 键值编辑）+ 重连/删除；stdio 行只读标注「桌面端编辑」）。i18n 新 key 双语同步。

## 3. 测试与验收

- 阶段 0：mcp setEnabled 走 repo 的用例（Mock manager 断言 connect/close 被调、count=0 报错）+ routes 用例；server-face 全量绿。
- A2：assistant-tap 用例（三态/builtin 拒/归属/detail 全量/market 概要无 prompt/detail by slug）；市场数据收编后桌面 market 测试零改动。
- A3：skills 扩展字段两端实现用例；skillhub 四端点转发用例（mock client）；uninstall builtin 拒。
- A4：mcp save 掩码三态/fail-closed（类比 providers-tap 测试）、stdio detail 不回传 args/env、statuses 形状。
- 移动端：三 store 测试（端点映射/防迟到/串行）+ 三件套；既有测试零红。
- 根 typecheck + server-face vitest + 移动端 vitest 全绿后分阶段提交（阶段 0 独立 fix 提交）。

## 4. 风险

- **stdio 执行面**：移动端自由写 stdio = 远程命令执行授权，本批明确不做并在 UI 标注；HTTP 写面与 provider/save 同级信任（token 即完全信任既有裁定）。
- **掩码 fail-closed 误伤**：headers 含 REDACTED 按未传——与 provider 同口径，编辑表单显式「已配置」占位。
- **市场数据包体**：marketList 概要不带 prompt；分片收编 core 后 dist 体积增长可控（纯 JSON）。
- **setEnabled 修正的行为变化**：修正后移动端切开关立即生效（进程启停）——这是修 bug 而非破坏，但桌面被控端远程启停 MCP 进程影响宿主机，与既有 mcp/query 信任面一致。
