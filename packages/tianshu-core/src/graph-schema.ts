/**
 * GraphJson 结构与校验（spec §3）：节点/边/条件边/输入变量。
 * GA-T2 全量入 @tianshu/core（37 zod schema + z.infer 推断类型 + 校验
 * 函数，controller ruling 3——core peerDep 加 zod）；老路径
 * src-react/domains/ai/orchestration/api/graph.schema 改 re-export，
 * 渲染层既有 import 链零变化（前后端共享先例 schedule-schema）。
 * v1 节点仅 kind:"llm"，schema 预留扩展值由 zod enum 收口——加类型
 * 只改这里。尾部另宿主 eventJsonSchema（spec §5 事件触发配置）。
 * GraphIssue 纯类型自 @tianshu/protocol re-export（GA-T1 收编，保留）。
 */
import type { GraphIssue } from "@tianshu/protocol";
import { z } from "zod";

/** 共有节点字段（id/name/position）；kind 分流 llm|code，见 graphNodeSchema */
const nodeBase = {
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "节点 id 须为 kebab-case"),
  name: z.string().min(1),
  /** 画布坐标（画布编辑器）：旧图缺省 → autoLayout 补；执行器忽略 */
  position: z
    .object({ x: z.number().finite(), y: z.number().finite() })
    .optional(),
};

/** 开始节点（kind:start）：图输入变量定义载体（编辑回写
 *  graph.inputSchema，单一事实源不变）；执行直通、无输出 */
export const startNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("start"),
  variables: z.array(z.string().min(1)).default([]),
});

/** 代码节点（kind:code）：确定性执行脚本，stdout 即节点 output。
 * 超时上限 24h（用户裁定可调），缺省 30s；无 OS 级沙箱，解释器经
 * commandGate 门禁（执行器侧）。分支模式：stdout 最后一个非空行作
 * 分支标签（执行器侧解析），branch 节点必带非空 branchOptions（与
 * llm 节点同约束） */
export const codeNodeSchema = z
  .object({
    ...nodeBase,
    kind: z.literal("code"),
    language: z.enum(["nodejs", "python", "bash"]),
    /** Python 解释器命令（缺省 python——Windows 发行版多只有 python；
     * 仅 python3 的环境节点级切换）；仅 language=python 时生效 */
    pythonCommand: z.enum(["python", "python3"]).default("python"),
    script: z.string().min(1),
    timeoutMs: z.number().int().min(1_000).max(86_400_000).default(30_000),
    outputMode: z.enum(["text", "branch"]).default("text"),
    branchOptions: z.array(z.string().min(1)).optional(),
    /** 失败重试（0-5 次、0.5s 间隔；语义性失败如脚本报错不重试） */
    retries: z.number().int().min(0).max(5).default(0),
  })
  .superRefine((node, ctx) => {
    if (node.outputMode === "branch" && !hasBranchOptions(node)) {
      ctx.addIssue({
        code: "custom",
        message: "branchOptionsRequired",
        params: { nodeId: node.id },
      });
    }
  });

/** 键值对（HTTP 头/查询参数）：数组保序、可重复 key；value 支持模板
 * 占位符（执行前替换） */
export const httpKVSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
});
export type HttpKV = z.infer<typeof httpKVSchema>;

/** 鉴权配置：basic（base64 用户名密码）/ bearer（token）/ header（自定义
 * 头名值）/ acs3（阿里云 ACS3-HMAC-SHA256 签名，签名头 key 可配置）；
 * 凭据值支持模板占位符（执行前替换）；注入时覆盖同名头 */
export const httpAuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({
    type: z.literal("basic"),
    user: z.string(),
    password: z.string(),
  }),
  z.object({ type: z.literal("bearer"), token: z.string() }),
  z.object({
    type: z.literal("header"),
    name: z.string().min(1),
    value: z.string(),
  }),
  z.object({
    type: z.literal("acs3"),
    accessKeyId: z.string().min(1),
    accessKeySecret: z.string().min(1),
    /** 参与签名的自定义头前缀（默认 x-acs-；用 ACS3 算法对接头名
     * 不同的其他网关时可改写。date/signature-nonce/content-sha256
     * 三头按此前缀自动注入，签名头集合也随之匹配） */
    headerPrefix: z.string().min(1).default("x-acs-"),
    /** 签名算法标识（Authorization 首段与 StringToSign 首行；阿里云
     * ACS3-HMAC-SHA256，结构相同的兼容网关可按需改写标识） */
    algorithm: z.string().min(1).default("ACS3-HMAC-SHA256"),
  }),
]);
export type HttpAuth = z.infer<typeof httpAuthSchema>;

/** HTTP 节点（kind:http，参照 Coze HTTP 节点）：模板替换后的
 * url/headers/query/body 发起请求，响应体（文本，64KB 截断）即节点
 * output；非 2xx → 节点失败。bodyType=binary 时 body 为文件路径（相对
 * 工作空间或绝对，读文件 Buffer 上传，上限 10MB）。失败（网络/非 2xx）
 * 按 retries 重试（固定间隔）。超时默认 120s 上限 600s */
