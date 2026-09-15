/**
 * 自动化任务执行器(spec §4):建 session → 引用解析注入(spec §2,文件/技能
 * 内容前缀 + 技能聚焦 + 变量替换)→ 静默 runChatStream(权限按任务
 * accessMode 分流,无人值守)→ 落 message 与 run(调度字段仅 schedule/
 * catchUp/retry 触发推进,手动测试运行不消耗调度)。不经渲染层(onChunk 不传)，产物在
 * 聊天页可回看。项目任务(子系统 E):会话归属 projectId;项目 systemPrompt
 * (trim 后非空)作为 buildSystemPrompt base 注入。
 */
import { format } from "date-fns";
import prisma from "../../../commons/prisma-client";
import Log from "../../../commons/Log";
import { runChatStream, normalizeWorkspacePath } from "../chat/chat.service";
import { serializeBlocks, type MessageBlock } from "../chat/blocks";
import { createLanguageModel } from "../provider/provider-factory";
import { registry } from "../agent/tool-registry";
import type { SkillInfo } from "../agent/skill-loader";
import { buildSystemPrompt } from "../agent/skill-prompt";
import { makeReadSkillTool } from "../agent/read-skill";
import { classifyError } from "../chat/error-classify";
import { computeNextRun } from "./schedule";
import { resolveAttachments } from "./resolve-attachments";
import type { ScheduleConfig } from "../../../../src-react/domains/ai/automation/api/schedule.schema";

export type AutomationTaskRow = NonNullable<
  Awaited<ReturnType<typeof prisma.automationTask.findFirst>>
>;

const WEEKDAY_ZH = ["一", "二", "三", "四", "五", "六", "日"];

/** 运行时变量替换(中文格式,spec §4;语言不跟随 i18n,固定格式) */
export function replaceVariables(prompt: string, now: Date): string {
  return prompt
    .replaceAll("{{date}}", format(now, "yyyy-MM-dd"))
    .replaceAll(
      "{{weekday}}",
      WEEKDAY_ZH[(now.getDay() === 0 ? 7 : now.getDay()) - 1],
    )
    .replaceAll("{{time}}", format(now, "HH:mm"));
}

/** assistant blocks 的 usage 块 → run 记录 token 数 */
export function extractUsage(
  blocks: MessageBlock[],
): { promptTokens: number; completionTokens: number } | undefined {
  const usage = blocks.find((b) => b.type === "usage");
  return usage && usage.type === "usage"
    ? { promptTokens: usage.input, completionTokens: usage.output }
    : undefined;
}

/** 工具集组装(对齐 chat.service collectToolDefinitions:read_skill 常驻) */
function collectTools(workspacePath: string | undefined, skills: SkillInfo[]) {
  const registered = registry.getDefinitions();
  const injected = workspacePath
    ? registered
    : registered.filter(
        (def) => def.name.startsWith("mcp__") || def.name === "create_skill",
      );
  return [makeReadSkillTool(skills), ...injected];
}

export interface AutomationPermissions {
  fullAccess: () => boolean;
  isToolAllowed: (toolName: string) => Promise<boolean>;
  requestApproval: () => Promise<boolean>;
}

/** 无人值守权限分流:full=完全访问+审批放行(原行为);default=只读执行,
 * 写类审批被拒但任务继续(agent 收到拒绝反馈),与会话 default 语义对齐。
 * isToolAllowed 必须随 full 变 false:chat.service 写门禁对 isToolAllowed=true
 * 的工具直接放行(门禁短路),requestApproval 永不触达 */
export function resolveAutomationPermissions(
  accessMode: "default" | "full",
): AutomationPermissions {
  const full = accessMode === "full";
  return {
    fullAccess: () => full,
    isToolAllowed: async () => full,
    requestApproval: async () => full,
  };
}

export interface ExecuteTaskOptions {
  triggerType: "schedule" | "catchUp" | "retry" | "manual";
  attempt: number;
  abort: AbortSignal;
}

/**
 * 单次执行(所有异常吞掉落库,绝不向调度器抛出)。
 * 返回值仅用于测试断言:最终 run.status。
 */
