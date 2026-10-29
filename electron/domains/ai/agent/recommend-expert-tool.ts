/**
 * recommend_expert 内置工具（WorkBuddy suggest_plugin_install 移植）：
 * 会话未绑定专家时模型依据 system 目录段主动推荐候选，渲染层在消息流
 * 呈现专家推荐卡（ExpertRecommendCard）。无副作用（渲染层消费 args）
 * → kind:"read" 免审批，execute 仅返回确认文本回喂模型。纯 Node 实现
 * （禁止 import electron），vitest 直测（widget-tool 先例）。
 */
import { z } from "zod";
import { MARKET_EXPERTS } from "../../../../src-react/domains/ai/experts/data/marketplace";
import type { ToolDefinition } from "./file-tools";

/** 与前端渲染层（group-blocks.ts，Task 5）双份定义约定（widget 先例） */
export const RECOMMEND_TOOL_NAME = "recommend_expert";

const argsSchema = z.object({
  candidates: z
    .array(z.string())
    .min(1)
    .max(3)
    .describe("市场专家 slug 数组（1-3 个，来自 system 目录段）"),
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
      "渲染专家推荐卡（未绑专家时用；每回复至多一次，勿重复推荐或代用户启用）",
    parameters: argsSchema,
    kind: "read",
    execute: async (_ctx, args) => {
      // 未知 slug 剔除（模型幻觉防护），合法候选照常渲染
      const valid = args.candidates.filter((slug) =>
        MARKET_EXPERTS.some((e) => e.slug === slug),
      );
      if (valid.length === 0) {
        return "错误: 候选 slug 均不在专家目录中，请从 system 提供的目录里选择";
      }
      return `已渲染 ${valid.length} 位专家的推荐卡（用户可点击添加并启用）`;
    },
  };
}
