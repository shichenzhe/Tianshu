# 移动端自动化任务创建（B2 重定界）设计 spec

日期：2026-10-25
状态：已评审通过（用户裁定：移动端不要图编辑器，只要有自动化任务创建）
关联：差集 spec `2026-10-25-mobile-desktop-gap.md`（B2 条目重定界）

## 1. 背景与裁定

### 1.1 现状

- 移动端编排 Tab（`(tabs)/orchestration.tsx`）已全功能遥控：图运行/中止/结果、任务启停/立即运行/删除，capability `graph` 整页门禁。
- transport 层 `automationSave()`（graph-api.ts:184-190）与 `toTaskSaveParams()` 全量载荷构造**已存在**——B2 是纯 UI 批，零协议、零 face、零 store 改动。
- 重要事实：桌面被控面 **无 graph/automation 能力位与路由**（DESKTOP_CAPABILITIES 无 graph，face ROUTES 表无 automation 段）——编排遥控仅对无头端主机可用，`graph` capability 门禁已天然挡住桌面被控端，无需额外处理。
- graph 任务的运行参数：自动化 save DTO 无 graphParams/inputParams 字段（graph 任务 prompt 空串占位、modelId=0 占位）——**任务创建不带图入参**，图的输入由各节点默认值承担。

### 1.2 裁定

- **Ruling：B2 = 移动端自动化任务创建 UI**，非目标：图编辑器、graph/save、任务编辑（编辑走长按已有删除；编辑表单不在本批——与创建共用表单成本低，但 YAGNI，本批只做创建）。
- **Ruling：调度类型 v1 做四种**：`once`（定时一次，runAt）/`daily`（HH:mm）/`weekly`（星期多选+HH:mm）/`interval`（N 分钟/小时，≥5 分钟）。biweekly/monthly/yearly 桌面端处理（真机有需求再扩——ScheduleConfig 是封闭判别联合，扩类型纯增量）。
- **Ruling：missedPolicy 二选**（skip/catchUpOnce），accessMode 二选（default/full），startAt/endAt 生效区间 v1 不做。
- workspaceId：任务归属空间——创建表单从会话侧栏同款工作空间选择器取（默认当前会话空间或第一个）。

## 2. 设计

### 2.1 入口

orchestration.tsx Automations 段列表头行右侧「+」（MessageSquarePlus 17px 主题色，对齐会话组头冒泡+惯例），`graph` capability 门禁已整页覆盖。点击进 `/automation/new`（Stack 注册，自绘顶栏：取消/创建）。

### 2.2 创建页 `src/app/automation/new.tsx`

表单（ScrollView，分段组卡）：
1. **任务名**：TextInput 必填。
2. **执行体**：固定「图」分段（targetKind=graph；prompt 任务不在本批）。
3. **选择图**：行（未选显示「请选择」）→ 弹层图列表（orchestration.store 已加载的 graphs，名称+节点数）；选中回显。
4. **调度**：类型四段（一次/每天/每周/间隔）：
   - once：日期+时间选择（datetime，runAt ISO 含时区偏移）；
   - daily：时间选择（HH:mm）；
   - weekly：星期横排多选 chips（一~日，ISO 1-7）+时间选择；
   - interval：数值输入+分钟/小时单位二选（校验 ≥5 分钟）。
5. **错过策略**：skip/catchUpOnce 二选行。
6. **权限模式**：default/full 二选行（无人值守工具权限，默认 default）。

提交：`automationSave(toTaskSaveParams 同构构造)`——构造新任务载荷：name/prompt=""/workspaceId/modelId=0/temperature 不传/targetKind="graph"/graphId/schedule（按四类型构造判别联合）/scheduleText（i18n 文案化）/missedPolicy/accessMode/enabled=true。成功后 `router.back()`，列表经 `automation.changed` 事件自动刷新（orchestration.store 已绑定）。

校验：任务名非空、已选图、schedule 合法（interval≥5 分钟；weekly 至少选一星期）；提交按钮禁用态。

### 2.3 i18n

`orchestration` 命名空间补 key（zh/en 同步）：newTask/create/cancel/taskName/taskNamePlaceholder/selectGraph/pleaseSelect/schedule/once/daily/weekly/interval/runAt/time/weekdays/mon/tue/wed/thu/fri/sat/sun/intervalValue/intervalUnit/minute/hour/intervalMin5/missedPolicy/skip/catchUpOnce/accessMode/default/full/createFailed/validationHint。禁止顶层/嵌套 key 重名。

## 3. 测试与验收

- 纯 UI 批：Ruling——schedule 四类型构造直接内联于表单组件（量小、无复用者），**不抽纯函数**；若实现期单函数超 20 行再抽 `buildScheduleConfig(form)` 并补单测（CLAUDE.md 函数上限兜底）。
- 移动端三件套：typecheck + vitest（orchestration 既有测试不得红）+ prettier。
- 真机验收（移交用户）：对无头端主机建 once 任务 → 列表出现 → 立即运行跑通；weekly+interval 各建一个看 scheduleText 文案。

## 4. 风险

- **RN 日期时间选择无原生组件**：v1 用滚轮式自绘（简单三段 picker：日/时/分）或 `@react-native-community/datetimepicker`（新依赖——package 安装须过 npm install-scripts 白名单流程，**优先自绘避免装包**）。自绘日选择为近 30 天横滑列表即可（once 场景足够）。
- **graph capability 门禁**：无头端才有 graph 能力，桌面被控端天然不可达——创建页只在编排 Tab 内进入，无需独立门禁。
