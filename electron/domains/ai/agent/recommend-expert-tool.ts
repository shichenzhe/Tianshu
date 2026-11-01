/**
 * 专家推荐工具组（WorkBuddy search_plugins/suggest_plugin_install 移植，
 * 2026-11-01 两跳化）：list_experts 无参返回内置专家目录（仅推荐真实发生
 * 时付目录成本），recommend_expert 依据目录渲染推荐卡（渲染层在消息流
 * 呈现 ExpertRecommendCard）。无副作用（渲染层消费 args）→ kind:"read"
 * 免审批，execute 仅返回文本回喂模型。纯 Node 实现（禁止 import
 * electron），vitest 直测（widget-tool 先例）。
 */
import { z } from "zod";
import { MARKET_EXPERTS } from "../../../../src-react/domains/ai/experts/data/marketplace";
import type { ToolDefinition } from "./file-tools";

/** 与前端渲染层（group-blocks.ts）双份定义约定（widget 先例） */
export const RECOMMEND_TOOL_NAME = "recommend_expert";

/** 目录查询工具名（无渲染语义，前端无消费，不进双份约定） */
export const LIST_TOOL_NAME = "list_experts";

/** 推荐工具组名集：注入面收口（chat.service/automation-runner）消费 */
export const EXPERT_RECOMMEND_TOOL_NAMES: ReadonlySet<string> = new Set([
  LIST_TOOL_NAME,
  RECOMMEND_TOOL_NAME,
]);

/** 目录行格式（原 system 目录段沿用）：slug｜名称（头衔）：描述 */
const catalogLines = MARKET_EXPERTS.map(
  (e) => `- ${e.slug}｜${e.name}（${e.subtitle}）：${e.description}`,
).join("\n");

const listArgsSchema = z.object({});

export function makeListExpertsTool(): ToolDefinition<z.infer<typeof listArgsSchema>> {
  return {
    name: LIST_TOOL_NAME,
    description:
      "查看可推荐的内置专家目录（slug、名称与擅长）。当任务明显受益于" +
      "某专业角色（专业判断、深度研究、多角色协作）且当前会话未绑定专家时" +
      "调用；从目录选出 1-3 位候选后用 recommend_expert 渲染推荐卡。" +
      "任务与专家无明显匹配时无需调用。",
    parameters: listArgsSchema,
    kind: "read",
    execute: async () => `【专家目录】\n${catalogLines}`,
  };
}

const argsSchema = z.object({
  candidates: z
    .array(z.string())
    .min(1)
    .max(3)
    .describe("市场专家 slug 数组（1-3 个，来自 list_experts 返回的目录）"),
  reason: z
    .string()
    .min(1)
    .max(120)
    .describe("一句话推荐理由（卡片标题下展示）"),
});

export type RecommendExpertArgs = z.infer<typeof argsSchema>;

export function makeRecommendExpertTool(): ToolDefinition<RecommendExpertArgs> {
  return {
    name: RECOMMEND_TOOL_NAME,
    description:
      "渲染专家推荐卡（candidates 来自 list_experts 目录；已绑定专家时禁止" +
      "推荐；每回复至多一次，勿重复推荐或代用户启用）",
    parameters: argsSchema,
    kind: "read",
    execute: async (_ctx, args) => {
      // 未知 slug 剔除（模型幻觉防护），合法候选照常渲染
      const valid = args.candidates.filter((slug) =>
        MARKET_EXPERTS.some((e) => e.slug === slug),
      );
      if (valid.length === 0) {
        return "错误: 候选 slug 均不在专家目录中，请先调用 list_experts 获取目录后从中选择";
      }
      return `已渲染 ${valid.length} 位专家的推荐卡（用户可点击添加并启用）`;
    },
  };
}
