# 移动端用量监控批（A6：监控读面遥控）

- 日期：2026-10-25
- 状态：设计定稿（自主决策口径），待用户审阅
- 上游：`docs/superpowers/specs/2026-10-25-mobile-desktop-gap.md`（A6 优先级②）
- 范围裁定：本批**只做桌面被控面**；无头端（apps/tianshu-server）Prisma
  无 llmCallEvent/toolCallEvent 表（事件埋点未移植），监控数据不存在——
  无头端埋点移植另行立批，本批不动。

## 1. 目标

移动端遥控读取桌面端用量监控（对齐桌面 MonitorView 的统计口径），
入口按 capability 门禁——无 monitor 能力的主机（无头端/旧桌面端）不显示。

## 2. 协议层（packages/tianshu-protocol，单份收编）

1. `DESKTOP_CAPABILITIES` 增 `"monitor"`（无头端 CAPABILITIES 不动——
   其无数据可报）。
2. `ENDPOINTS.monitor = { stats: "monitor/stats" }`。
3. 类型收编：`MonitorScene`（chat|graph|automation）、`MonitorStats`
   （today/trend/byModel/tools 四块，形状照抄桌面
   `src-react/domains/ai/monitor/api/monitor.api.ts` 现状）。收编后桌面
   `monitor.api.ts` 改为自协议包 re-export（对齐 RC-T1 FACE_CAPABILITIES
   收编先例；主进程 monitor-stats 的 import 路径同步改协议包）。

## 3. 桌面被控面（electron/domains/server-face）

- `deps.ts` 的 FaceDeps 增 `monitorStats(userId, scene?)` 子集方法
  （对齐 sessions/providers 子集注入模式）。
- `routes.ts` 注册 `POST monitor/stats`：withUserId →
  `deps.monitorStats(userId, scene)` → ok。scene 非法/缺省归 undefined
  （对齐桌面 IPC 层口径）。
- 生产实现复用现有聚合：`MonitorRepository.getStats` 的查询逻辑抽为
  纯查询函数（或直接注入 MonitorRepository 实例——实现期取更简者；
  computeMonitorStats 已是纯函数可直接复用）。
- 安全面：monitor/stats 为**读面**，且数据本就被控端用户可见，透传
  无新增泄露面（token 持有者本就能开桌面看同一份数据）。

## 4. 移动端（apps/tianshu-mobile）

1. **入口**：我的页新增「用量监控」组卡行（ListItem，monitor capability
   存在才渲染——运行时 capabilities 判定，同编排 Tab 门禁惯例）；
   点击 push `/monitor`。
2. **路由**：根 Stack 注册 `app/monitor.tsx`（全屏 push，同 session/[id]）。
3. **页面**：
   - 场景分段：全部 / 聊天 / 编排 / 自动化（chat/graph/automation，
     切换即重查）；
   - 今日 KPI 卡：输入 Token、输出 Token、LLM 调用、工具调用、成功率；
   - 7 天趋势：输入/输出 Token 双序列——无图表库，View 自绘等宽竖条
     （每日两根，按窗口内最大值归一），图例小字；
   - 按模型：行=名称+调用次数+输入/输出 Token（降序截断 10 行）；
   - 工具排行：行=工具名+成功率+平均耗时+总/拒绝/错误数（截断 10 行）；
   - 空态（无事件数据）/加载失败重试/无连接引导三态。
4. **数据**：connections 层 request（POST monitor/stats，body {scene?}）；
   失败按端点不可用处理（隐藏入口的兜底语义不重复——页内给重试）。
5. **i18n**：新增 `monitor` 命名空间（双语），key camelCase。

## 5. 非目标

- 无头端事件埋点移植与 monitor 端点（另批）；
- 桌面 MonitorView 本身不动（仅类型源迁移到协议包，re-export 兼容）；
- 监控图表不引入第三方库；不做过滤/下钻/导出。

## 6. 风险与注意

- **类型迁移双改**：`MonitorStats` 移动后桌面 `monitor.api.ts` 与主进程
  `monitor.repo.ts` 的 import 同步改——漏改一处编译即红，typecheck 兜底。
- **drift 巡检**：server-face 路由表变化不涉及双份文件基线；
  `computeMonitorStats` 单份在 electron 域，协议包只放类型（零运行时）。
- **能力门禁**：连接运行时上报 capabilities 才有入口——桌面端须升级
  到本批版本，旧端自然隐藏（零迁移）。
- 趋势图自绘竖条注意 dark 模式配色（label2/sep 变量，禁硬编码主题色
  之外的蓝绿）。