export async function executeTask(
  task: AutomationTaskRow,
  opts: ExecuteTaskOptions,
): Promise<"success" | "failed"> {
  const now = new Date();
  const startedAt = Date.now();
  const run = await prisma.automationRun.create({
    data: {
      taskId: task.id,
      attempt: opts.attempt,
      triggerType: opts.triggerType,
      status: "running",
      startedAt: now,
    },
  });
  let sessionId: number | undefined;
  try {
    const workspace = await prisma.workspace.findUnique({
      where: { id: task.workspaceId },
    });
    if (!workspace) {
      return await failRun(
        run.id,
        task,
        "workspace_missing",
        startedAt,
        sessionId,
        opts.triggerType,
      );
    }
    const modelRow = await prisma.model.findUnique({
      where: { id: task.modelId },
    });
    const providerRow = modelRow
      ? await prisma.provider.findUnique({
          where: { id: modelRow.providerId },
        })
      : null;
    if (!modelRow || !providerRow) {
      return await failRun(
        run.id,
        task,
        "model_missing",
        startedAt,
        sessionId,
        opts.triggerType,
      );
    }
    /** 项目任务：读项目指令注入 system prompt（子系统 E） */
    const projectRow = task.projectId
      ? await prisma.project.findUnique({
          where: { id: task.projectId },
          select: { systemPrompt: true },
        })
      : null;
    const projectPrompt = projectRow?.systemPrompt?.trim() || undefined;
    sessionId = await createSession(task);
    return await streamAndRecord(task, opts, {
      runId: run.id,
      sessionId,
      startedAt,
      providerType: providerRow.type,
      baseUrl: providerRow.baseUrl,
      apiKey: providerRow.apiKey,
      extraHeaders: providerRow.extraHeaders,
      modelSdkId: modelRow.modelId,
      workspacePath: workspace.directoryPath?.trim()
        ? normalizeWorkspacePath(workspace.directoryPath)
        : undefined,
      workspaceId: workspace.id,
      projectPrompt,
    });
  } catch (e) {
    Log.error("自动化任务执行异常", task.id, e);
    return await failRun(
      run.id,
      task,
      classifyError(e),
      startedAt,
      sessionId,
      opts.triggerType,
    );
  }
}

async function createSession(task: AutomationTaskRow): Promise<number> {
  const session = await prisma.session.create({
    data: {
      workspaceId: task.workspaceId,
      currentModelId: task.modelId,
      title: task.name,
      mode: "agent",
      // 项目任务会话归属项目（子系统 E）；全局任务显式 null
      projectId: task.projectId ?? null,
    },
  });
  return session.id;
}

interface StreamContext {
  runId: number;
  sessionId: number;
  startedAt: number;
  providerType: string;
  baseUrl: string;
  apiKey: string | null;
  extraHeaders: string | null;
  modelSdkId: string;
  workspacePath?: string;
  workspaceId: number;
  /** 项目指令（trim 后非空；子系统 E），作 buildSystemPrompt base */
  projectPrompt?: string;
}

