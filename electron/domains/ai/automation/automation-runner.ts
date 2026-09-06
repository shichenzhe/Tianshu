/**
 * 自动化任务执行器(spec §4):建 session → 变量替换 → 静默
 * runChatStream(完全访问 + 审批自动放行,无人值守)→ 落 message 与 run。
 * 不经渲染层(onChunk 不传),产物在聊天页可回看。
 */
import { format } from "date-fns";
import path from "node:path";
import { app } from "electron";
import prisma from "../../../commons/prisma-client";
import Log from "../../../commons/Log";
import { runChatStream, normalizeWorkspacePath } from "../chat/chat.service";
import { serializeBlocks, type MessageBlock } from "../chat/blocks";
import { createLanguageModel } from "../provider/provider-factory";
import { registry } from "../agent/tool-registry";
import { loadSkills } from "../agent/skill-loader";
import { buildSystemPrompt } from "../agent/skill-prompt";
import { makeReadSkillTool } from "../agent/read-skill";
import { classifyError } from "../chat/error-classify";
import { computeNextRun } from "./schedule";
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
function collectTools(
  workspacePath: string | undefined,
  skills: ReturnType<typeof loadSkills>,
) {
  const registered = registry.getDefinitions();
  const injected = workspacePath
    ? registered
    : registered.filter(
        (def) => def.name.startsWith("mcp__") || def.name === "create_skill",
      );
  return [makeReadSkillTool(skills), ...injected];
}

export interface ExecuteTaskOptions {
  triggerType: "schedule" | "catchUp" | "retry";
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
      return await failRun(run.id, task, "model_missing", startedAt, sessionId);
    }
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
    });
  } catch (e) {
    Log.error("自动化任务执行异常", task.id, e);
    return await failRun(run.id, task, classifyError(e), startedAt, sessionId);
  }
}

async function createSession(task: AutomationTaskRow): Promise<number> {
  const session = await prisma.session.create({
    data: {
      workspaceId: task.workspaceId,
      currentModelId: task.modelId,
      title: task.name,
      mode: "agent",
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
}

async function streamAndRecord(
  task: AutomationTaskRow,
  opts: ExecuteTaskOptions,
  ctx: StreamContext,
): Promise<"success" | "failed"> {
  const userText = replaceVariables(task.prompt, new Date());
  await prisma.message.create({
    data: {
      sessionId: ctx.sessionId,
      role: "user",
      blocks: serializeBlocks([{ type: "text", text: userText }]),
    },
  });
  const skills = loadSkills([
    {
      dir: path.join(app.getPath("userData"), "skills"),
      source: "user",
    },
    // workspace 级 source 用 "workspace"(对齐 chat.service collectSkills
    // 的实际签名与语义:同名用户级胜,来源标记供 UI 区分)
    ...(ctx.workspacePath
      ? [
          {
            dir: path.join(ctx.workspacePath, ".mirror", "skills"),
            source: "workspace" as const,
          },
        ]
      : []),
  ]);
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
    system: buildSystemPrompt(undefined, skills),
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
      // 完全访问 + 审批自动放行(spec §0 无人值守决策)
      fullAccess: () => true,
      isToolAllowed: async () => true,
      requestApproval: async () => true,
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
      durationMs: Date.now() - ctx.startedAt,
      promptTokens: usage?.promptTokens,
      completionTokens: usage?.completionTokens,
      error: result.errorMessage
        ? `${result.errorCode}: ${result.errorMessage}`.slice(0, 500)
        : null,
      finishedAt: new Date(),
    },
  });
  await advanceTask(task, new Date());
  return success ? "success" : "failed";
}

/** 失败收尾:run failed + 可选 task 标异常(系统错误码) */
async function failRun(
  runId: number,
  task: AutomationTaskRow,
  errorCode: string,
  startedAt: number,
  sessionId?: number,
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
    await advanceTask(task, new Date());
  }
  return "failed";
}

/** lastRunAt=now;nextRunAt=computeNextRun(once 到期 → expired) */
async function advanceTask(task: AutomationTaskRow, now: Date): Promise<void> {
  const schedule = JSON.parse(task.scheduleJson) as ScheduleConfig;
  const next = computeNextRun(schedule, now, now);
  await prisma.automationTask.update({
    where: { id: task.id },
    data: {
      lastRunAt: now,
      nextRunAt: next,
      ...(schedule.mode === "periodic" &&
        schedule.kind === "once" && { status: "expired" }),
    },
  });
}
