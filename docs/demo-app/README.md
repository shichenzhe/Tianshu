# demo 应用：对话调用工作流做记账 CRUD + 聊天渲染结果

「对话调用工作流 + 聊天渲染结构化结果」的最小端到端切片产物：四份可导入的
工作流定义（初始化库 / 记一笔 / 查账明细 / 月度汇总）+ 两个聊天展示工具
（`show_table` / `show_summary`）。

## demo 库落位

- **demo.db 建在会话工作空间根目录**（`<工作空间>/demo.db`），不在
  `~/.tianshu` 数据根。原因：database 节点 sqlite 引擎的 `sqlitePath` 经
  `path.resolve(workspacePath, sqlitePath)` 解析并被强制限制在工作空间界内
  （`db_outside_workspace` 守卫，见
  `electron/domains/ai/orchestration/db-client.ts` 的 `openSqlite`）——指向
  数据根的绝对路径会被直接拒绝，图定义里写死机器相关绝对路径也跨不了机器。
  工作空间相对路径 `demo.db` 随工作空间走，天然可迁移。
- 建表幂等：`CREATE TABLE IF NOT EXISTS expense(...)`（SQLite 方言；
  `AUTOINCREMENT`/`datetime('now')` 等 PG 兼容问题在本 demo 仅 SQLite 场景
  可忽略）。**不在应用启动路径自动建库**——按下面步骤导入「初始化」工作流
  后手动跑一次即可。

## 建表与导入步骤

1. 会话绑定一个工作空间目录（新建一个空目录即可，demo.db 会建在其根下）。
2. 导入四个工作流定义，两条路任选：
   - **对话导入**：把 `docs/demo-app/*.json` 里的 `graphJson` 内容发给 AI，
     让其调用 `create_workflow`（需 automation/coding 场景，或已安装启用
     workflow-creator 技能）；
   - **画布导入**：「工作流」页新建，把 `graphJson` 粘进编辑器保存。
3. 先运行「记账·初始化 demo 库」一次（画布试运行或对话 `run_workflow`），
   工作空间根出现 `demo.db` 即建表成功。

## 对话验收

前提：会话场景选 automation 或 coding（或安装 workflow-creator 技能）、
已绑定工作空间、模型已配置。示例话术：

- 「记一笔：午饭 35 元，类别餐饮」→ AI 组装 inputs 调
  `run_workflow`（写操作需批准）→ `get_workflow_run` 确认 `affectedRows=1`。
- 「看看最近 5 笔支出」→ 查账明细工作流 → AI 拿终点完整输出（show_table
  结构）→ 调 `show_table` → 消息流出现原生表格卡。
- 「这个月花了多少」→ 月度汇总工作流 → AI 调 `show_summary` → 消息流出现
  摘要卡（总额/笔数/Top 分类）。

## 约定与注意

- 四个工作流的 `sqlitePath` 一律为 `demo.db`（工作空间相对路径），换工作
  空间即换库，互不影响。
- inputs 值类型现状只有 string：金额在 SQL 内 `CAST(? AS REAL)` 转数值、
  日期缺省在 SQL 内 `COALESCE(NULLIF(?,''), date('now','localtime'))` 兜底
  （模板机制只能整节点输出引用，variable/code 节点转出的单值无法按 key
  解构，SQL 内转换是节点能力现状下的最短路径）。
- 查账明细的 `limit` 输入缺省 5，SQL 内钳制 0..200（`MAX(0, MIN(...))`，
  负值出 0 行、超大值截 200——负 LIMIT 在 SQLite 语义为「不限」必须前置
  钳住）。
- `get_workflow_run` 附「完整输出」段（上限 4000 字，取自 graphRunNode
  节点级全量输出），超出会截断标 `…`；超大明细请用月份过滤或小 limit。
- code 节点（查账明细/月度汇总的组装节点）spawn 裸 `node` 解释器：dev
  态无虞；**打包态依赖用户机器 PATH 上装有 node**，缺装报
  `interpreter_missing`（运行记录可见引导文案）——2026-10-29 build 验证
  备案（安装包不内嵌 node 运行时）。
