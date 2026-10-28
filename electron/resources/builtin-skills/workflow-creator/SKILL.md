---
name: workflow-creator
description: 指导创建工作流：当用户想创建、生成一个工作流（workflow/自动化编排图）时，先读本技能获取节点规范与连线规则，再用 create_workflow 落库
---

# 工作流创作指南

当用户希望你创建一个工作流时，按本指南澄清需求、设计节点清单，生成 graphJson 并调用 create_workflow 保存。

## 流程总览

1. 阅读本指南，掌握节点与连线规则
2. 向用户澄清需求（数据从哪来、怎么处理、结果到哪去；信息足够时跳过）
3. 设计节点清单与连线，生成 graphJson
4. 调用 create_workflow（写操作，用户批准后落库）；可再调 run_workflow 同步试运行验证
5. 告知用户到左侧「工作流」页面查看与完善

**修改已有工作流**：先 get_workflow 拿当前 version 与定义 → 改 graphJson → update_workflow（携 version 乐观锁；冲突则重取再试）。

## graphJson 结构

```json
{
  "version": 1,
  "inputSchema": { "变量名": "string" },
  "nodes": [
    { "id": "start", "name": "开始", "kind": "start", "variables": ["变量名"] },
    ...
  ],
  "edges": [ { "from": "节点id", "to": "节点id 或 END" } ]
}
```

- `inputSchema`：声明输入变量（触发时可填），节点里用 `{{input.变量名}}` 引用
- 节点 id 须 kebab-case（如 `fetch-data`）；name 为用户可读名
- 每个节点必带 `id`、`name`、`kind`
- 流程末端的叶子节点应显式连 `END`（如 `{ "from": "notify", "to": "END" }`），图才在画布上完整收口；遗漏时系统落库会兜底自动补，但生成时显式连上才是规范形态

## 连线规则（校验强约束）

- **唯一入口**：无入边的节点必须恰好 1 个（流程起点；start 节点即天然入口）
- 终点用保留字 `"END"`（不必建节点）
- **条件边**只能从分支类节点引出：`condition`（规则路由）、`intent`（语义路由）、或 llm/code 的 `outputMode: "branch"` 模式；条件边形如 `{ "from": "x", "to": "y", "condition": { "type": "branch", "value": "分支名" } }`，分支名必须在源节点的分支清单内
- 无条件边即顺序执行；多入边节点会等待全部上游完成（天然汇合点）

## 开始节点（kind: "start"）

- **必须包含**：每张图有且仅有一个 start 节点（id 惯例 "start"），**即使没有任何输入变量也不可省略**——缺 start 的图首节点会冒充入口，画布上「开始」卡片缺失、连线断头（系统落库时会兜底自动补齐，但生成时显式包含才是规范形态）。不允许入边。
- `variables` 定义图的输入变量（字符串数组）；生成 graphJson 时
  `inputSchema` 必须与 variables 保持一致（`{ "<变量名>": "string" }`）。
- start 节点不执行任何操作，其余节点经 `{{input.<变量名>}}` 引用输入。

## 节点速查（28 种）

**模型与路由**
- `start`：开始节点（**每图必含，无输入变量也不可省略**）。variables 定义图输入变量（与 inputSchema 一致），无执行语义、不允许入边
- `llm`：调大模型。关键字段 modelId（必填正整数，先问用户用哪个模型）、prompt（{{}} 占位）、systemPrompt、tools、temperature
- `imageGen`：文生图，modelId + prompt
- `condition`：规则分支。branches: [{ name, conditions: [{ source, operator, value }] }]（operator: eq/neq/contains/notContains/isEmpty/notEmpty/gt/gte/lt/lte/regex），fallback 可选
- `intent`：语义分支（模型分类）。modelId + querySource + intents: [{ name, description }]，fallback 可选

