/**
 * confirm_form 内置工具（工作流执行前的人确认卡，切片 B 2026-10-29）：
 * 模型调写类工作流前先出卡——目标工作流名 + 参数可编辑表单 + 确认/取消，
 * 渲染层 ConfirmFormCard 呈现。确认后以最终参数直接执行 run_workflow
 * 【免双重审批】：本工具 kind=read 不触发审批门，确认后经
 * registry.find("run_workflow").execute 直调执行体——runToolCall 的 write
 * 审批门在工具调用层，直调 def.execute 不经门（安全边界：确认卡本身即
 * 人工门——用户亲见并可编辑全部参数后确认；模型直呼 run_workflow 仍走
 * 原审批横幅不受影响）。取消则不执行，回执告知模型勿重试。
 * execute 阻塞等待渲染层决议（confirm-registry，ApprovalCoordinator 同构
 * ——write 审批挂起同款语义）。纯 Node（禁 import electron），vitest 直测。
 */
import { z } from "zod";
import { registry } from "./tool-registry";
import type { ToolContext, ToolDefinition } from "./file-tools";
import { confirmForms } from "./confirm-registry";
import {
  userIdOf,
  type SessionPrismaLike,
  type WorkflowGraphPrismaLike,
} from "../orchestration/create-workflow";

export { CONFIRM_FORM_TOOL_NAME } from "../../../../src-react/domains/ai/chat/lib/group-blocks";

const confirmFormArgsSchema = z.object({
  /** 目标工作流 id（run_workflow 同参） */
  workflowId: z.number().int().positive(),
  /** 工作流名（卡片展示；缺省以库中实际名为准） */
  workflowName: z.string().max(120).optional(),
  /** 卡片标题（缺省用渲染层默认标题） */
  title: z.string().max(120).optional(),
  /** 参数表单：key=工作流 inputSchema 键，value=预填值（用户可改） */
  fields: z
    .array(
      z.object({
        key: z.string().min(1).max(64),
        label: z.string().min(1).max(60),
        value: z.string().max(2000),
        hint: z.string().max(120).optional(),
      }),
    )
    .min(1)
    .max(12),
});

export type ConfirmFormToolArgs = z.infer<typeof confirmFormArgsSchema>;

/** run_workflow 执行体注入（默认经 registry 直调；测试注 stub 隔离
 *  tool-registry 的 electron 依赖链） */
export type RunWorkflowExecutor = (
  ctx: ToolContext,
  args: { id: number; inputs?: Record<string, string> },
) => Promise<string>;

export function makeConfirmFormTool(deps: {
  graphDefinition: WorkflowGraphPrismaLike;
  session: SessionPrismaLike;
  /** run_workflow 执行体（缺省经 registry 惰性直调——注册时序上
   *  run_workflow 已由 GraphRepository 先注册；测试注 stub 隔离
   *  tool-registry 的 electron 依赖链） */
  runWorkflow?: RunWorkflowExecutor;
}): ToolDefinition<ConfirmFormToolArgs> {
  const runWorkflow: RunWorkflowExecutor =
    deps.runWorkflow ??
    ((ctx, args) => {
      const def = registry.find("run_workflow");
      if (!def) {
        return Promise.resolve(
          "错误: run_workflow 工具未注册（无法执行确认后的工作流）",
        );
      }
      return def.execute(ctx, args);
    });
  return {
    name: "confirm_form",
    description:
      "执行写类工作流前先出确认卡：用户核对并可编辑参数，确认后以最终参数立即执行该工作流（不再弹审批）；取消则不执行。调用 run_workflow 前优先用本工具取得用户确认",
    parameters: confirmFormArgsSchema,
    kind: "read",
    execute: async (ctx, args) => {
      if (ctx.sessionId === null) {
        return "错误: 无会话上下文，无法呈现确认卡（图执行/无人值守场景不适用本工具）";
      }
      const userId = await userIdOf(ctx, deps.session);
      if (userId === null) {
        return "错误: 会话不存在，无法确定当前用户";
      }
      const workflow = await deps.graphDefinition.findFirst({
        where: { id: args.workflowId, userId },
      });
      if (!workflow) {
        return "错误: 工作流不存在（可先用 list_workflows 核对 id）";
      }
      const decision = await confirmForms.request(ctx.sessionId, {
        workflowId: args.workflowId,
        workflowName: args.workflowName ?? workflow.name,
        title: args.title,
        fields: args.fields,
      });
      if (decision.action === "cancel") {
        return "用户已取消本次工作流执行（未运行）。请勿直接重试，先向用户确认下一步。";
      }
      // 表单值按声明键收口（未声明键丢弃，防夹带 inputSchema 外的输入）
      const inputs = Object.fromEntries(
        args.fields.map((field) => [
          field.key,
          decision.values[field.key] ?? field.value,
        ]),
      );
      const receipt = await runWorkflow(ctx, {
        id: args.workflowId,
        inputs,
      });
      return `用户已在确认卡上确认，工作流已按最终参数执行。回执：\n${receipt}`;
    },
  };
}
