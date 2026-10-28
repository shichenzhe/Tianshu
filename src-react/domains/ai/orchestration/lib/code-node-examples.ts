// src-react/domains/ai/orchestration/lib/code-node-examples.ts
/**
 * 代码节点示例脚本（按语言）：体现两条数据通道——模板占位符
 * （{{input.x}}/{{nodes.<id>.output}}，执行前文本替换）与 stdin 注入的
 * 完整上下文 JSON（{inputs, nodes}，适合结构化取值）；stdout 即节点
 * 输出（graph-executor.ts 契约）。脚本内容非 i18n 文案，走代码常量。
 */
import type { CodeNode } from "../api/graph.schema";

export const CODE_NODE_EXAMPLES: Record<CodeNode["language"], string> = {
  bash: `# 方式一：模板占位符（执行前替换为实际值）
echo "主题: {{input.topic}}"
echo "上游摘要: {{nodes.collect.output}}"

# 方式二：stdin 注入完整上下文 JSON
# {"inputs": {"topic": "..."}, "nodes": {"collect": {"output": "..."}}}
data=$(cat)
echo "$data" | python3 -c 'import json,sys; print(json.load(sys.stdin)["inputs"]["topic"])'

# stdout 全部内容即本节点输出：下游经 {{nodes.<本节点id>.output}} 引用；
# 本节点若是终点，stdout 即图运行最终输出`,
  python: `import json
import sys

# stdin 注入完整上下文：{"inputs": {"<变量名>": "..."}, "nodes": {"<节点id>": {"output": "..."}}}
payload = json.load(sys.stdin)
topic = payload["inputs"].get("topic", "")
upstream = payload["nodes"].get("collect", {}).get("output", "")

# 处理逻辑随意（此处为拼接示例）
result = f"主题: {topic}\\n上游摘要: {upstream[:100]}"

# stdout 即本节点输出（供下游 {{nodes.<本节点id>.output}} 引用；终点节点即最终输出）
print(result)`,
  nodejs: `import { readFileSync } from "node:fs";

// stdin 注入完整上下文：{"inputs": {...}, "nodes": {...}}
const payload = JSON.parse(readFileSync(0, "utf-8"));
const topic = payload.inputs.topic ?? "";
const upstream = payload.nodes.collect?.output ?? "";

const result = \`主题: \${topic}\\n上游摘要: \${upstream.slice(0, 100)}\`;

// stdout 即本节点输出（供下游 {{nodes.<本节点id>.output}} 引用；终点节点即最终输出）
console.log(result);`,
};