async function streamAndRecord(
  task: AutomationTaskRow,
  opts: ExecuteTaskOptions,
  ctx: StreamContext,
): Promise<"success" | "failed"> {
  // 引用解析(spec §2):失败短路 failRun;成功取注入文本与聚焦技能清单
  const resolution = await resolveAttachments(
    task.prompt,
    ctx.workspacePath,
    new Date(),
  );
  if ("error" in resolution) {
    return await failRun(
      ctx.runId,
      task,
      resolution.error,
      ctx.startedAt,
      ctx.sessionId,
      opts.triggerType,
    );
  }
  const userText = resolution.injected;
  await prisma.message.create({
    data: {
      sessionId: ctx.sessionId,
      role: "user",
      blocks: serializeBlocks([{ type: "text", text: userText }]),
    },
  });
  const skills = resolution.skills;
  const result = await runChatStream({
    model: createLanguageModel(
      {
        type: ctx.providerType,
        baseUrl: ctx.baseUrl,
        apiKey: ctx.apiKey ?? undefined,
        extraHeaders: ctx.extraHeaders,
      },
      ctx.modelSdkId,
    ),
    system: buildSystemPrompt(ctx.projectPrompt, skills),
    history: [
      {
        role: "user",
        blocks: serializeBlocks([{ type: "text", text: userText }]),
      },
    ],
    params: { temperature: task.temperature ?? undefined },
    abortSignal: opts.abort,
    toolDefinitions: collectTools(ctx.workspacePath, skills),
    agent: {
      sessionId: ctx.sessionId,
      workspacePath: ctx.workspacePath,
      // 权限按任务持久化 accessMode 分流(spec §2.3),不再无条件放行
      ...resolveAutomationPermissions(
        task.accessMode === "full" ? "full" : "default",
      ),
    },
  });
  const usage = extractUsage(result.blocks);
  await prisma.message.create({
    data: {
      sessionId: ctx.sessionId,
      role: "assistant",
      blocks: serializeBlocks(result.blocks),
      modelId: task.modelId,
      error: result.errorMessage,
      durationMs: Date.now() - ctx.startedAt,
    },
  });
  const success = !result.errorCode;
  await prisma.automationRun.update({
    where: { id: ctx.runId },
    data: {
      status: success ? "success" : "failed",
      // 终态 run 关联 session(spec §4 步骤7):§5 运行记录点击跳回聊天的依据
      sessionId: ctx.sessionId,
      durationMs: Date.now() - ctx.startedAt,
      promptTokens: usage?.promptTokens,
      completionTokens: usage?.completionTokens,
      error: result.errorMessage
        ? `${result.errorCode}: ${result.errorMessage}`.slice(0, 500)
        : null,
      finishedAt: new Date(),
    },
  });
  await advanceTask(
    task,
    new Date(),
    success ? "success" : "failed",
    opts.triggerType,
  );
  return success ? "success" : "failed";
}

/** 失败收尾:run failed + 可选 task 标异常(系统错误码) */
async function failRun(
  runId: number,
  task: AutomationTaskRow,
  errorCode: string,
  startedAt: number,
  sessionId: number | undefined,
  triggerType: ExecuteTaskOptions["triggerType"],
): Promise<"failed"> {
  await prisma.automationRun.update({
    where: { id: runId },
    data: {
      status: "failed",
      error: errorCode,
      durationMs: Date.now() - startedAt,
      sessionId: sessionId ?? null,
      finishedAt: new Date(),
    },
  });
  if (errorCode === "workspace_missing" || errorCode === "model_missing") {
    await prisma.automationTask.update({
      where: { id: task.id },
      data: { status: "error", enabled: false, statusNote: errorCode },
    });
  } else {
    // 非系统失败:once 不置 expired(留 status=active 待重试扫描,见 advanceTask 注释)
    await advanceTask(task, new Date(), "failed", triggerType);
  }
  return "failed";
}

/**
 * lastRunAt=now;nextRunAt=computeNextRun 推进。
 * 手动测试运行(triggerType=manual)不消耗调度:直接返回,once 不因此
 * expired、nextRunAt/lastRunAt 均不动——lastRunAt 若被推进,决策树
 * lastRunAt>=nextRunAt 会把未到触发点的 once 任务提前回收。
 * once 的 expired 只在成功路径置位:非系统失败需先走 §7 重试扫描
 * (nextRunAt=null 但 status 保持 active,重试耗尽后由调度器决策树收尾,
 * 不得首次失败即 expired——否则被 tick 的 active 过滤出局,零重试)
 */
async function advanceTask(
  task: AutomationTaskRow,
  now: Date,
  outcome: "success" | "failed",
  triggerType: ExecuteTaskOptions["triggerType"],
): Promise<void> {
  if (triggerType === "manual") {
    return;
  }
  const schedule = JSON.parse(task.scheduleJson) as ScheduleConfig;
  const next = computeNextRun(schedule, now, now);
  await prisma.automationTask.update({
    where: { id: task.id },
    data: {
      lastRunAt: now,
      nextRunAt: next,
      ...(schedule.mode === "periodic" &&
        schedule.kind === "once" &&
        outcome === "success" && { status: "expired" }),
    },
  });
}
