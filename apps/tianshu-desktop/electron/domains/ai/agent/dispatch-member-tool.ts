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
 *
 * 专家团可观测性批（2026-11-05，experts §6 P1×2）：
 * - onMemberCall 埋点：成员补全的 token 消耗此前绕过 recordLlmCall 对
 *   用户不可见——现每次成功补全经 makeMemberCallRecorder 落 llmCallEvent
 *   （meta 携带成员名/轮次）；dispatch 工具调用本身走 runToolCall 通用
 *   toolStats 路径进 toolCallEvent（无需本文件处理）。
 * - withMemberReportBlocks：成员产出以 memberReport 块落进当轮 assistant
 *   消息 blocks（不落库不外显 → 事后可审计，渲染折叠卡）。
 */
import { z } from "zod";
import type { MessageBlock } from "@tianshu/protocol";
import { recordLlmCall, type LlmCallPrismaLike } from "@tianshu/core";
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
  /** 用量回报（可观测性批）：实现侧从响应 usage_metadata 提取后回调；
   *  缺席（测试 stub/provider 无元数据）不报——埋点可缺不可谎 */
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
}

export type DispatchMemberModelTextFn = (
  args: DispatchMemberModelTextArgs,
) => Promise<string>;

/** 成员调用埋点事件（onMemberCall 载荷） */
export interface DispatchMemberCallEvent {
  memberId: string;
  memberName: string;
  /** 当次请求内第几次成员调度（1 起，工具实例内计数） */
  round: number;
  durationMs: number;
  /** 补全用量（modelText onUsage 回报在场时携带） */
  inputTokens?: number;
  outputTokens?: number;
}

/** 工具构造依赖（每请求装配，见文件头注释） */
export interface DispatchMemberDeps {
  members: TeamMember[];
  /** 当次会话中止信号（streamAndPersist 的 abort.signal，用量拆解缺席） */
  abortSignal?: AbortSignal;
  modelText: DispatchMemberModelTextFn;
  /** 成员调用埋点（可观测性批）：成功补全后上报；缺席不埋（测试） */
  onMemberCall?: (event: DispatchMemberCallEvent) => void;
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

/**
 * 成员调用埋点 recorder（可观测性批）：llmCallEvent meta 行构造——
 * usage 在场才记（provider 未回 usage_metadata 的补全不造假 0 token；
 * 调用次数面已由 dispatch 的 toolCallEvent 覆盖）；recordLlmCall 自吞错
 * （fire-and-forget，失败不影响调度主流程）
 */
export function makeMemberCallRecorder(input: {
  prisma: LlmCallPrismaLike;
  userId: number | null;
  sessionId: number;
  modelId: number;
}): (event: DispatchMemberCallEvent) => void {
  return (event) => {
    if (event.inputTokens == null || event.outputTokens == null) {
      return;
    }
    void recordLlmCall(input.prisma, {
      userId: input.userId,
      scene: "chat",
      modelId: input.modelId,
      sessionId: input.sessionId,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      durationMs: event.durationMs,
      meta: JSON.stringify({
        kind: "member",
        member: event.memberName,
        round: event.round,
      }),
    });
  };
}

/**
 * 成员产出落块（可观测性批）：done 态 dispatch 工具块逐个在其后插入
 * memberReport 块（成员名经 members id 映射，缺席回退 id 原文；轮次按
 * 块序 1 起）。error/无输出的 dispatch 块与非 dispatch 块原样保留；
 * 纯函数（新数组，入参不动），供 chat.service 落库前调用
 */
export function withMemberReportBlocks(
  blocks: MessageBlock[],
  members: TeamMember[],
): MessageBlock[] {
  const out: MessageBlock[] = [];
  let round = 0;
  for (const block of blocks) {
    out.push(block);
    if (
      block.type !== "tool_call" ||
      block.toolName !== DISPATCH_MEMBER_TOOL_NAME ||
      block.state !== "done" ||
      typeof block.output !== "string"
    ) {
      continue;
    }
    round += 1;
    const args = (block.args ?? {}) as { member?: unknown; task?: unknown };
    const memberId = typeof args.member === "string" ? args.member : "";
    out.push({
      type: "memberReport",
      memberName:
        members.find((m) => m.id === memberId)?.name ?? memberId,
      task: typeof args.task === "string" ? args.task : "",
      content: block.output,
      round,
    });
  }
  return out;
}

export function makeDispatchMemberTool(
  deps: DispatchMemberDeps,
): ToolDefinition<DispatchMemberArgs> {
  // 轮次计数（当次请求内）：工具每请求构造，实例闭包即请求级状态
  let memberCallRound = 0;
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
      const startedAt = Date.now();
      let usage: { inputTokens: number; outputTokens: number } | undefined;
      try {
        // 产出原文直返：截断/汇总由主理人统筹（协作铁律 #2/#3）
        const output = await deps.modelText({
          system: member.systemPrompt,
          prompt: buildMemberPrompt(args.task, args.context),
          abortSignal: deps.abortSignal,
          onUsage: (u) => {
            usage = u;
          },
        });
        deps.onMemberCall?.({
          memberId: member.id,
          memberName: member.name,
          round: (memberCallRound += 1),
          durationMs: Date.now() - startedAt,
          ...(usage ?? {}),
        });
        return output;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return `错误: 成员「${member.name}」执行失败（${message}）`;
      }
    },
  };
}
