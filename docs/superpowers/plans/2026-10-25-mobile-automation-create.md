# 移动端自动化任务创建（B2）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.
> Spec: `docs/superpowers/specs/2026-10-25-mobile-automation-create.md`（已评审通过）

**Goal:** 移动端编排 Tab 内新建「图」自动化任务（名称+选图+四类型调度+错过策略+权限模式）。

**Architecture:** 纯 UI 批——transport 层 `automationSave()`/`toTaskSaveParams()` 已存在（graph-api.ts:152-190），零协议/零 face/零 store 改动。创建页构造 TaskSaveParams 提交，列表经 `automation.changed` 事件自动刷新。

**Tech Stack:** Expo/RN、@tianshu/protocol（ScheduleConfig 判别联合）、i18n orchestration 命名空间增量。

## Global Constraints

- 工作分支 main，直接提交（用户长期裁定，不开 worktree/分支）。
- 移动端 lint 环境态不可用：验收固定 typecheck + vitest + prettier（**Bash cwd 每跑一次漂回仓库根，命令必须显式 `cd /Users/hjx/workspace/mirror/apps/tianshu-mobile`**）。
- **禁止根目录 npm install**；不装 `@react-native-community/datetimepicker`（spec §4——日期时间自绘）。
- i18n：zh-CN/en-US 同步，禁止顶层/嵌套 key 重名。
- 样式禁硬编码主题色（语义类除外，主题色走 `useThemeColors()`）。
- graph capability 整页门禁已天然覆盖（桌面被控面无 graph 能力，编排 Tab 只可达无头端）——创建入口不做独立门禁。

---

### Task 1: 自动化任务创建页

**Files:**
- Create: `apps/tianshu-mobile/src/app/automation/new.tsx`
- Modify: `apps/tianshu-mobile/src/app/_layout.tsx`（Stack 注册 :59-69）
- Modify: `apps/tianshu-mobile/src/app/(tabs)/orchestration.tsx`（Automations 段入口）
- Modify: `apps/tianshu-mobile/src/i18n/locales/zh-CN/orchestration.json` 与 `en-US/orchestration.json`（增量 key）

**Interfaces:**
- Consumes: `automationSave`、`TaskSaveParams`（`src/transport/graph-api.ts:128-152`）；`useOrchestrationStore` 的 `graphs`（:39）；`ScheduleConfig`（`@tianshu/core`，graph-api 经 protocol 透传的 schedule 字段口径——构造后以 `Record<string, unknown>` 注入 TaskSaveParams.schedule）；workspaceId 来源——**先读 `orchestration.store.ts` 任务行的 workspaceId 语义与 `(tabs)/index.tsx` 工作空间选择器现状**，本批裁定：取 graphs 行不带空间信息，创建载荷 workspaceId 用**会话侧栏同款默认空间**（sessions store 的默认工作空间 or 第一个），实现期以读到的实际源为准并在报告注明。
- Produces: `/automation/new` 路由页；orchestration 命名空间增量 i18n key。

- [ ] **Step 1:** i18n 增量 key（zh/en 双份，**先读两份 orchestration.json 确认无重名再追加**）。zh-CN：

```json
{
  "newTask": "新建任务",
  "create": "创建",
  "cancel": "取消",
  "taskName": "任务名",
  "taskNamePlaceholder": "给任务起个名字",
  "selectGraph": "选择图",
  "pleaseSelect": "请选择",
  "schedule": "调度",
  "once": "一次",
  "daily": "每天",
  "weekly": "每周",
  "interval": "间隔",
  "date": "日期",
  "time": "时间",
  "weekdays": "星期",
  "mon": "一", "tue": "二", "wed": "三", "thu": "四", "fri": "五", "sat": "六", "sun": "日",
  "intervalValue": "间隔数值",
  "intervalUnit": "单位",
  "minute": "分钟",
  "hour": "小时",
  "intervalMin5": "间隔不得小于 5 分钟",
  "missedPolicy": "错过策略",
  "skip": "跳过",
  "catchUpOnce": "补跑一次",
  "accessMode": "权限模式",
  "default": "默认",
  "full": "完全",
  "accessModeHint": "完全 = 无人值守时全部工具可用",
  "createFailed": "创建失败：{{message}}",
  "needName": "请填写任务名",
  "needGraph": "请选择图",
  "needWeekday": "请至少选择一天",
  "needSchedule": "请完整填写调度",
  "graphNodes": "{{count}} 个节点"
}
```

（`cancel` 若 `common` 命名空间已有则复用 `common:cancel`——先查 common.json，已有的键本文件不重复造。）

- [ ] **Step 2:** `_layout.tsx` Stack 增 `<Stack.Screen name="automation/new" options={{ headerShown: false }} />`。

- [ ] **Step 3:** `orchestration.tsx` Automations 段列表头行右侧加「+」：`MessageSquarePlus` size 17 `colors.primary`，`router.push("/automation/new")`；`graphs` 未加载时点入口先 `loadGraphs()`（store 已有 action）。

- [ ] **Step 4:** `src/app/automation/new.tsx` 页面。表单 state：