export const httpNodeSchema = z.preprocess(
  // bodyType 缺省且带 body → 推断 json（写了 body 即意图发送；缺省 none
  // 会致 UI 不显示请求体、执行器不发送——body 数据被静默藏掉）。显式
  // "none" 不覆盖
  (raw) =>
    raw &&
    typeof raw === "object" &&
    !("bodyType" in raw) &&
    typeof (raw as { body?: unknown }).body === "string" &&
    (raw as { body: string }).body !== ""
      ? { ...raw, bodyType: "json" }
      : raw,
  z.object({
    ...nodeBase,
    kind: z.literal("http"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    url: z.string().min(1),
    headers: z.array(httpKVSchema).default([]),
    query: z.array(httpKVSchema).default([]),
    auth: httpAuthSchema.default({ type: "none" }),
    bodyType: z
      .enum(["none", "json", "text", "form", "binary"])
      .default("none"),
    body: z.string().optional(),
    retries: z.number().int().min(0).max(5).default(0),
    timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
  }),
);

const llmNodeSchema = z
  .object({
    ...nodeBase,
    // 旧图节点无 kind 字段（零迁移兼容）：default 补 "llm"——code 支路
    // 在 union 前位显式匹配，缺 kind 的旧数据落到本支补默认
    kind: z.literal("llm").default("llm"),
    modelId: z.number().int().positive(),
    systemPrompt: z.string().optional(),
    prompt: z.string().min(1),
    temperature: z.number().min(0).max(2).optional(),
    tools: z.union([z.boolean(), z.array(z.string().min(1))]).default(false),
    maxSteps: z.number().int().min(1).max(50).optional(),
    outputMode: z.enum(["text", "branch"]).default("text"),
    branchOptions: z.array(z.string().min(1)).optional(),
    /** 异常处理（对照 Coze）：整体执行超时（默认 180s 上限 1h，含重试
     * 全程）；重试次数（调用/超时/解析失败，配置类错误不重试）；
     * onError=defaultValue 时节点失败以 errorOutput 作为输出继续下游
     * （中断流程 abort 为默认） */
    timeoutMs: z.number().int().min(1_000).max(3_600_000).default(180_000),
    retries: z.number().int().min(0).max(5).default(0),
    onError: z.enum(["abort", "defaultValue"]).default("abort"),
    errorOutput: z.string().optional(),
  })
  // branch 节点必带分支选项（条件边路由/执行器标签判定都依赖它）；
  // message 即结构化 GraphIssue code，validateGraph 映射还原 params
  .superRefine((node, ctx) => {
    if (node.outputMode === "branch" && !hasBranchOptions(node)) {
      ctx.addIssue({
        code: "custom",
        message: "branchOptionsRequired",
        params: { nodeId: node.id },
      });
    }
  });

/** 文件读取节点（kind:fileRead）：path 限工作空间目录内（授权边界，
 * 防越界读任意路径），utf-8 文本（1MB 上限）即节点 output 喂下游 */
export const fileReadNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("fileRead"),
  path: z.string().min(1),
});

/** 通知节点（kind:notify）：title/body 模板替换后发系统桌面通知 +
 * 可选 IM webhook（飞书/钉钉/企微/自定义 JSON）；output 为标题+正文 */
export const notifyNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("notify"),
  title: z.string().min(1),
  body: z.string().optional(),
  /** IM webhook 渠道（可选，与桌面通知并存） */
  webhookProvider: z
    .enum(["none", "feishu", "dingtalk", "wecom", "custom"])
    .default("none"),
  webhookUrl: z.string().default(""),
});

/** 子工作流节点（kind:subflow）：graphId 引用已保存图，inputs 为变量
 * 映射（key=子图变量名，value 支持 {{}} 占位）；输出为子图终点节点
 * 的完整 output。运行记录/会话归属子图；循环引用运行期拦截 */
export const subflowNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("subflow"),
  graphId: z.number().int().positive(),
  inputs: z.array(httpKVSchema).default([]),
  /** 异步模式：fire-and-forget——提交子工作流后主流程立即继续（回执
   * 文案），子任务独立运行不受父流程结束/中止影响；运行记录落子
   * 工作流自身历史 */
  async: z.boolean().default(false),
});

/** 比较算子（条件分支/循环终止条件共用）：eq/neq/contains 系字符串、
 * gt~lte 数字、isEmpty/notEmpty 无值、regex 正则 */
export const conditionOperatorSchema = z.enum([
  "eq",
  "neq",
  "contains",
  "notContains",
  "isEmpty",
  "notEmpty",
  "gt",
  "gte",
  "lt",
  "lte",
  "regex",
]);
export type ConditionOperator = z.infer<typeof conditionOperatorSchema>;

