/**
 * 自动化任务执行器(spec §4):targetKind=graph 分流 executeGraphRun(图
 * 编排,spec §4);prompt 任务:建 session → 引用解析注入(spec §2,文件/技能
 * 内容前缀 + 技能聚焦 + 变量替换)→ 静默 runChatStream(权限按任务
 * accessMode 分流,无人值守)→ 落 message 与 run(调度字段仅 schedule/
 * catchUp/retry 触发推进,手动测试运行不消耗调度)。不经渲染层(onChunk 不传)，产物在
 * 聊天页可回看。项目任务(子系统 E):会话归属 projectId;项目 systemPrompt
 * (trim 后非空)作为 buildSystemPrompt base 注入。
 */
import { format } from "date-fns";
import prisma from "../../../commons/prisma-client";
import Log from "../../../commons/Log";
import { runChatStream, type ChatDataSafety } from "../chat/chat.service";
import { normalizeWorkspacePath } from "../agent/workspace-path";
import { serializeBlocks, type MessageBlock } from "../chat/blocks";
import { createChatModel } from "../orchestration/langchain-model-factory";
import { registry, filterDisabledTools } from "../agent/tool-registry";
import type { SkillInfo } from "../agent/skill-loader";
import { buildSystemPrompt } from "../agent/skill-prompt";
import { makeReadSkillTool } from "../agent/read-skill";
import { classifyError } from "../chat/error-classify";
import { commandGate } from "../../security/command-gate";
import { fileGate } from "../../security/file-gate";
import { computeNextRun } from "./schedule";
import { resolveAttachments } from "./resolve-attachments";
import { executeGraphRun } from "../orchestration/graph-executor";
import { recordLlmCall, recordToolCall } from "../monitor/monitor-events";
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

/** 工具集组装(对齐 chat.service collectToolDefinitions:read_skill 常驻)。
 * 第三参(SP6 裁定 2):注入层禁用=对模型不存在;闭包实时读配置,缺省不滤
 * (行为与接入前一致) */
export async function collectTools(
  workspacePath: string | undefined,
  skills: SkillInfo[],
  disabled: () => string[] = () => [],
) {
  // plan_* 仅项目会话可用(依赖 ctx.projectId);定时任务 agent 不带 projectId,
  // 带上只会得到「未关联项目」拒绝——剔除,避免污染模型的工具列表
  const registered = registry
    .getDefinitions()
    .filter((def) => !def.name.startsWith("plan_"));
  const injected = workspacePath
    ? registered
    : registered.filter(
        (def) =>
          def.name.startsWith("mcp__") ||
          def.name === "run_command" ||
          def.name === "create_skill",
      );
  return filterDisabledTools(
    [makeReadSkillTool(skills), ...injected],
    disabled(),
  );
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
  triggerType: "schedule" | "catchUp" | "retry" | "manual" | "event";
  attempt: number;
  abort: AbortSignal;
  /** 数据安全装配（SP4 裁定）：可选透传，缺省 undefined——automation 现无
   * SecurityService/FileHistoryService 依赖，不注入即走缺省值
   * （unattended 流对批量删除已有强拒兜底） */
  dataSafety?: ChatDataSafety;
  /** 工具禁用清单（SP6 裁定 2）：可选透传闭包（Application 注入实时读
   * 安全配置），缺省不滤——注入层过滤，禁用=对模型不存在 */
  disabledTools?: () => string[];
  /** graph 任务输入变量（spec §4）：事件触发={outcome}，定时/手动=空对象；
   * prompt 任务不消费 */
  inputs?: Record<string, string>;
}

/** running 状态 run 行（按需建：graph 任务 run 由 executor 落库带
 * graphId/graphTrace，此处不重复建行——防同次执行出现两条 run 记录） */
async function createRunningRun(
  task: AutomationTaskRow,
  opts: ExecuteTaskOptions,
  now: Date,
): Promise<{ id: number }> {
  return prisma.automationRun.create({
    data: {
      taskId: task.id,
      attempt: opts.attempt,
      triggerType: opts.triggerType,
      status: "running",
      startedAt: now,
    },
  });
}

/**
 * 单次执行(所有异常吞掉落库,绝不向调度器抛出)。
 * targetKind=graph 分流(spec §4)：workspace 校验后交 executeGraphRun，
 * 模型校验由 executor 按入口节点自查。
 * 返回值仅用于测试断言:最终 run.status。
 */
