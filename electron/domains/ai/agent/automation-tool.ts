/**
 * create_automation_task 内置工具：AI 在对话中创建定时自动化任务，落库后
 * 与「自动化」页手动创建的任务同权（同一 createTask 链路，含归属校验与
 * userId 隔离）。kind:"write" → 走统一审批（runToolCall 挂起，批准后才
 * execute，与 create_expert 同口径——创建的是未来无人值守自动执行的实体）。
 * workspaceId/modelId 不入模型参数（防幻觉填参）：从工具 ctx 透传当前会话
 * 绑定的工作空间与会话当前模型（executeToolSafe 装配）。graphId 直连
 * 工作流型任务（UI「自动化」页同款 targetKind=graph）：模型无须包装
 * prompt 每轮起会话调 run_workflow，到点直接执行图；graphId 归属经
 * graphFirst 校验（防幻觉引用他人图）。纯 Node 实现（禁止 import
 * electron），落库经 deps 注入可测（create-expert 先例）；错误一律转
 * 「错误: ...」字符串回喂模型，不抛出。
 */
import { z } from "zod";
import {
  INTERVAL_MIN_MINUTES,
  intervalMinutes,
  scheduleSchema,
} from "../../../../src-react/domains/ai/automation/api/schedule.schema";
import type { TaskCreateParams } from "../../../../src-react/domains/ai/automation/api/automation.api";
import type { ToolContext, ToolDefinition } from "./file-tools";

export const AUTOMATION_TOOL_NAME = "create_automation_task";

const argsSchema = z
  .object({
    name: z.string().trim().min(1).max(50).describe("任务名称（50 字内）"),
    prompt: z
      .string()
      .min(1)
      .max(20000)
      .optional()
      .describe(
        "到点执行的完整指令（须自包含，不依赖对话上下文）；与 graphId 二选一",
      ),
    graphId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "直连工作流 id（与 prompt 二选一，缺省为 prompt 型）；须为已存在图（list_workflows 查询）",
      ),
    schedule: scheduleSchema.describe(
      "触发计划七形态：once{runAt}/daily{time}/weekly{weekdays,time}/biweekly{anchorDate,weekday,time}/monthly{dayOfMonth,time}/yearly{month,day,time}/interval{value,unit}（星期 ISO 1=一…7=日；时间 HH:mm）",
    ),
    scheduleText: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .describe("触发计划的可读一句话（如「每天 09:00」）"),
    missedPolicy: z
      .enum(["skip", "catchUpOnce"])
      .optional()
      .describe("错过触发处理：skip=跳过（缺省）；catchUpOnce=启动后补跑一次"),
    startAt: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe("生效起点（ISO 8601 带时区），缺省立即"),
    endAt: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe("生效终点（ISO 8601 带时区），缺省不结束"),
  })
  // 执行体二选一：graphId 直连工作流（prompt 落空串）或 prompt 指令
  .superRefine((v, ctx) => {
    if (v.graphId !== undefined && v.prompt !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "graphId 与 prompt 二选一（直连工作流则无须 prompt）",
      });
    }
    if (v.graphId === undefined && !v.prompt) {
      ctx.addIssue({
        code: "custom",
        message: "prompt 必填（或提供 graphId 直连工作流）",
      });
    }
  });

export type AutomationTaskArgs = z.infer<typeof argsSchema>;

export type AutomationCheck =
  { ok: true; data: AutomationTaskArgs } | { ok: false; reason: string };

/** 校验链：zod 结构 → 间隔下限（表单防呆同口径，后端无此防线）→
 *  once 不允许过去时间（同 validateSchedule 语义） */
export function validateAutomationTaskArgs(
  args: unknown,
  now: Date = new Date(),
): AutomationCheck {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `参数不合法: ${parsed.error.issues[0]?.message ?? "结构错误"}`,
    };
  }
  const { schedule } = parsed.data;
  if (
    schedule.mode === "interval" &&
    intervalMinutes(schedule) < INTERVAL_MIN_MINUTES
  ) {
    return {
      ok: false,
      reason: `参数不合法: 间隔不得低于 ${INTERVAL_MIN_MINUTES} 分钟`,
    };
  }
  if (schedule.mode === "periodic" && schedule.kind === "once") {
    if (new Date(schedule.runAt).getTime() <= now.getTime()) {
      return { ok: false, reason: "参数不合法: 单次触发时间不能在过去" };
    }
  }
  return { ok: true, data: parsed.data };
}