/** 循环节点（kind:iterate）：loopMode=array 用 itemsSource 表达式（JSON
 * 数组优先，解析失败按行拆分）逐项执行子工作流；loopMode=count 用
 * countSource（正整数或 {{}} 占位）生成 1..N 序数循环；loopMode=while
 * 无限循环（Coze while 语义），每轮执行子图后求值 breakCondition（source
 * 渲染上下文注入本轮子图输出，{{nodes.<本节点>.output}} 可引用）满足即
 * 跳出，maxItems 作保险丝、强制串行。carryVariable 承接变量（Coze 中间
 * 变量极简版）：每轮注入子图 {carryVariable}=上一轮子图输出（首轮用
 * carryInitial）。item 注入 itemVariable，索引注入 <itemVariable>Index，
 * 各项输出按行 join 为节点 output；concurrency 分批并发（while 不适用）；
 * onItemError=continue 时失败项跳过（全败才失败） */
export const iterateNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("iterate"),
  loopMode: z.enum(["array", "count", "while"]).default("array"),
  itemsSource: z.string().default(""),
  countSource: z.string().optional(),
  graphId: z.number().int().positive(),
  itemVariable: z.string().min(1).default("item"),
  /** while 模式终止条件（同 condition 单条件结构） */
  breakCondition: z
    .object({
      source: z.string().min(1),
      operator: conditionOperatorSchema,
      value: z.string().optional(),
    })
    .optional(),
  /** 承接变量名（空=不启用）；值 = 上一轮子图输出（首轮 carryInitial） */
  carryVariable: z.string().optional(),
  carryInitial: z.string().default(""),
  maxItems: z.number().int().min(1).max(1_000).default(100),
  concurrency: z.number().int().min(1).max(5).default(1),
  onItemError: z.enum(["abort", "continue"]).default("abort"),
});

/** 资料库检索节点（kind:librarySearch）：keywords 关键词（空格分词
 * AND，{{}} 占位）在资料库文本文件中做内容匹配，输出命中文件名+片段
 * （≤maxResults 段）。v1 为关键词检索；向量语义检索为后续演进（对齐
 * Coze 知识库节点的召回形态）。字段名用 keywords 避开 HttpNode.query */
export const librarySearchNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("librarySearch"),
  keywords: z.string().min(1),
  maxResults: z.number().int().min(1).max(20).default(5),
});

/** JSON 反序列化节点（kind:jsonParse）：source（{{}} 表达式，典型来自
 * HTTP 响应体）解析后按 path 点路径提取（a.b / a[0].b）；arrayLines 时
 * path 处数组逐行展开（字符串项原样、其余紧凑 JSON），直连循环节点 */
export const jsonParseNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("jsonParse"),
  source: z.string().min(1),
  path: z.string().optional(),
  arrayLines: z.boolean().default(false),
});

/** JSON 序列化节点（kind:jsonStringify）：source 为合法 JSON 对象/数组
 * 时输出紧凑规范化串；否则按纯文本输出 JSON 字符串字面量（引号/换行
 * 转义）——解决 {{nodes.x.output}} 直接嵌入 JSON body 破格式问题 */
export const jsonStringifyNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("jsonStringify"),
  source: z.string().min(1),
});

/** 条件分支节点（kind:condition，Coze Choice 式）：多分支按序评估
 * （分支内条件 AND），命中即路由到同名条件边；fallback 为全不中时的
 * 兜底分支名；无兜底则回落 END。source/value 均支持 {{}} 占位符 */
export const conditionBranchSchema = z.object({
  /** 分支名（与条件边 label 对应，即该分支的输出通道） */
  name: z.string().min(1),
  /** 分支内条件（全部满足才命中） */
  conditions: z
    .array(
      z.object({
        source: z.string().min(1),
        operator: conditionOperatorSchema,
        value: z.string().optional(),
      }),
    )
    .default([]),
});
export type ConditionBranch = z.infer<typeof conditionBranchSchema>;

export const conditionNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("condition"),
  branches: z.array(conditionBranchSchema).min(1),
  fallback: z.string().optional(),
});

/** 意图识别节点（kind:intent，Coze Intent 式语义路由）：querySource（{{}}
 * 占位）交模型分类到 intents 清单（name=分支输出通道，description 辅助
 * 分类，零 prompt 门槛）；命中 → route=output=意图名（条件边挂意图名，
 * 机制与 condition 同构）；未命中走 fallback（无则 intent_no_match
 * 失败）。规则路由用 condition，自由 prompt 约束路由见 llm 节点
 * outputMode:branch（存量兼容，不再暴露新入口）。字段名避开 HttpNode
 * .query（HttpKV[]）的 Patch 撞名（searchQuery/keywords 先例） */
export const intentNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("intent"),
  modelId: z.number().int().positive(),
  querySource: z.string().min(1),
  intents: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().default(""),
      }),
    )
    .min(1),
  fallback: z.string().optional(),
  timeoutMs: z.number().int().min(1_000).max(86_400_000).default(60_000),
});

/** 文件写入节点（kind:fileWrite）：content 模板替换后写回工作空间内
 * 文件（append 追加带换行 / overwrite 覆盖），目录自动创建；写操作走
 * codeAuthorized 门禁（default 任务拒写，对齐 run_command 语义） */
export const fileWriteNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("fileWrite"),
  path: z.string().min(1),
  mode: z.enum(["append", "overwrite"]).default("append"),
  content: z.string(),
});

/** 文档提取节点（kind:docExtract）：PDF/Word（pdf-parse/mammoth 懒加载）
 * → 纯文本输出（maxChars 截断）；txt/md 直读；限工作空间内 */
