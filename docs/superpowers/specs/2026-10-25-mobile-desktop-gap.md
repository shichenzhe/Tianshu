# 移动端 ↔ 桌面端能力差集（盘点基线 2026-10-25）

> 依据：双 Explore agent 全量盘点（移动端 32 端点消费面 + 桌面端本地 IPC
> 200+ 通道面）与 `@tianshu/protocol` ENDPOINTS 表逐项核对。
> 结构性事实：移动端只消费被控面协议（server-face / tianshu-server 路由
> 表），桌面端是完整本地 IPC 面——缺口按「协议有无 × 移动端有无」分三类。

## A. 被控面协议缺口（要做先扩 server-face / tianshu-server）

| # | 缺失功能 | 桌面端对应 | 协议现状 |
|---|---|---|---|
| A1 | ~~服务商/模型配置页~~ | providers 页增删改/启停/测试/远端拉取导入 | ✅ 2026-10-25 已落地（save 开放裁定过、桌面 face `provider/save`+掩码防回写 fail-closed 脱敏、移动端 /providers 页全管理；见 mobile-provider-config-batch spec） |
| A2 | 专家管理（编辑/删除/导入导出/市场/对话式创建） | experts 页 + ExpertMarketView | 只有 `assistant/query`；写面与市场端点全缺（RecommendCard「添加并启用」因此裁剪留档） |
| A3 | 技能市场（发现/安装/卸载/导入/统计） | SkillDiscover/SkillManagerView | 只有 `skills/query/read/setEnabled`；`skillhub:*` 无对应 |
| A4 | MCP 增删改/重连 | McpManageDialog | ~~只有 `mcp/query/setEnabled`~~ ✅ 2026-10-26 已落地（A2/A3/A4 批：statuses/save(HTTP-only 掩码三态)/delete/reconnect/detail + setEnabled 生命周期修正；**stdio 参数写面用户 2026-10-26 裁定明确不做**——被控宿主机进程执行面） |
| A5 | 资料库（树/搜索/最近/收藏/新建/导入/编辑/预览） | LibraryView 全套 | **完全无端点** |
| A6 | ~~用量监控页（场景聚合/趋势/模型分布/工具排行）~~ | MonitorView | ~~无端点~~ ✅ 2026-10-25 已落地（`monitor/stats` 收编协议包+桌面被控面路由+移动端 /monitor 页，见 mobile-monitor-batch spec；无头端无事件表不在此批） |
| A7 | 项目模块（hub/工作台/planItem 五视图/planView/资产/我的任务） | project 全套 | **完全无端点** |
| A8 | 工作空间管理（新建/重命名/删除/绑定目录） | WorkspaceMenu | 只有 `workspace/query` |
| A9 | 会话内消息搜索、`/compact` 压缩、提示词润色 | MessageList 搜索 / compact / polish | 本地 `chat:*` 有，被控面无端点 |
| A10 | 审批记忆管理（已记住工具/完全授权列表/撤销） | PermissionCapsule + SystemGrantCard | `rememberTool` 上送已有；列表/撤销无端点 |
| A11 | 会话时间筛选（今天/本周/本月） | 侧栏 FilterPopover | `session/query` 无时间范围参数——**分页语义下客户端过滤不完整，归协议扩展**（修正早期「纯前端」判断） |

## B. 协议已有、移动端未消费（补齐不需动协议）

| # | 缺失功能 | 状态 |
|---|---|---|
| B1 | 会话重命名（`session/update` 的 title 面，两端均已支持） | ✅ 2026-10-25 已落地（长按面板「重命名」+ SessionRenameDialog） |
| B2 | ~~图编辑器 + 自动化创建/编辑~~（用户裁定 2026-10-25：移动端不要图编辑器，只要自动化任务创建） | ✅ 2026-10-25 已落地（编排页「+」+ /automation/new 创建页，四类型调度/错过策略/权限模式；任务编辑/graph/save 不在移动端范围） |
| B3 | ~~模型测试/远端拉取导入 UI（`provider/test`、`fetchModels`）~~ | ✅ 2026-10-25 随 A1 批落地（纯消费 face 既有端点，页面测试入口+远端导入去重） |
| B4 | —（时间筛选移入 A11） | — |
| B5 | 小项：归档 5 秒撤销（现为 Alert 确认，交互差异非功能缺）、助手消息的模型/耗时展示、无模型配置引导 | 待排期 |

## C. 有意不对齐（桌面宿主能力，不建议移动端做）

文件窗口/终端/diff/右侧详情面板、内置浏览器、系统设置（数据目录/自启/代理/
Webhook 端口/执行历史保留）、应用更新与更新日志、快捷键体系、10 款皮肤壁纸
（移动端 4 色卡为子集）、多用户账户与安全中心、记忆与进化。

## D. 移动端反超桌面

拍照入链（桌面无相机入口）、通知偏好三开关本机持久化。

## 已知协议级限制（代码留档）

- Relay 通道大图受 4MiB 单帧限制（MessageImage 降级失败占位，仅 Direct 有
  60 秒专用读取通道）；
- 本地通知仅 App 后台存活期可达（无远程推送）；
- 多控制端同时遥控同一会话可能串流（设置页明示）。

## 对齐建议优先级

1. ✅ B1 会话重命名（本轮已落地）
2. A6 监控读面（风险低、遥控价值高）+ A1 服务商配置（先裁定被控面
   `provider/save` 注册安全面）
3. B2 自动化创建/编辑（遥控价值高于图编辑器）
4. A5/A7 资料库与项目（端点面大，各立一批）
5. A2/A3/A4 专家/技能/MCP 写面（与 A1 同属「被控面写面注册」安全裁定批次）