export async function executeTask(
  task: AutomationTaskRow,
  opts: ExecuteTaskOptions,
): Promise<"success" | "failed"> {
  const now = new Date();
  const startedAt = Date.now();
  let runId: number | undefined;
  let sessionId: number | undefined;
  try {
    const workspace = await prisma.workspace.findUnique({
      where: { id: task.workspaceId },
    });
    if (!workspace) {
      runId = (await createRunningRun(task, opts, now)).id;
      return await failRun(
        runId,
        task,
        "workspace_missing",
        startedAt,
        sessionId,
        opts.triggerType,
      );
    }
    if (task.targetKind === "graph") {
      return await executeGraphTask(task, opts, workspace, startedAt);
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
      runId = (await createRunningRun(task, opts, now)).id;
      return await failRun(
        runId,
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
    runId = (await createRunningRun(task, opts, now)).id;
    sessionId = await createSession(task);
    return await streamAndRecord(task, opts, {
      runId,
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
    // run 行未建(建行前异常)时补建，失败必留痕
    const id = runId ?? (await createRunningRun(task, opts, now)).id;
    return await failRun(
      id,
      task,
      classifyError(e),
      startedAt,
      sessionId,
      opts.triggerType,
    );
  }
}

/** graph 任务分流(spec §4)：校验图存在与启用——缺失=运行前图被删，置
 * task error/graph_missing(对齐 workspace_missing 先例，重试无益)；禁用=
 * 用户主动停用，run failed(graph_disabled)但不置 task error（重新启用
 * 图后调度自然恢复）；模型由 executor 按入口节点自查。run 行由 executor
 * 落库(带 graphId/graphTrace) */
async function executeGraphTask(
  task: AutomationTaskRow,
  opts: ExecuteTaskOptions,
  workspace: { id: number; directoryPath: string | null },
  startedAt: number,
): Promise<"success" | "failed"> {
  const graph = task.graphId
    ? await prisma.graphDefinition.findUnique({ where: { id: task.graphId } })
    : null;
  if (!graph) {
    const run = await createRunningRun(task, opts, new Date());
    return await failRun(
      run.id,
      task,
      "graph_missing",
      startedAt,
      undefined,
      opts.triggerType,
    );
  }
  if (!graph.enabled) {
    const run = await createRunningRun(task, opts, new Date());
    return await failRun(
      run.id,
      task,
      "graph_disabled",
      startedAt,
      undefined,
      opts.triggerType,
    );
  }
  return await executeGraphRun({
    graph,
    task,
    inputs: opts.inputs ?? {},
    triggerType: opts.triggerType,
    attempt: opts.attempt,
    abort: opts.abort,
    workspace,
    disabledTools: opts.disabledTools,
  });
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
      // 归属用户（listAll 按 userId 过滤，漏写则运行历史「查看会话」
      // 跳转找不到会话落空态）
      userId: task.userId ?? null,
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
    // T3-3 换栈：模型构造收口 createChatModel（采样参数随构造注入）
    model: createChatModel(
      {
        type: ctx.providerType,
        baseUrl: ctx.baseUrl,
        apiKey: ctx.apiKey ?? undefined,
        extraHeaders: ctx.extraHeaders,
      },
      ctx.modelSdkId,
      { temperature: task.temperature ?? undefined },
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
    toolDefinitions: await collectTools(
      ctx.workspacePath,
      skills,
      opts.disabledTools,
    ),
    agent: {
      sessionId: ctx.sessionId,
      workspacePath: ctx.workspacePath,
      // create_automation_task 落库依据（任务行自带：链式创建场景）
      userId: task.userId ?? undefined,
      workspaceId: task.workspaceId,
      modelId: task.modelId,
      // 权限按任务持久化 accessMode 分流(spec §2.3),不再无条件放行
      ...resolveAutomationPermissions(
        task.accessMode === "full" ? "full" : "default",
      ),
      // 命令判定门(SP2):与 chat 共享模块单例;无人值守 ask 强拒不挂审批
      decideCommand: commandGate,
      // 文件判定门(SP3):同命令门共享模块单例;无人值守 block 强拒不挂审批
      decideFileAccess: fileGate,
      // SP4 数据安全:可选注入透传,缺省 undefined(automation 无备份与批量
      // 门装配——unattended 流已有强拒兜底)
      deleteProtection: opts.dataSafety?.deleteProtection(),
      bulkDeleteThreshold: opts.dataSafety?.bulkDeleteThreshold(),
      onBackupFile: opts.dataSafety
        ? (absPath, sid) => opts.dataSafety!.backupFile(absPath, sid)
        : undefined,
      unattended: true,
      // 监控埋点（spec §4.1 #3）：终态工具事件 → fire-and-forget 落库
      // （recordToolCall 自吞错，失败不影响主流程）
      toolStats: (e) =>
        void recordToolCall(prisma, {
          ...e,
          scene: "automation",
          userId: task.userId ?? undefined,
          sessionId: ctx.sessionId,
        }),
    },
  });
  const usage = extractUsage(result.blocks);
  if (usage) {
    // 监控埋点（spec §4.1 #2）：automation prompt 任务落库时提取
    void recordLlmCall(prisma, {
      userId: task.userId ?? undefined,
      scene: "automation",
      modelId: task.modelId,
      sessionId: ctx.sessionId,
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      durationMs: Date.now() - ctx.startedAt,
    });
  }
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
  if (
    errorCode === "workspace_missing" ||
    errorCode === "model_missing" ||
    errorCode === "graph_missing"
  ) {
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
 * 手动/事件触发(triggerType=manual/event)不消耗调度:直接返回,once 不因此
 * expired、nextRunAt/lastRunAt 均不动——lastRunAt 若被推进,决策树
 * lastRunAt>=nextRunAt 会把未到触发点的 once 任务提前回收(事件对齐手动,
 * spec §5:不消耗定时调度)。
 * once 的 expired 只在成功路径置位:非系统失败需先走 §7 重试扫描
 * (nextRunAt=null 但 status 保持 active,重试耗尽后由调度器决策树收尾,
 * 不得首次失败即 expired——否则被 tick 的 active 过滤出局,零重试)
 */
export async function advanceTask(
  task: AutomationTaskRow,
  now: Date,
  outcome: "success" | "failed",
  triggerType: ExecuteTaskOptions["triggerType"] | "event",
): Promise<void> {
  if (triggerType === "manual" || triggerType === "event") {
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