export const docExtractNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("docExtract"),
  path: z.string().min(1),
  maxChars: z.number().int().min(1_000).max(512_000).default(64_000),
});

/** 图像生成节点（kind:imageGen）双协议：openai（默认，OpenAI 兼容
 * images/generations，b64_json/url 双兼容）/ comfyui（workflow API——
 * POST /prompt 提交 + /history 轮询 + /view 取图，workflowJson 占位符
 * 注入见 executor）。平铺 + superRefine 互斥而非 discriminatedUnion——
 * 旧图数据无 protocol 字段，union 分发两分支皆失败会打翻整图解析 */
export const imageGenNodeSchema = z
  .object({
    ...nodeBase,
    kind: z.literal("imageGen"),
    protocol: z.enum(["openai", "comfyui"]).default("openai"),
    modelId: z.number().int().positive().optional(),
    providerId: z.number().int().positive().optional(),
    workflowJson: z.string().optional(),
    prompt: z.string().min(1),
    size: z.string().default("1024x1024"),
    randomizeSeed: z.boolean().default(true),
    timeoutMs: z.number().int().min(5_000).max(600_000).default(300_000),
  })
  .superRefine((node, ctx) => {
    if (node.protocol === "openai" && !node.modelId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["modelId"],
        message: "openai 协议必须选择模型",
      });
    }
    if (
      node.protocol === "comfyui" &&
      (!node.providerId || !node.workflowJson)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["providerId"],
        message: "comfyui 协议必须配置服务商与 workflow JSON",
      });
    }
  });

/** 延时节点（kind:delay）：等待 N 秒（轮询间隔/节流；随图中止）。
 * 人在环审批需待审中心+持久化支撑，后续单独立项 */
export const delayNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("delay"),
  seconds: z.number().int().min(1).max(600).default(60),
});

/** 数据库节点（kind:database）：五引擎统一 (sql, params) 查询——SQLite
 * （better-sqlite3，限工作空间内文件）+ PostgreSQL/MySQL/Oracle(thin)/
 * SqlServer（连接参数直配，{{}} 占位）；params 参数化（?/$1/:name 按各
 * 家驱动原样透传）防注入；SELECT 行数组 JSON / 写操作 affectedRows。
 * ETL 补强：maxRows 可配（默认 1000 上限 10 万，输出字节联动）；batchSource
 * （JSON 二维参数数组）非空时批量模式——事务包裹逐行绑定，失败整体回滚 */
export const databaseNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("database"),
  engine: z.enum(["sqlite", "postgres", "mysql", "oracle", "sqlserver"]),
  sqlitePath: z.string().default(""),
  host: z.string().default(""),
  port: z.number().int().min(1).max(65_535).default(5432),
  database: z.string().default(""),
  username: z.string().default(""),
  password: z.string().default(""),
  sql: z.string().min(1),
  params: z.array(z.string()).default([]),
  /** SELECT 行数上限（默认 1000；ETL 大表可到 10 万，输出字节上限联动） */
  maxRows: z.number().int().min(1).max(100_000).default(1_000),
  /** 批量模式：JSON 数组，每项为一行参数数组（[[p1,p2],...]，{{}} 占位）；
   * 非空时 sql 为单行模板逐行绑定，事务包裹，输出总 affectedRows */
  batchSource: z.string().default(""),
  /** 连接闪断等易抖失败重试（0-5 次、0.5s 间隔） */
  retries: z.number().int().min(0).max(5).default(0),
});

/** Excel 读取节点（kind:excelRead）：xlsx 工作空间文件 → 指定 sheet 的
 * JSON 行数组（首行为键，空键补列号），供下游 JSON 解析/循环节点；
 * maxRows 熔断防失控（csvRead 同款——超限失败不静默截断） */
export const excelReadNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("excelRead"),
  path: z.string().min(1),
  sheet: z.string().default(""),
  /** 数据行数上限（不含表头；默认 1000，大表可到 10 万） */
  maxRows: z.number().int().min(1).max(100_000).default(1_000),
});

/** Excel 写入节点（kind:excelWrite）：rowsSource（JSON 数组，{{}} 占位）
 * → xlsx 写回工作空间（走写授权）；输出回执 */
export const excelWriteNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("excelWrite"),
  path: z.string().min(1),
  sheet: z.string().default("Sheet1"),
  rowsSource: z.string().min(1),
});

/** CSV 读取节点（kind:csvRead）：工作空间内 CSV 流式解析（RFC4180 状态
 * 机——引号包裹/内嵌分隔符与换行/双引号转义；分块读不全量驻留）→ 首
 * 行为键的 JSON 行数组（同 excelRead 输出形态）；delimiter 语义枚举；
 * maxRows 熔断防失控（同 database） */
export const csvReadNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("csvRead"),
  path: z.string().min(1),
  delimiter: z.enum(["comma", "semicolon", "tab"]).default("comma"),
  maxRows: z.number().int().min(1).max(100_000).default(1_000),
});

