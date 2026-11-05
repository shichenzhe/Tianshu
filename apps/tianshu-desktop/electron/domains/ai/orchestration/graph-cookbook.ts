/**
 * 节点 cookbook（切片 E2）：workflow_write 工具描述的静态注入面
 * ——全 kind 一行摘要 + 常用组合范式 + 照猫画虎引导。纯静态常量（与
 * D4「描述拼数据」的偏离不同：此处无会话数据依赖，静态描述即最优位）。
 * 长度克制：摘要式而非全文 schema（LLM 上下文友好），字段级规范由
 * E1 回喂的「期望形态」按需补课。
 */

/** 全 kind 一行摘要（按用途分组，28 kind） */
export const WORKFLOW_NODE_COOKBOOK = `【节点速查】输入输出均为文本（节点间引用 {{nodes.<id>.output}}，输入变量 {{input.x}}）
- 流程骨架：start（图入口/变量声明载体）｜llm（模型调用，modelId+prompt）｜condition（规则分支）｜intent（语义路由）｜delay（等待）｜subflow（调用已存图，graphId）｜iterate（循环执行子图）｜merge（多上游模板聚合）
- 数据：database（SQL+params 参数化；sqlite 走 sqlitePath 工作空间相对路径，外部库可 dataSourceId 引数据源配置）｜variable（变量轻量变换）｜aggregate（行集统计）｜jsonParse（按 path 提取）/jsonStringify（转 JSON 字面量）
- 文件与表：fileRead/fileWrite（工作空间内读写）｜docExtract（PDF/Word→文本）｜excelRead/excelWrite｜csvRead/csvWrite｜librarySearch（资料库关键词）
- 外联：http（请求）｜email（SMTP）｜notify（桌面通知+IM webhook）｜imageGen（图像）
- 向量：vectorize（入库）/vectorSearch（语义检索）

【常用范式】
1. 建/改表：database 节点跑 DDL（CREATE TABLE IF NOT EXISTS …，幂等）
2. 查询渲染：database(SELECT 参数化)→merge 模板直嵌行集组装展示结构（勿用 code 节点，打包态依赖系统 node）；聚合标量用 jsonParse(path "0.x") 提取后入 merge 模板
3. LLM 加工：llm 节点（prompt 引 {{input.x}}/{{nodes.*.output}}）→结果交 show_summary/show_chart 渲染（show_* 为聊天展示工具，非节点）
4. 写类前置确认：先让用户经 confirm_form 卡确认参数（fields 带 type/enumValues 照抄 workflow_read 输入说明）再执行

【输入声明】inputSchema 支持对象形态 {type:"string"|"number"|"boolean"|"enum"|"date"|"json", required?, default?（json 为对象/数组）, enumValues?(enum 必填), description?}——number 参数原生传库免 CAST，enum 收口值域，date 归一 yyyy-MM-dd（default "today"=执行日），json 对象/数组原生直传（模板 {{input.x}} 处紧凑 stringify；支持字段路径 {{input.x.field}}，数组下标用方括号 {{input.x.items[0].id}}——点号一律字段名，叶子标量 String()/容器 stringify；判空用 null 安全引用 {{input.x.y?}}——null/缺失降空串，配 condition isEmpty）

【照猫画虎】动手前先 workflow_read 看同类图（id 可 workflow_read 无参列清单查，如「记账」三件是 database+merge 范式的现成样板）`;
