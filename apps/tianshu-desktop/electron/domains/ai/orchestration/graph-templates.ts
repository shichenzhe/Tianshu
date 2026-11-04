/**
 * 内置图模板（spec §7）：条件分支日报（condition 节点演示）+ 串行调研
 * 成文。title/desc 只放 i18n key（文案在 i18n 任务的 chat.json 定义，先例
 * automation-templates.ts）；icon 为 lucide 图标名，前端映射组件。
 * graphJson 的 modelId 为 0 占位——用户从前端换模型后保存（create 期
 * validateGraph 校验正整数），后端不校验模型归属。每模板首节点为 start
 * （id 固定 "start"），variables 与该模板 inputSchema 键一致（start 即
 * 图入口，直连原首执行节点）。
 */
export interface GraphTemplate {
  slug: string;
  icon: string;
  titleI18nKey: string;
  descI18nKey: string;
  graphJson: object;
}

export function listGraphTemplates(): GraphTemplate[] {
  return [
    {
      slug: "daily-brief-branch",
      icon: "workflow",
      titleI18nKey: "chat:orchestration.templates.dailyBriefTitle",
      descI18nKey: "chat:orchestration.templates.dailyBriefDesc",
      graphJson: {
        version: 1,
        inputSchema: {},
        nodes: [
          { id: "start", name: "开始", kind: "start", variables: [] },
          {
            id: "collect",
            name: "collect",
            kind: "llm",
            modelId: 0,
            systemPrompt: "你是高效的日程分析助手，输出简洁、只讲事实。",
            prompt: [
              "汇总 {{date}}（周{{weekday}}）的待办要点，要求：",
              "1) 列出当天最重要的 3-5 件事；",
              "2) 每件事标注状态：进行中 / 待办 / 有风险；",
              "3) 有时间冲突或依赖阻塞时单独提示。",
              "输出要点清单，不要展开成文。",
            ].join("\n"),
            tools: true,
            outputMode: "text",
          },
          {
            id: "judge",
            name: "judge",
            kind: "condition",
            // 结构化条件分支（Coze Choice 式）：上游清单含「有风险」走
            // brief 生成日报，否则兜底 skip 直接结束——确定性路由不经
            // 模型判断（对比旧 llm branch 模式的语义标签输出）
            branches: [
              {
                name: "brief",
                conditions: [
                  {
                    source: "{{nodes.collect.output}}",
                    operator: "contains",
                    value: "有风险",
                  },
                ],
              },
            ],
            fallback: "skip",
          },
          {
            id: "brief",
            name: "brief",
            kind: "llm",
            modelId: 0,
            systemPrompt: "你是简报撰写助手，用中文写短小精悍的日报。",
            prompt: [
              "基于以下要点清单写一份日报：",
              "{{nodes.collect.output}}",
              "",
              "格式：标题（含日期）+ 今日要点 + 明日关注，全文不超过 200 字。",
            ].join("\n"),
            tools: false,
            outputMode: "text",
          },
        ],
        edges: [
          { from: "start", to: "collect" },
          { from: "collect", to: "judge" },
          {
            from: "judge",
            to: "brief",
            condition: { type: "branch", value: "brief" },
          },
          {
            from: "judge",
            to: "END",
            condition: { type: "branch", value: "skip" },
          },
          { from: "brief", to: "END" },
        ],
      },
    },
    {
      slug: "research-report",
      icon: "file-search",
      titleI18nKey: "chat:orchestration.templates.researchTitle",
      descI18nKey: "chat:orchestration.templates.researchDesc",
      graphJson: {
        version: 1,
        inputSchema: { topic: "string" },
        nodes: [
          {
            id: "start",
            name: "开始",
            kind: "start",
            variables: ["topic"],
          },
          {
            id: "research",
            name: "research",
            kind: "llm",
            modelId: 0,
            systemPrompt:
              "你是严谨的调研助手：先检索再下结论，标注信息来源，不编造。",
            prompt: [
              "围绕主题「{{input.topic}}」做简要调研：",
              "1) 一句话定义核心概念；",
              "2) 现状与关键数据（近一年优先）；",
              "3) 主要分歧或争议点；",
              "以要点形式输出，每条注明来源。",
            ].join("\n"),
            tools: true,
            outputMode: "text",
          },
          {
            id: "report",
            name: "report",
            kind: "llm",
            modelId: 0,
            systemPrompt: "你是技术写作助手，报告结构清晰、客观中立。",
            prompt: [
              "基于以下调研要点写一份结构化报告：",
              "{{nodes.research.output}}",
              "",
              "包含三节：概述 / 关键发现 / 结论与建议，总长 300-500 字。",
            ].join("\n"),
            tools: false,
            outputMode: "text",
          },
        ],
        edges: [
          { from: "start", to: "research" },
          { from: "research", to: "report" },
          { from: "report", to: "END" },
        ],
      },
    },
    {
      slug: "intent-router",
      icon: "compass",
      titleI18nKey: "chat:orchestration.templates.intentRouterTitle",
      descI18nKey: "chat:orchestration.templates.intentRouterDesc",
      graphJson: {
        version: 1,
        inputSchema: { message: "string" },
        nodes: [
          {
            id: "start",
            name: "开始",
            kind: "start",
            variables: ["message"],
          },
          {
            id: "classify",
            name: "classify",
            kind: "intent",
            modelId: 0,
            // 意图识别（Coze Intent 式）：零 prompt 门槛的结构化语义路由，
            // 描述帮助模型分类；未命中走 other 兜底直接结束
            querySource: "{{input.message}}",
            intents: [
              {
                name: "pre",
                description: "售前咨询：产品价格、功能对比、试用开通",
              },
              {
                name: "after",
                description: "售后支持：故障报修、退款退货、工单进度",
              },
            ],
            fallback: "other",
          },
          {
            id: "pre-reply",
            name: "pre-reply",
            kind: "llm",
            modelId: 0,
            systemPrompt: "你是友好的售前顾问，回复简洁、主动引导预约演示。",
            prompt: "回复以下售前咨询：\n{{input.message}}",
            tools: false,
            outputMode: "text",
          },
          {
            id: "after-reply",
            name: "after-reply",
            kind: "llm",
            modelId: 0,
            systemPrompt:
              "你是耐心的售后支持工程师，先给排查步骤，再承诺跟进。",
            prompt: "处理以下售后问题：\n{{input.message}}",
            tools: false,
            outputMode: "text",
          },
        ],
        edges: [
          { from: "start", to: "classify" },
          {
            from: "classify",
            to: "pre-reply",
            condition: { type: "branch", value: "pre" },
          },
          {
            from: "classify",
            to: "after-reply",
            condition: { type: "branch", value: "after" },
          },
          {
            from: "classify",
            to: "END",
            condition: { type: "branch", value: "other" },
          },
          { from: "pre-reply", to: "END" },
          { from: "after-reply", to: "END" },
        ],
      },
    },
    {
      // 大表抽取配套子图：分片读一页 → 输出累计 offset（0 行输出 DONE
      // 供父图 while 终止）。须先保存本图，再在大表抽取主图中选中它
      slug: "db-page-child",
      icon: "database",
      titleI18nKey: "chat:orchestration.templates.dbPageChildTitle",
      descI18nKey: "chat:orchestration.templates.dbPageChildDesc",
      graphJson: {
        version: 1,
        inputSchema: { acc: "string" },
        nodes: [
          {
            id: "start",
            name: "开始",
            kind: "start",
            variables: ["acc"],
          },
          {
            id: "fetch",
            name: "fetch",
            kind: "database",
            // 引擎/连接按实际环境改；LIMIT=页大小，OFFSET=父图注入的累计
            engine: "sqlite",
            sqlitePath: "app.db",
            sql: "SELECT id, name, updated_at FROM records ORDER BY id LIMIT 1000 OFFSET {{input.acc}}",
            params: [],
            maxRows: 1001,
          },
          {
            id: "step",
            name: "step",
            kind: "code",
            language: "nodejs",
            // 上游输出在 stdin 的 nodes.<id>.output；输出新累计 offset，
            // 空页（0 行）输出 DONE——父图 while 据此终止
            script: [
              'import { readFileSync } from "node:fs";',
              'const payload = JSON.parse(readFileSync(0, "utf-8"));',
              'const acc = Number(payload.inputs.acc || "0");',
              'const rows = JSON.parse(payload.nodes.fetch?.output || "[]");',
              'console.log(rows.length === 0 ? "DONE" : String(acc + rows.length));',
            ].join("\n"),
            timeoutMs: 30_000,
          },
        ],
        edges: [
          { from: "start", to: "fetch" },
          { from: "fetch", to: "step" },
          { from: "step", to: "END" },
        ],
      },
    },
    {
      // 大表抽取主图：while + 承接变量逐分片驱动上面的子图（graphId 占位
      // 0，保存前先在子图模板建好并保存子图，再回到本图选中它）
      slug: "db-page-extract",
      icon: "database",
      titleI18nKey: "chat:orchestration.templates.dbPageExtractTitle",
      descI18nKey: "chat:orchestration.templates.dbPageExtractDesc",
      graphJson: {
        version: 1,
        inputSchema: {},
        nodes: [
          { id: "start", name: "开始", kind: "start", variables: [] },
          {
            id: "loop",
            name: "loop",
            kind: "iterate",
            loopMode: "while",
            itemsSource: "",
            graphId: 0,
            // 承接变量 acc=上一轮子图输出（累计 offset），首轮 0
            carryVariable: "acc",
            carryInitial: "0",
            maxItems: 100,
            breakCondition: {
              source: "{{nodes.loop.output}}",
              operator: "contains",
              value: "DONE",
            },
          },
          {
            id: "clean",
            name: "clean",
            kind: "llm",
            modelId: 0,
            systemPrompt:
              "你是数据清洗助手，只输出清洗后的 JSON 行数组，不输出其他内容。",
            prompt: [
              "子工作流运行历史中的各分片为原始数据。请总结本轮抽取：",
              "{{nodes.loop.output}}",
              "",
              "如需逐片清洗，请把清洗节点加入分片子图（fetch 与 step 之间）。",
            ].join("\n"),
            tools: false,
            outputMode: "text",
          },
        ],
        edges: [
          { from: "start", to: "loop" },
          { from: "loop", to: "clean" },
          { from: "clean", to: "END" },
        ],
      },
    },
    {
      // ETL 报告：csvRead → aggregate 统计 → email 发送（CSV/聚合/邮件
      // 三节点的组合样板；改 path/邮箱/字段即用）
      slug: "csv-report",
      icon: "table",
      titleI18nKey: "chat:orchestration.templates.csvReportTitle",
      descI18nKey: "chat:orchestration.templates.csvReportDesc",
      graphJson: {
        version: 1,
        inputSchema: { month: "string" },
        nodes: [
          {
            id: "start",
            name: "开始",
            kind: "start",
            variables: ["month"],
          },
          {
            id: "load",
            name: "load",
            kind: "csvRead",
            // 订单 CSV：首行表头（如 date,amount,category）
            path: "data/orders.csv",
            delimiter: "comma",
            maxRows: 1000,
          },
          {
            id: "stats",
            name: "stats",
            kind: "aggregate",
            source: "{{nodes.load.output}}",
            ops: [
              { type: "count" },
              { type: "sum", field: "amount" },
              { type: "groupByCount", field: "category" },
            ],
          },
          {
            id: "report",
            name: "report",
            kind: "email",
            // SMTP 与收件人按实际环境改；密码建议用 {{input.smtpPass}} 占位
            host: "smtp.example.com",
            port: 465,
            secure: true,
            username: "bot@example.com",
            password: "{{input.smtpPass}}",
            from: "bot@example.com",
            to: "boss@example.com",
            subject: "{{input.month}} 月销售报告",
            body: [
              "{{input.month}} 月订单统计：",
              "",
              "{{nodes.stats.output}}",
              "",
              "数据来源：data/orders.csv",
            ].join("\n"),
          },
        ],
        edges: [
          { from: "start", to: "load" },
          { from: "load", to: "stats" },
          { from: "stats", to: "report" },
          { from: "report", to: "END" },
        ],
      },
    },
    {
      slug: "code-pipeline",
      icon: "terminal",
      titleI18nKey: "chat:orchestration.templates.codePipelineTitle",
      descI18nKey: "chat:orchestration.templates.codePipelineDesc",
      graphJson: {
        version: 1,
        inputSchema: { word: "string" },
        nodes: [
          {
            id: "start",
            name: "开始",
            kind: "start",
            variables: ["word"],
          },
          {
            id: "step1-bash",
            name: "step1-bash",
            kind: "code",
            language: "bash",
            // 起始节点示范：模板占位符取图输入变量（tr 兼容 macOS bash 3.2）
            script: [
              "# 起始节点：从图输入变量取值（模板占位符执行前已替换）",
              'word="{{input.word}}"',
              '# 也可从 stdin 读完整上下文：data=$(cat) → {"inputs":{...},"nodes":{...}}',
              "# 加工：转大写并打标记（stdout 即本节点输出）",
              "echo \"BASH:$(printf '%s' \"$word\" | tr '[:lower:]' '[:upper:]')\"",
            ].join("\n"),
            timeoutMs: 30_000,
          },
          {
            id: "step2-python",
            name: "step2-python",
            kind: "code",
            language: "python",
            // 中间节点示范：stdin JSON 取上游节点输出（nodes.<id>.output）
            script: [
              "import json",
              "import sys",
              "",
              "# 上游节点输出在 stdin 的 nodes.<节点id>.output（仅含已执行节点）",
              "payload = json.load(sys.stdin)",
              'upstream = payload["nodes"].get("step1-bash", {}).get("output", "")',
              "",
              "# 加工：追加标记与长度（stdout 即本节点输出）",
              'print(f"PYTHON[{upstream}] len={len(upstream)}")',
            ].join("\n"),
            timeoutMs: 30_000,
          },
          {
            id: "step3-node",
            name: "step3-node",
            kind: "code",
            language: "nodejs",
            // 终点节点示范：stdout 即图运行最终输出
            script: [
              'import { readFileSync } from "node:fs";',
              "",
              "// 上游节点输出在 stdin 的 nodes.<节点id>.output",
              'const payload = JSON.parse(readFileSync(0, "utf-8"));',
              'const upstream = payload.nodes["step2-python"]?.output ?? "";',
              "",
              "// 终点节点：stdout 即图运行最终输出",
              'console.log("NODE(" + upstream + ") done");',
            ].join("\n"),
            timeoutMs: 30_000,
          },
        ],
        edges: [
          { from: "start", to: "step1-bash" },
          { from: "step1-bash", to: "step2-python" },
          { from: "step2-python", to: "step3-node" },
          { from: "step3-node", to: "END" },
        ],
      },
    },
  ];
}