/** CSV 写入节点（kind:csvWrite）：rowsSource（JSON 行数组，{{}} 占位）
 * → RFC4180 转义序列化写回工作空间（走写授权，excelWrite 同款） */
export const csvWriteNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("csvWrite"),
  path: z.string().min(1),
  rowsSource: z.string(),
});

/** 变量节点（kind:variable）：多变量轻量赋值——source（{{}} 占位）渲染
 * 后顺序应用操作链（trim/大小写/替换/截取/空兜底/追加/数值化），产出
 * JSON 对象（下游 jsonParse 或整体引用），免去为一行转换写 code 脚本 */
export const variableTransformSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("trim") }),
  z.object({ type: z.literal("upper") }),
  z.object({ type: z.literal("lower") }),
  z.object({
    type: z.literal("replace"),
    find: z.string().min(1),
    replacement: z.string(),
  }),
  z.object({
    type: z.literal("slice"),
    start: z.number().int().min(0),
    end: z.number().int().min(0).optional(),
  }),
  z.object({ type: z.literal("default"), value: z.string() }),
  z.object({ type: z.literal("append"), text: z.string() }),
  z.object({ type: z.literal("toNumber") }),
  /** 日期算子：now 取执行时刻；dateAdd 偏移（可负）；dateFormat 按
   * date-fns 模式串格式化（yyyy-MM-dd HH:mm 等）。非法日期串保持原样 */
  z.object({ type: z.literal("now") }),
  z.object({
    type: z.literal("dateAdd"),
    amount: z.number().int(),
    unit: z.enum(["minutes", "hours", "days", "months"]),
  }),
  z.object({ type: z.literal("dateFormat"), format: z.string().min(1) }),
]);
export type VariableTransform = z.infer<typeof variableTransformSchema>;

export const variableNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("variable"),
  assignments: z
    .array(
      z.object({
        /** 变量名（输出对象的键） */
        name: z.string().min(1),
        source: z.string(),
        ops: z.array(variableTransformSchema).default([]),
      }),
    )
    .min(1),
});

/** 聚合统计节点（kind:aggregate）：source（JSON 行数组优先，否则按非空
 * 行）→ count/sum/avg/min/max（数值字段）、distinctCount（字段或整行）、
 * groupByCount（分组计数）→ 各操作结果按键的 JSON 对象输出（键为
 * type 或 type:field），iterate 多行结果的收尾统计 */
export const aggregateOpSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("count") }),
  z.object({ type: z.literal("sum"), field: z.string().min(1) }),
  z.object({ type: z.literal("avg"), field: z.string().min(1) }),
  z.object({ type: z.literal("min"), field: z.string().min(1) }),
  z.object({ type: z.literal("max"), field: z.string().min(1) }),
  z.object({
    type: z.literal("distinctCount"),
    field: z.string().optional(),
  }),
  z.object({ type: z.literal("groupByCount"), field: z.string().min(1) }),
]);
export type AggregateOp = z.infer<typeof aggregateOpSchema>;

export const aggregateNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("aggregate"),
  source: z.string().min(1),
  ops: z.array(aggregateOpSchema).min(1),
});

/** 邮件节点（kind:email）：nodemailer SMTP 直连发送（凭据存图 JSON 同
 * http 鉴权先例）；from/to/subject/body 支持 {{}} 占位；失败归因
 * email_send_failed */
export const emailNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("email"),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  secure: z.boolean().default(true),
  username: z.string().default(""),
  password: z.string().default(""),
  from: z.string().min(1),
  /** 多收件人逗号分隔 */
  to: z.string().min(1),
  subject: z.string(),
  body: z.string(),
  /** SMTP 闪断重试（0-5 次、0.5s 间隔） */
  retries: z.number().int().min(0).max(5).default(0),
});

/** 聚合节点（kind:merge）：多上游输出按模板聚合为单 output（LangGraph
 * 多入边天然同步等待全部上游完成，state.nodes 已含各上游结果） */
export const mergeNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("merge"),
  template: z.string().min(1),
});

/** 向量化入库节点（kind:vectorize）：text（占位符，典型接文档提取/
 * 文件读取输出）分块 → embedding（OpenAI 兼容 /embeddings）→ 落库到
 * collection（条目级 upsert 重跑幂等）；输出为入库回执 */
export const vectorizeNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("vectorize"),
  collection: z.string().min(1),
  sourceName: z.string().min(1),
  text: z.string().min(1),
  modelId: z.number().int().positive(),
  /** embedding 调用整体超时（缺省 120s，上限 10 分钟） */
  timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
  chunkSize: z.number().int().min(100).max(4_000).default(500),
  chunkOverlap: z.number().int().min(0).max(500).default(100),
});

/** 语义检索节点（kind:vectorSearch）：searchQuery → embedding → 同模型
 * 块余弦 topK →「【条目名】片段」多段输出；collection 空串检索全集合。
 * 字段名避开 HttpNode.query（键值对）的 Patch 撞名（keywords 先例） */
export const vectorSearchNodeSchema = z.object({
  ...nodeBase,
  kind: z.literal("vectorSearch"),
  collection: z.string().default(""),
  searchQuery: z.string().min(1),
  modelId: z.number().int().positive(),
  /** embedding 调用整体超时（缺省 120s，上限 10 分钟） */
  timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
  topK: z.number().int().min(1).max(20).default(5),
});

