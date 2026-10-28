# 移动端定时任务 CRUD + 运行历史批设计 spec

日期：2026-10-27
状态：spec 落盘（用户裁定：CRUD 全量 + 运行历史查看；连桌面端主场景）
关联：mobile-scope-rulings 二裁 4（定时任务两类都要）；GA-T6 旧裁定 automation 半边推翻、graph 编辑半边维持；B2 批（/automation/new 创建面）；WC 批（编排 Tab 四 Tab 范式）

## 0. 事实基线

- **桌面本地 automation 全套在跑**：`electron/domains/ai/automation/`（repo 21.7K 含 `listRuns(:476)` 分页+taskId/status 筛选；runner 17.4K `:168` targetKind 双类分流——prompt/graph 都执行；scheduler/event-bus/retention/stats）。缺的只是被控面透出。
- **桌面 IPC 面超出无头端四段**：list/create/update/delete(批量)/toggle/runNow/templates/runs:page/stats（automation.api.ts）。
- **无头端 save 全量 upsert**（AutomationSaveDto：id 携带即更新；`enabled` 显式携带才写——Ruling 12/14 无 toggle 端点，移动端启停已走 save 全量）。TaskRecord 已收编协议包（graph-contract.ts，含 eventJson/projectId/graphId）。
- **无头端四段**：query/save/delete/runNow；automationRun 表在（@@map 同名）但 **repository 零查询方法、controller 零 run 端点**——运行历史需双端新增。
- **RunRecord/RunPage 未收编协议**；桌面 RunRecord 含 `graphTrace`（节点轨迹 JSON，体积大，仅图运行）。
- **桌面 face**：`FACE_CAPABILITIES`（face-info.ts 定义，info/ipc/relay 三上报点同引）无 graph/automation（GA-T6「远程编排属无头端专属」）；模块组织 `*-tap.ts` + routes.ts(89.3K) 集中注册；face-events.ts 事件桥。
- **移动端现状**：orchestration.store 已接 automationList/Save/RunNow/Delete + automation.changed 消费；编排 Tab 门禁 `capabilities.includes("graph")` 整页拦（orchestration.tsx:78）——连桌面端整 Tab 废；/automation/new(812 行) **四调度**（once/daily/weekly/interval），targetKind 硬编码 graph、modelId=0、prompt 空串、workspaceId 隐式取 `workspaces[0]`。
- **调度全集七 kind**（@tianshu/core ScheduleConfig + 无头端 DTO 手工镜像）：once/daily/weekly/**biweekly/monthly/yearly**/interval——移动端缺后三。

## 1. 本批裁定

1. **推翻 GA-T6 automation 半边**：桌面 face 透出 automation 五段（query/save/delete/runNow/runPage），复用本地 repo/runner/scheduler；`FACE_CAPABILITIES` 增 `"automation"`（一处定义三上报点自动携带）。graph 编辑面（save/delete/run/runAbort）仍不透，维持桌面/无头端专属。
2. **graph/query 只读随批透出**（face）——连桌面端时 graph 型任务可选图创建/编辑（移动端 new.tsx 选图链路现拉无头端 graph/query，桌面端 graphs 表本地在）。
3. **新端点 `automation/runPage`**（无头端 + face 双端同构）：`{page, taskId?, status?}` → `{total, items}`；**载荷剔 graphTrace**（节点轨迹体积大、小屏无消费面，轨迹详情留档）；无头端 repository 移植桌面 `listRuns` 语义（taskName join、userId 隔离、startedAt desc、ISO 归一）。
4. **契约收编**：`AutomationRunRecord`（RunRecord 精简面：剔 graphTrace）+ `AutomationRunPage` 进协议包 graph-contract.ts（TaskRecord 旁，三端单源）。
5. **face 事件桥**：桌面本地 automation-event-bus 变更 → face `automation.changed` 推送（userId 定向，载荷对齐 AutomationChangedPayload——taskId 必带/enabled/nextRunAt 可选）。
6. **移动端编排 Tab 改造**：门禁改 `graph || automation`；Graphs 段仅 capability 含 graph 时显示（连桌面端只显 Automations 段）；Tab 标签更名「自动化」（orchestration i18n；路由 path `/orchestration` 不动防深链断——标注假设，若用户要改 path 另裁）。
7. **/automation/new → 双模式（新建+编辑）**：
   - `targetKind` 切换段（提示词/工作流）；prompt 模式加提示词多行输入 + **模型选择**（复用 ModelPicker 组件链路；graph 型维持 modelId=0 占位）
   - 调度**扩至七 kind**（+biweekly/monthly/yearly：anchorDate+weekday / dayOfMonth / month+day 三组 UI）
   - workspaceId 从隐式首项升级**显式选择**（CRUD 面隐式不再合适）
   - 编辑模式（列表行进入，?id=）：TaskRecord 全量回填；`eventJson/templateSlug/projectId/temperature` 原样透传（UI 不做配置面，防全量 save 丢配置）；`enabled` 显式携带（编辑不重置用户开关）
   - 编辑回填纯函数 `parseScheduleJson`（scheduleJson → 表单值，未知 kind 整段只读态报错不丢）