/** 工具失败的统一文案（回喂模型，不抛出；与 file-tools 同口径） */
function fail(message: string): string {
  return `错误: ${message}`;
}

/** createTask 返回的消费子集（AutomationRepository.createTask 返回 TaskRecord 满足；
 *  nextRunAt 可选：无下次触发时缺席）。graphFirst：graphId 归属校验
 *  （graphDefinition.findFirst 形状，防幻觉引用他人图） */
export interface AutomationCreateDeps {
  createTask(
    p: TaskCreateParams,
    userId: number,
  ): Promise<{ id: number; nextRunAt?: string | null }>;
  graphFirst(args: {
    where: { id: number; userId: number };
  }): Promise<{ id: number } | null>;
  /** 落库成功后通知（repo 注 emitAutomationChanged 广播渲染层失效——
   *  对话创建无前端调用方 invalidate，全局 staleTime 30s 内列表页
   *  不见新任务；纯 Node 禁 electron 故经注入） */
  notify?: (taskId: number) => void;
}

export function makeAutomationTool(
  deps: AutomationCreateDeps,
): ToolDefinition<AutomationTaskArgs> {
  return {
    name: AUTOMATION_TOOL_NAME,
    description:
      "创建定时任务（prompt 到点指令或 graphId 直连工作流，二选一）；写操作需批准",
    parameters: argsSchema,
    kind: "write",
    execute: async (ctx: ToolContext, args) => {
      const check = validateAutomationTaskArgs(args);
      if (!check.ok) return fail(check.reason);
      const { userId, workspaceId, modelId } = ctx;
      if (userId === undefined) {
        return fail("会话缺少用户归属，无法落库");
      }
      if (workspaceId === undefined) {
        return fail(
          "当前会话未绑定工作空间，无法创建定时任务；请先在会话中绑定工作空间目录",
        );
      }
      const graphId = check.data.graphId;
      const isGraph = graphId !== undefined;
      // graph 型模型在各节点（任务 modelId 落 0）：无会话模型也能建
      if (!isGraph && modelId === undefined) {
        return fail("当前会话未选择模型，请先选择模型再创建定时任务");
      }
      if (graphId !== undefined) {
        const graph = await deps.graphFirst({
          where: { id: graphId, userId },
        });
        if (!graph) {
          return fail("工作流不存在（可先用 list_workflows 核对 id）");
        }
      }
      const record = await deps.createTask(
        {
          name: check.data.name,
          prompt: isGraph ? "" : (check.data.prompt as string),
          workspaceId,
          modelId: isGraph ? 0 : (modelId as number),
          targetKind: isGraph ? "graph" : "prompt",
          // graph 型直连：graphId 透传（prompt 型恒 null）
          ...(isGraph ? { graphId } : {}),
          schedule: check.data.schedule,
          scheduleText: check.data.scheduleText,
          missedPolicy: check.data.missedPolicy ?? "skip",
          // 完全访问不开给对话参数（对齐 UI「保存后进详情页开启」的
          // 谨慎口径），回执引导受限模式的解除路径
          accessMode: "default",
          startAt: check.data.startAt,
          endAt: check.data.endAt,
        },
        userId,
      );
      deps.notify?.(record.id);
      const next = record.nextRunAt ? `，下次触发 ${record.nextRunAt}` : "";
      const guide = isGraph
        ? "。任务为受限模式：图含代码/文件写入节点时，请在任务详情开启「允许完全访问」，或在设置-安全中心命令名单放行解释器（bash/python3/node）"
        : "";
      return `已创建定时任务「${check.data.name}」（id ${record.id}${next}），可在「自动化」页查看与管理${guide}`;
    },
  };
}