export const graphNodeSchema = z.union([
  codeNodeSchema,
  llmNodeSchema,
  httpNodeSchema,
  fileReadNodeSchema,
  notifyNodeSchema,
  subflowNodeSchema,
  iterateNodeSchema,
  librarySearchNodeSchema,
  jsonParseNodeSchema,
  jsonStringifyNodeSchema,
  conditionNodeSchema,
  intentNodeSchema,
  fileWriteNodeSchema,
  docExtractNodeSchema,
  imageGenNodeSchema,
  delayNodeSchema,
  vectorizeNodeSchema,
  vectorSearchNodeSchema,
  databaseNodeSchema,
  excelReadNodeSchema,
  excelWriteNodeSchema,
  csvReadNodeSchema,
  csvWriteNodeSchema,
  variableNodeSchema,
  aggregateNodeSchema,
  emailNodeSchema,
  mergeNodeSchema,
  startNodeSchema,
]);

export type LlmNode = z.infer<typeof llmNodeSchema>;
export type CodeNode = z.infer<typeof codeNodeSchema>;
export type HttpNode = z.infer<typeof httpNodeSchema>;
export type FileReadNode = z.infer<typeof fileReadNodeSchema>;
export type NotifyNode = z.infer<typeof notifyNodeSchema>;
export type SubflowNode = z.infer<typeof subflowNodeSchema>;
export type IterateNode = z.infer<typeof iterateNodeSchema>;
export type LibrarySearchNode = z.infer<typeof librarySearchNodeSchema>;
export type JsonParseNode = z.infer<typeof jsonParseNodeSchema>;
export type JsonStringifyNode = z.infer<typeof jsonStringifyNodeSchema>;
export type ConditionNode = z.infer<typeof conditionNodeSchema>;
export type IntentNode = z.infer<typeof intentNodeSchema>;
export type FileWriteNode = z.infer<typeof fileWriteNodeSchema>;
export type DocExtractNode = z.infer<typeof docExtractNodeSchema>;
export type ImageGenNode = z.infer<typeof imageGenNodeSchema>;

/** comfyui 形收窄（executor/UI 分流用，字段非空保证来自 superRefine） */
export type ComfyImageGenNode = ImageGenNode & {
  protocol: "comfyui";
  providerId: number;
  workflowJson: string;
};

export function isComfyUIImageGen(
  node: ImageGenNode,
): node is ComfyImageGenNode {
  return (
    node.protocol === "comfyui" &&
    typeof node.providerId === "number" &&
    typeof node.workflowJson === "string"
  );
}
export type DelayNode = z.infer<typeof delayNodeSchema>;
export type VectorizeNode = z.infer<typeof vectorizeNodeSchema>;
export type VectorSearchNode = z.infer<typeof vectorSearchNodeSchema>;
export type DatabaseNode = z.infer<typeof databaseNodeSchema>;
export type ExcelReadNode = z.infer<typeof excelReadNodeSchema>;
export type ExcelWriteNode = z.infer<typeof excelWriteNodeSchema>;
export type CsvReadNode = z.infer<typeof csvReadNodeSchema>;
export type CsvWriteNode = z.infer<typeof csvWriteNodeSchema>;
export type VariableNode = z.infer<typeof variableNodeSchema>;
export type AggregateNode = z.infer<typeof aggregateNodeSchema>;
export type EmailNode = z.infer<typeof emailNodeSchema>;
export type MergeNode = z.infer<typeof mergeNodeSchema>;
export type StartNode = z.infer<typeof startNodeSchema>;
export type GraphNode = z.infer<typeof graphNodeSchema>;

/** 类型守卫：分支窄化（executor/编辑器按 kind 分流渲染与执行） */
export function isLlmNode(node: GraphNode): node is LlmNode {
  return node.kind === "llm";
}

export function isHttpNode(node: GraphNode): node is HttpNode {
  return node.kind === "http";
}

export function isStartNode(node: GraphNode): node is StartNode {
  return node.kind === "start";
}

function hasBranchOptions(node: {
  branchOptions?: string[] | undefined;
}): boolean {
  return (node.branchOptions?.length ?? 0) > 0;
}

/** 节点的条件边可选标签（分支输出通道）：condition=分支名+兜底、
 * intent=意图名+兜底、llm/code 仅 outputMode=branch；其余节点 null。
 * 编辑器边条件编辑与画布条件边校验共用（与 validateGraph 同规） */
export function branchOptionsOf(node: GraphNode): string[] | null {
  if (node.kind === "condition") {
    return [
      ...node.branches.map((branch) => branch.name),
      ...(node.fallback ? [node.fallback] : []),
    ];
  }
  if (node.kind === "intent") {
    return [
      ...node.intents.map((intent) => intent.name),
      ...(node.fallback ? [node.fallback] : []),
    ];
  }
  if (
    (node.kind === "llm" || node.kind === "code") &&
    node.outputMode === "branch"
  ) {
    return node.branchOptions ?? [];
  }
  return null;
}