8. **运行历史页 /automation/history**：分页列表（行 = taskName + 状态徽标 + triggerType + 相对时间 + 耗时 + tokens 摘要）+ 状态筛选 chips（全部/运行中/成功/失败/跳过，status 下推服务端）+ 任务行操作「历史」入口（?taskId= 预筛）；失败行错误信息 DetailSheet 展开。
9. **不进本批**（留档）：templates 模板面、stats 健康度聚合、graphTrace 轨迹查看、任务事件触发（appStarted/taskFinished 链式）配置 UI、webhook 触发面（移动端不做 webhook——mobile-scope-rulings）。

## 2. 端点与契约明细

| 端点 | 宿主 | 入参 | 出参 | 实现 |
|---|---|---|---|---|
| automation/query | 无头端（GA-T8 已有）+ face 新增 | — | TaskRecord[] | face 桥 repo list |
| automation/save | 同上 | AutomationSaveDto 全量 | TaskRecord | face 桥 repo create/update（upsert 语义对齐无头端：id 可选/enabled 显式携带才写） |
| automation/delete | 同上 | {ids} | void | face 桥 repo delete |
| automation/runNow | 同上 | {id} | void/202 | face 桥 service runNow |
| **automation/runPage** | **双端新增** | {page, taskId?, status?} | AutomationRunPage | 无头端 repo 移植桌面 listRuns；face 桥桌面 listRuns(:476)；载荷剔 graphTrace |
| graph/query | face 新增只读 | — | GraphRecord[] | face 桥本地 graphs 表（选图用；save/delete/run/runAbort 仍不透） |

- 协议 ENDPOINTS.automation 增 `runPage`；进协议即触发 mirror 钉测试 + 无头端 SDK automation 组显式补（session 组自动惯例外）。
- AutomationRunRecord 字段：id/taskId/taskName/graphId?/sessionId?/attempt/triggerType/status/durationMs?/promptTokens?/completionTokens?/error?/startedAt/finishedAt?（即桌面 RunRecord 剔 graphTrace）。

## 3. 移动端实现面

- **store**：orchestration.store 增 runs 资源（runs/runsTotal/runsLoading/hasMore/loadRuns/appendRuns/setStatusFilter——**防迟到序号按资源拆分**铁律，runs 与 graphs/tasks 独立序号）；编辑表单状态维持 new.tsx 局部 state 模式。
- **组件复用**：ModelPicker（模型选择）、DetailSheet（错误展开）、StateDot/状态徽标、PageHeader、AppActionSheet（行操作）。
- **纯函数单测**（vitest）：buildSchedule/buildScheduleText/validationKey 扩三 kind；parseScheduleJson 回填（七 kind + 未知 kind 容错）；编辑透传载荷组装（eventJson/projectId/templateSlug/temperature/enabled 原样）。
- **i18n**：orchestration 命名空间扩 key（prompt 模式/七调度/运行历史/筛选/编辑），zh-CN + en-US 双份。
- **验收**：expo web + Playwright 截图对照法（WC 批先例）；连桌面被控端实测五段（本机 face + 移动端 web）。

## 4. 测试

- 协议：ENDPOINTS 钉测试（runPage 入表）。
- 无头端：runPage Jest（分页/筛选/taskName join/userId 隔离/ISO 归一/graphTrace 剔除）。
- face：automation-tap 单测（save enabled 透传语义、graphTrace 剔除、userId 隔离、runNow 202 受理）；capability 上报含 automation。
- 移动端：七 kind 纯函数 + parseScheduleJson + store 防迟到（runs 独立序号）。
- 双端同形终验三项（错码存在性/载荷字段接线/状态联合同形——RunStatus 四值枚举双端一致）。

## 5. 分提交

1. `feat(protocol)`: runPage 端点 + AutomationRunRecord/RunPage 收编 graph-contract.ts。
2. `feat(server)`: 无头端 runPage（repo listRuns 移植 + controller + SDK + Jest）。
3. `feat(face)`: automation-tap 五段 + graph/query 只读 + FACE_CAPABILITIES 增 automation + automation-event-bus 桥 + 单测。
4. `feat(mobile)`: 编排 Tab 门禁 graph||automation + Graphs 段条件渲染 + Tab 更名 i18n。
5. `feat(mobile)`: 调度七 kind 纯函数 + /automation/new 双模式（targetKind 切换/模型选择/workspace 显式选择/编辑回填透传）。
6. `feat(mobile)`: /automation/history 运行历史页 + store runs 资源 + i18n。
7. 收口：prettier + 全量测试绿。

## 6. 风险与注意

- **save 全量 upsert 编辑丢配置**：eventJson/projectId/templateSlug/temperature 不在移动端 UI 暴露，编辑必须原样透传——纯函数单测钉死载荷组装。
- **schedule zod 深校验保存期拒**：七 kind 载荷正确性靠纯函数单测前置钉死（错码 SCHEDULE_INVALID 映射双语文案）。
- **face routes.ts 89.3K**：automation 五段独立 automation-tap.ts，不内联 routes.ts。
- **时区**：ScheduleConfig once/biweekly 的 runAt/anchorDate 含时区偏移 ISO——移动端日期选择产 ISO 与桌面同口径。
- **capability 兼容**：旧版桌面被控端（无 automation 能力）连新版移动端——门禁 graph||automation 仍拦，降级路径不变；新版桌面 + 旧移动端零影响（多报能力不炸旧端）。
- **runPage 分页防迟到**：runs 独立请求序号，防与 graphs/tasks 拉取互判过期。