**循环与组合**
- `iterate`：循环执行子工作流。loopMode: array（itemsSource 拆项）/ count（countSource 次数）/ while（breakCondition 终止）；graphId 引用子图（**必须用 list_workflows 查真实 id**）；itemVariable/carryVariable/maxItems/onItemError
- `subflow`：调用子工作流。graphId + inputs: [{ key, value }]
- `delay`：等待 seconds 秒
- `merge`：多上游输出按 template 模板拼合
- `code`：跑脚本（language: bash/python/nodejs），script 中 stdout 即输出；上下文经 `{{input.x}}`/`{{nodes.上游id.output}}` 引用；retries 可选失败重试

**输入输出**
- `http`：请求接口。method/url/headers/query/body、auth（none/basic/bearer/header）、retries、timeoutMs
- `fileRead`：读工作空间内文件为文本
- `fileWrite`：写工作空间内文件（mode: append/overwrite）
- `docExtract`：PDF/Word 提取纯文本
- `excelRead`：xlsx 转 JSON 行数组
- `excelWrite`：JSON 行数组写 xlsx
- `csvRead`：CSV 转 JSON 行数组（delimiter/maxRows）
- `csvWrite`：JSON 行数组写 CSV
- `notify`：桌面通知 + 可选 IM webhook（webhookProvider: feishu/dingtalk/wecom/custom）
- `email`：SMTP 发邮件。host/port/secure/username/password/from/to/subject/body；retries 可选闪断重试

**数据处理**
- `database`：五引擎 SQL。engine: sqlite/postgres/mysql/oracle/sqlserver；sqlite 用 sqlitePath，其余用 host/port/database/username/password；sql + params（参数化防注入）；batchSource 批量事务写；retries 可选闪断重试
- `variable`：多变量轻转换。assignments: [{ name, source, ops }]（ops: trim/upper/lower/replace/slice/default/append/toNumber 及日期算子 now/dateAdd/dateFormat）
- `aggregate`：行数组统计。source + ops（count/sum/avg/min/max/distinctCount/groupByCount + field）
- `jsonParse`：JSON 按路径提取
- `jsonStringify`：安全转 JSON 字面量
- `librarySearch`：资料库关键词检索
- `vectorize`：文本分块向量化入库
- `vectorSearch`：语义相似检索

## 输出引用

任何上游节点的输出用 `{{nodes.节点id.output}}` 引用；循环节点另有 `{{nodes.节点id.errorOutput}}`（失败项死信，需 onItemError: continue）。

## 定时执行工作流

需要按计划自动运行工作流时，用 `create_automation_task` 直连（**不要**用 prompt 让 AI 到点再调 run_workflow——每轮多耗一次模型会话且绕路）：

- 参数带 `graphId`（与 prompt 二选一；真实 id 用 list_workflows 查询）+ `schedule`/`scheduleText`，示例 `{ "name": "每日更新", "graphId": 3, "schedule": { "mode": "periodic", "kind": "daily", "time": "09:00" }, "scheduleText": "每天 09:00" }`
- 任务默认受限模式：图含代码/文件写入节点时会在任务详情开启「允许完全访问」或在设置-安全中心命令名单放行**解释器**（bash/python3/node）后方可执行（放行脚本内命令如 git 无效——脚本以解释器整段执行）
- 修改已有任务到「自动化」页操作（对话工具仅支持创建）

## 典型范式

**ETL 链**（无模型的纯数据处理）：
`csvRead → code(清洗) → database(batchSource 写入) → email(发送报告)`

**路由分流**：
`code(取输入) → condition/intent(分流) → 各分支 llm 处理 → END`

**逐项循环**（对列表每条记录执行子流程）：
父图 `iterate(itemsSource: {{nodes.取数.output}}, graphId: 子图id)`；子图先单独建好并保存（也可以在本次对话里先创建子图再创建父图，用 list_workflows 确认 id）。

## 注意事项

- 校验失败时 create_workflow/update_workflow 会返回结构化问题（错误码 + 节点定位），修正后直接重试
- 模型类节点（llm/imageGen/intent）的 modelId 无法凭空生成——问用户，或从对话上下文确认
- iterate/subflow 的 graphId 必须是已存在图的 id（list_workflows 查询）
- 图保存后默认启用状态待用户在工作流页确认；建议创建后引导用户先试运行