export const graphEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  condition: z
    .object({ type: z.literal("branch"), value: z.string().min(1) })
    .optional(),
});

export const graphJsonSchema = z.object({
  version: z.literal(1),
  inputSchema: z.record(z.string(), z.literal("string")).default({}),
  nodes: z.array(graphNodeSchema).min(1),
  // edges 不设 min(1)：「多节点零边」是非法图但须由 validateGraph 的
  // 唯一入口检查给出可读错误，而非 schema 层笼统的 Too small
  edges: z.array(graphEdgeSchema),
  /** END 虚拟节点画布坐标（仅布局元数据，执行器忽略；缺省自动摆右缘） */
  endPosition: z
    .object({ x: z.number().finite(), y: z.number().finite() })
    .optional(),
});

export type GraphEdge = z.infer<typeof graphEdgeSchema>;
export type GraphJson = z.infer<typeof graphJsonSchema>;

export type { GraphIssue };

/** zod issue → 结构化 GraphIssue（最小结构投影，避免绑内部 d.ts 类型） */
interface ZodIssueLike {
  code: string;
  message: string;
  path: PropertyKey[];
  params?: unknown;
}

/** path 首段 nodes.<下标>. 还原为节点 id（多节点时文案须对上画布节点，
 * 下标会随删增漂移）；json 非对象/越界/无 id 时保留原下标（防御性） */
function humanizeNodePath(
  path: PropertyKey[],
  json: unknown,
): { path: string; nodeId?: string } {
  const joined = path.map(String).join(".");
  const matched = /^nodes\.(\d+)\./.exec(joined);
  if (!matched) {
    return { path: joined };
  }
  const nodes = (json as { nodes?: unknown[] } | null)?.nodes;
  const at = Array.isArray(nodes) ? nodes[Number(matched[1])] : undefined;
  const id =
    at !== null && typeof at === "object"
      ? (at as { id?: unknown }).id
      : undefined;
  if (typeof id !== "string") {
    return { path: joined };
  }
  return { path: joined.replace(matched[0], `nodes.${id}.`), nodeId: id };
}

function toGraphIssue(i: ZodIssueLike, json: unknown): GraphIssue {
  if (i.code === "custom" && i.message === "branchOptionsRequired") {
    const params = i.params as Record<string, string | number> | undefined;
    return { code: "branchOptionsRequired", ...(params ? { params } : {}) };
  }
  const { path, nodeId } = humanizeNodePath(i.path, json);
  return {
    code: "schema",
    params: { path, message: i.message, ...(nodeId ? { nodeId } : {}) },
  };
}

/** LangGraph 执行状态通道名：节点 id 与通道共享命名空间，撞名会在
 * 编译期报晦涩的 "already being used"——保存期在此前置拦截 */
const RESERVED_NODE_IDS = new Set(["inputs", "nodes", "route"]);

/** 跨节点结构校验（spec §3 保存期校验清单） */
export function validateGraph(
  json: unknown,
): { ok: true; value: GraphJson } | { ok: false; issues: GraphIssue[] } {
  const parsed = graphJsonSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => toGraphIssue(issue, json)),
    };
  }
  const { nodes, edges } = parsed.data;
  const ids = new Set(nodes.map((n) => n.id));
  const issues: GraphIssue[] = [];
  if (new Set(nodes.map((n) => n.id)).size !== nodes.length) {
    issues.push({ code: "duplicateNodeId" });
  }
  for (const n of nodes) {
    if (RESERVED_NODE_IDS.has(n.id)) {
      issues.push({ code: "reservedNodeId", params: { nodeId: n.id } });
    }
    // 循环节点按模式必填：array 查列表表达式、count 查次数表达式
    // （loopMode）、while 查终止条件
    if (n.kind === "iterate") {
      if (n.loopMode === "count") {
        if (!(n.countSource ?? "").trim()) {
          issues.push({
            code: "iterateCountRequired",
            params: { nodeId: n.id },
          });
        }
      } else if (n.loopMode === "while") {
        if (!n.breakCondition?.source.trim()) {
          issues.push({
            code: "iterateBreakRequired",
            params: { nodeId: n.id },
          });
        }
      } else if (!n.itemsSource.trim()) {
        issues.push({
          code: "iterateItemsRequired",
          params: { nodeId: n.id },
        });
      }
    }
  }
  // 唯一入口：无入边的节点必须恰有 1 个（START 直连）
  const noIncoming = nodes.filter((n) => !edges.some((e) => e.to === n.id));
  if (noIncoming.length !== 1) {
    issues.push({ code: "uniqueEntry", params: { count: noIncoming.length } });
  }
  // start 节点即入口：全图至多一个（nodeId 定位首个多余 start）；
  // 不得有入边（入边破坏唯一入口判定与执行直通语义）
  const startNodes = nodes.filter((n) => n.kind === "start");
  if (startNodes.length > 1) {
    issues.push({
      code: "duplicateStartNode",
      params: { nodeId: startNodes[1].id },
    });
  }
  const incomingStart = edges.find((e) =>
    startNodes.some((s) => s.id === e.to),
  );
  if (incomingStart) {
    issues.push({
      code: "startIncomingEdge",
      params: { nodeId: incomingStart.to },
    });
  }
  for (const e of edges) {
    if (!ids.has(e.from)) {
      issues.push({
        code: "danglingEdge",
        params: { side: "from", nodeId: e.from },
      });
    }
    if (e.to !== "END" && !ids.has(e.to)) {
      issues.push({
        code: "danglingEdge",
        params: { side: "to", nodeId: e.to },
      });
    }
  }
  const branchable = new Map<
    string,
    { id: string; branchOptions?: string[] }
  >();
  for (const n of nodes) {
    if (n.kind === "condition") {
      // 条件节点的分支通道 = 分支名 + 兜底名（条件边 label 可挂任意之一）
      branchable.set(n.id, {
        id: n.id,
        branchOptions: [
          ...n.branches.map((branch) => branch.name),
          ...(n.fallback ? [n.fallback] : []),
        ],
      });
    } else if (n.kind === "intent") {
      // 意图节点分支通道 = 意图名 + 兜底（机制与 condition 同构）
      branchable.set(n.id, {
        id: n.id,
        branchOptions: [
          ...n.intents.map((intent) => intent.name),
          ...(n.fallback ? [n.fallback] : []),
        ],
      });
    } else if (
      (n.kind === "llm" || n.kind === "code") &&
      n.outputMode === "branch"
    ) {
      branchable.set(n.id, n);
    }
  }
  for (const e of edges) {
    if (!e.condition) continue;
    const src = branchable.get(e.from);
    if (!src) {
      issues.push({
        code: "conditionNotBranchable",
        params: { nodeId: e.from },
      });
    } else if (!(src.branchOptions ?? []).includes(e.condition.value)) {
      issues.push({
        code: "conditionValueOutOfRange",
        params: { value: e.condition.value, nodeId: e.from },
      });
    }
  }
  return issues.length
    ? { ok: false, issues }
    : { ok: true, value: parsed.data };
}