```ts
type ScheduleKind = "once" | "daily" | "weekly" | "interval";
const [name, setName] = useState("");
const [graphId, setGraphId] = useState<number | null>(null);
const [graphPickerOpen, setGraphPickerOpen] = useState(false);
const [kind, setKind] = useState<ScheduleKind>("once");
const [date, setDate] = useState("");      // once：YYYY-MM-DD，自绘近30天横滑列表选择
const [hm, setHm] = useState("09:00");     // daily/weekly/once 的 HH:mm，自绘时/分两列滚轮
const [weekdays, setWeekdays] = useState<number[]>([1]);
const [intervalValue, setIntervalValue] = useState("30");
const [intervalUnit, setIntervalUnit] = useState<"minute" | "hour">("minute");
const [missed, setMissed] = useState<MissedPolicy>("skip");
const [access, setAccess] = useState<AccessMode>("default");
const [submitting, setSubmitting] = useState(false);
const [formError, setFormError] = useState<string | null>(null);
```

提交（内联构造，不超 20 行函数上限则抽 `buildSchedule` 局部函数）：

```ts
const schedule = ((): Record<string, unknown> => {
  const base = { mode: kind === "interval" ? "interval" : "periodic" };
  if (kind === "once")
    return { ...base, kind: "once", runAt: `${date}T${hm}:00${tzOffset()}` };
  if (kind === "daily") return { ...base, kind: "daily", time: hm };
  if (kind === "weekly")
    return { ...base, kind: "weekly", weekdays: [...weekdays].sort(), time: hm };
  return {
    mode: "interval",
    value: Number(intervalValue),
    unit: intervalUnit,
    ...(weekdays.length ? { weekdays: [...weekdays].sort() } : {}),
  };
})();
```

（`tzOffset()` 本地辅助：返回 `+08:00` 形态——用 `Date` 当前时区算一次；weekly 的 weekdays 为 ISO 1=周一…7=周日。interval .weekdays 可选——本批不暴露 UI，恒不携带。）

校验链（提交前，任一败 → setFormError + return）：name 非空 → graphId 非空 → kind 对应字段齐（once 需 date；weekly 需 weekdays 非空；interval 需 Number≥5 分钟（hour 换算））→ 构 scheduleText（i18n 拼接：`每天 09:00`/`每周 一、三 09:00`/`一次 2026-10-26 09:00`/`每 30 分钟`，t() 带插值）→ 提交：

```ts
const r = await automationSave({
  name, prompt: "", workspaceId, modelId: 0,
  targetKind: "graph", graphId: graphId ?? undefined,
  schedule, scheduleText, missedPolicy: missed, accessMode: access,
  enabled: true,
});
if (r.ok) router.back(); else setFormError(t("orchestration:createFailed", { message: r.message }));
```

页面结构（ScrollView 页根 + 组卡，全语义类）：顶栏（ChevronLeft 返回 + `t(newTask)` 大标题 + 右侧「创建」文字钮——禁用态 submitting/校验不过）；任务名 TextInput 卡；执行体卡（「图」分段单选，静态）；选择图卡（选中回显图名+`graphNodes` 副标，点击弹 Modal 列表——orchestration.store.graphs 行，名称+节点数，行点击选中关层）；调度卡（kind 四段横排；条件区：once 出日期横滑条（今天起 30 天 chips YYYY-MM-DD+周几）+时/分滚轮；daily 出时/分滚轮；weekly 出星期 chips 多选+时/分滚轮；interval 出数值 TextInput+分钟/小时二选）；错过策略卡（skip/catchUpOnce 二选行）；权限模式卡（default/full 二选行+accessModeHint label2 注释）；formError 红字底部固定区。

时/分滚轮：两列各 `<ScrollView snapToInterval>` 或简化为两列横滑 chips（时 00-23 / 分 00/05/10…55）——**取 chips 横滑（实现可靠，无嵌套滚动手势冲突）**。

- [ ] **Step 5:** 三件套：`cd /Users/hjx/workspace/mirror/apps/tianshu-mobile && npm run typecheck && npm run test && npx prettier --check src/app/automation/new.tsx src/app/_layout.tsx "src/app/(tabs)/orchestration.tsx" src/i18n`（既有 268 测试不得红）。

- [ ] **Step 6:** 提交：`feat(mobile): B2 自动化任务创建——编排页「+」入口+/automation/new 表单（名称/选图/一次·每天·每周·间隔四调度/错过策略/权限模式），automationSave 全量载荷提交，事件驱动列表刷新`

---

## 依赖与冲突扫描（Pre-flight）

| 检查对 | 结论 |
|---|---|
| 本批 vs A1+B3 批 | 文件不相交（orchestration/automation vs providers/settings），无冲突；但同属 main 顺序执行，A1+B3 先合入避免 _layout.tsx 双改冲突 |
| transport 层 | automationSave/toTaskSaveParams 已存在（graph-api.ts:152-190）——只读消费，零改动 |
| ScheduleConfig 联合 | 四类型构造为协议判别联合的子集（spec §1.2 裁定），zod 深校验在服务端——构造形态以 `packages/tianshu-core/src/schedule-schema.ts` 为准（实现前读） |
| i18n | orchestration 命名空间增量——先读现有 json 防重名 |
