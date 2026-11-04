/**
 * dispatch 内置工具（专家团二期 T3）：主理人按 id 调度一名团队
 * 成员独立分析——成员 systemPrompt 为 system、task/context 拼 user prompt，
 * 经 deps.modelText 非流式单轮补全（生产装配 chat.service 的
 * memberModelText，测试注入 stub），产出原文回喂主理人（不落库不外显）。
 * 只发起模型调用、无文件/系统副作用 → kind:"read" 免审批；纯 Node 实现
 * （禁止 import electron），vitest 直测（recommend-expert-tool 先例）。
 * 工具每请求构造（collectToolDefinitions 注入时）：deps 持当次成员清单、
 * 会话中止信号与 modelText 闭包（TeamMember 全链路唯一类型源见
 * chat/expert-team.ts）。
 */
import { z } from "zod";
import type { TeamMember } from "../chat/expert-team";
import type { ToolDefinition } from "./file-tools";

/** 工具名（专家团二期）：主理人 system 门控（buildTeamLeadSystem
 *  withDispatch）与安全中心登记（BUILTIN_TOOLS/disabledTools）共用标识 */
export const DISPATCH_MEMBER_TOOL_NAME = "dispatch";

/** 成员单轮补全注入面（生产 memberModelText / 测试 stub 同构） */
export interface DispatchMemberModelTextArgs {
  system: string;
  prompt: string;
  abortSignal?: AbortSignal;
}

export type DispatchMemberModelTextFn = (
  args: DispatchMemberModelTextArgs,
) => Promise<string>;

/** 工具构造依赖（每请求装配，见文件头注释） */
export interface DispatchMemberDeps {
  members: TeamMember[];
  /** 当次会话中止信号（streamAndPersist 的 abort.signal，用量拆解缺席） */
  abortSignal?: AbortSignal;
  modelText: DispatchMemberModelTextFn;
}

const dispatchMemberSchema = z.object({
  member: z.string().max(64).describe("成员 id，来自系统提示中的团队成员清单"),
  task: z.string().min(1).max(2000).describe("本轮交给该成员的任务描述"),
  context: z
    .string()
    .max(8000)
    .optional()
    .describe("可选的前序阶段成员产出原文（分阶段串行推进时传入）"),
});

export type DispatchMemberArgs = z.infer<typeof dispatchMemberSchema>;

/** 成员任务 prompt：【任务】必选段 + 有 context 时【前序阶段产出】段 */
function buildMemberPrompt(task: string, context?: string): string {
  const sections = [`【任务】\n${task}`];
  if (context) {
    sections.push(`【前序阶段产出】\n${context}`);
  }
  return sections.join("\n\n");
}

export function makeDispatchMemberTool(
  deps: DispatchMemberDeps,
): ToolDefinition<DispatchMemberArgs> {
  return {
    name: DISPATCH_MEMBER_TOOL_NAME,
    description: "调度一名团队成员独立分析并回传结论原文",
    parameters: dispatchMemberSchema,
    kind: "read",
    execute: async (_ctx, args) => {
      // 精确匹配成员 id：查不到直接回文案（附可用 id 清单，不触模型调用）
      const member = deps.members.find((m) => m.id === args.member);
      if (!member) {
        const roster = deps.members.map((m) => m.id).join("、");
        return `错误: 团队中不存在成员「${args.member}」，可用成员：${roster}`;
      }
      try {
        // 产出原文直返：截断/汇总由主理人统筹（协作铁律 #2/#3）
        return await deps.modelText({
          system: member.systemPrompt,
          prompt: buildMemberPrompt(args.task, args.context),
          abortSignal: deps.abortSignal,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return `错误: 成员「${member.name}」执行失败（${message}）`;
      }
    },
  };
}