/** 无 start 节点的图自动补齐（AI 技能落库与存量图自愈）：注入
 * { id:"start", kind:"start" } 节点 + start→唯一入口的无条件边。
 * validateGraph 只拦 start 多于一个（不拦缺失——首业务节点可冒充
 * uniqueEntry 入口），AI 生成 graphJson 常省略"无执行语义"的 start，
 * 落库后画布无「开始」卡片、start 段连线缺失。约定输入已过
 * validateGraph；违约形态（入口非唯一）与 id "start" 被非 start 节点
 * 占用（注入会撞 duplicateNodeId）均原样返回不猜测 */
export function ensureStartNode(json: GraphJson): GraphJson {
  if (json.nodes.some((n) => n.kind === "start")) {
    return json;
  }
  if (json.nodes.some((n) => n.id === "start")) {
    return json;
  }
  const noIncoming = json.nodes.filter(
    (n) => !json.edges.some((e) => e.to === n.id),
  );
  if (noIncoming.length !== 1) {
    return json;
  }
  return {
    ...json,
    nodes: [
      { id: "start", name: "开始", kind: "start", variables: [] },
      ...json.nodes,
    ],
    edges: [{ from: "start", to: noIncoming[0].id }, ...json.edges],
  };
}

/** 无出边的业务叶子节点补 to:END（末节点断头自愈）：无出边在
 * LangGraph 中自然终止、与显式 END 等价，补边只补画布观感与终点
 * 声明。branch 节点（condition/intent/branch 模式 llm/code）只有条件
 * 出边时**不补**——无条件 END 边会与路由条件边双触发，破坏分支语义
 * （未命中分支由编译层 __fallback__→END 兜底）。start 空图不补
 * start→END：留给用户连向首个业务节点，预置边反成拆除负担 */
export function ensureEndEdges(json: GraphJson): GraphJson {
  const hasOutgoing = new Set(json.edges.map((e) => e.from));
  const leaves = json.nodes.filter(
    (n) => n.kind !== "start" && !hasOutgoing.has(n.id),
  );
  if (leaves.length === 0) {
    return json;
  }
  return {
    ...json,
    edges: [...json.edges, ...leaves.map((n) => ({ from: n.id, to: "END" }))],
  };
}

/** 图形态归一（AI 技能落库与存量图自愈的统一口）：start 补齐 +
 * 叶子连 END。落库序列化前调用（先过 validateGraph） */
export function normalizeGraph(json: GraphJson): GraphJson {
  return ensureEndEdges(ensureStartNode(json));
}

/**
 * 事件触发配置（spec §5）：appStarted 启动即发；taskFinished 链式——
 * 目标任务/图运行结束按 on 匹配触发。JSON 序列存 automationTask.eventJson，
 * create/update 经此 schema 校验（前后端共享，先例 schedule.schema.ts）。
 */
export const eventJsonSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("appStarted") }),
  z.object({
    source: z.literal("taskFinished"),
    targetType: z.enum(["task", "graph"]),
    targetId: z.number().int().positive(),
    on: z.enum(["success", "failed", "any"]),
  }),
]);
export type EventTriggerConfig = z.infer<typeof eventJsonSchema>;
