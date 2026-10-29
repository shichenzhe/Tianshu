/**
 * 自动化任务执行器（自 mirror
 * electron/domains/ai/automation/automation-runner.ts 摘取，GA-T5）：
 * targetKind=graph 分流 executeGraphRun（图编排，spec §4）；prompt 任务：
 * 建 session → 引用解析注入（spec §2，文件/技能内容前缀 + 技能聚焦 +
 * 变量替换）→ 静默 runChatStream（权限按任务 accessMode 分流，无人值守）
 * → 落 message 与 run（调度字段仅 schedule/catchUp/retry 触发推进，手动
 * 测试运行不消耗调度）。不经渲染层（onChunk 不传），产物在聊天页可回看。
 * 项目任务（子系统 E）：会话归属 projectId；项目 systemPrompt（trim 后
 * 非空）作为 buildSystemPrompt base 注入。
 *
 * ================= GA-T5 server 副本改造点登记（其余逐行保持） =================
 * 1. prisma 模块单例 → graphExecutorRuntime().db（GA-T4 授权面 2 同款；
 *    ruling 8 单向引 executor 尾段 advanceTask——其自身即经该运行时取库，
 *    runner 复用同一装配，graph 模块工厂/测试 installGraphExecutorRuntime）
 * 2. ../chat/chat.service runChatStream → server chat-runner
 *    （src/core/chat-runner.service，固定注入 toLangChainTools 的薄包装）
 * 3. ../chat/blocks（serializeBlocks/MessageBlock）、../chat/error-classify
 *    （classifyError）、./schedule（computeNextRun/ScheduleConfig——随
 *    advanceTask 居 executor）→ @tianshu/core（GA-T2 收编）
 * 4. ../agent/workspace-path、../agent/skill-prompt → server 副本
 *    （src/core/tools/workspace-path、src/core/skill-prompt）；
 *    ../orchestration/langchain-model-factory → src/core/provider/model-factory
 * 5. ../../security/command-gate|file-gate → server 副本 src/core/security
 * 6. ../orchestration/graph-executor executeGraphRun → GA-T4 副本
 *    （src/core/graph/graph-executor）；advanceTask/collectTools/
 *    resolveAutomationPermissions/AutomationTaskRow 四符号 ruling 8 单向引
 *    自该副本尾段「断环摘取」——勿再复制（本文件原样删除四定义）
 * 7. ../monitor/monitor-events recordLlmCall/recordToolCall 不移植（server
 *    无 monitor 域，chat-runner 无头裁剪同款先例——usage 埋点段删）
 * 8. ExecuteTaskOptions.dataSafety（ChatDataSafety 闭包）→ safety（server
 *    config 值面：allowDangerousTools/deleteProtection/trashRoot，spec §6
 *    与 config tianshu.chat 联动）；agent.unattended:true →
 *    autoDenyApprovals:true（GA-T4 授权面 8 等价适配）+ agent.allowDangerousTools
 *    （false 时 bash 经 tool-gate 门整体拒绝，denied chunk 记录拒绝
 *    原因——full 任务同样受 config 门，GA-T4 偏差 4 同源）；bulkDeleteThreshold/
 *    onBackupFile 不移植（无 FileHistoryService，tool-gate 缺省阈值 50）
 * 9. commons/Log → Nest Logger；session/message → sessionRecord/messageRecord
 *    （server client 模型名，物理表同名，GA-T4 授权面 2 同款）
 * 10. ./resolve-attachments → 本目录闭包随行件（该文件头注释登记偏差）
 * 11. taskFinishedEvent/AutomationChainEvent 自 mirror automation-event-bus
 *     单符号摘取（事件总线文件不在 T5 摘取面；总线副本落地后接线/回收）
 * ============================================================================
 */
import { format } from 'date-fns';
import { Logger } from '@nestjs/common';
import { runChatStream } from '../../core/chat-runner.service';
import { normalizeWorkspacePath } from '../../core/tools/workspace-path';
import {
  classifyError,
  recordLlmCall,
  recordToolCall,
  serializeBlocks,
} from '@tianshu/core';
import type { MessageBlock } from '@tianshu/protocol';
import { createChatModel } from '../../core/provider/model-factory';
import { buildSystemPrompt } from '../../core/skill-prompt';
import { commandGate } from '../../core/security/command-gate';
import { fileGate } from '../../core/security/file-gate';
import { resolveAttachments } from './resolve-attachments';
import {
  advanceTask,
  collectTools,
  resolveAutomationPermissions,
  executeGraphRun,
  type AutomationTaskRow,
} from '../../core/graph/graph-executor';
import { graphExecutorRuntime } from '../../core/graph/executor-runtime';

const logger = new Logger('automation-runner');

const WEEKDAY_ZH = ['一', '二', '三', '四', '五', '六', '日'];

/** 链式事件形（自 mirror automation-event-bus AutomationEvent 类型摘取，
 * 改造点 11）：appStarted 启动源 / taskFinished 收官源 */
export type AutomationChainEvent =
  | { source: 'appStarted' }
  | {
      source: 'taskFinished';
      targetType: 'task' | 'graph';
      targetId: number;
      outcome: 'success' | 'failed';
    };

/** run 收官事件源（自 mirror automation-event-bus taskFinishedEvent 摘取，
 * 改造点 11）：graph 任务以图为目标（targetId=graphId），prompt 任务以
 * 任务自身为目标（targetId=taskId）——scheduler.launch / repo runNow 同口径 */
export function taskFinishedEvent(
  task: AutomationTaskRow,
  outcome: 'success' | 'failed',
): AutomationChainEvent {
  return task.targetKind === 'graph'
    ? {
        source: 'taskFinished',
        targetType: 'graph',
        targetId: task.graphId ?? 0,
        outcome,
      }
    : {
        source: 'taskFinished',
        targetType: 'task',
        targetId: task.id,
        outcome,
      };
}

/** 运行时变量替换（中文格式，spec §4；语言不跟随 i18n，固定格式） */
export function replaceVariables(prompt: string, now: Date): string {
  return prompt
    .replaceAll('{{date}}', format(now, 'yyyy-MM-dd'))
    .replaceAll(
      '{{weekday}}',
      WEEKDAY_ZH[(now.getDay() === 0 ? 7 : now.getDay()) - 1],
    )
    .replaceAll('{{time}}', format(now, 'HH:mm'));
}

/** assistant blocks 的 usage 块 → run 记录 token 数 */
export function extractUsage(
  blocks: MessageBlock[],
): { promptTokens: number; completionTokens: number } | undefined {
  const usage = blocks.find((b) => b.type === 'usage');
  return usage && usage.type === 'usage'
    ? { promptTokens: usage.input, completionTokens: usage.output }
    : undefined;
}

/** 数据安全与危险工具装配（改造点 8：mirror ChatDataSafety 闭包的 server
 * config 值面）：缺省走安全侧——allowDangerousTools false（bash
 * 拒绝）、deleteProtection true；scheduler/runNow 自 config.yml
 * tianshu.chat 段装配透传 */
export interface AutomationSafetyOptions {
  /** 危险工具开关（config tianshu.chat.allowDangerousTools，缺省 false） */
  allowDangerousTools?: boolean;
  /** 删除保护（config tianshu.chat.deleteProtection，缺省 true） */
  deleteProtection?: boolean;
  /** 回收目录根（缺省数据根 trash/） */
  trashRoot?: string;
}

export interface ExecuteTaskOptions {
  triggerType: 'schedule' | 'catchUp' | 'retry' | 'manual' | 'event';
  attempt: number;
  abort: AbortSignal;
  /** 数据安全装配（改造点 8）：可选透传，缺省走安全侧缺省值 */
  safety?: AutomationSafetyOptions;
  /** 工具禁用清单（SP6 裁定 2）：可选透传闭包（装配层注入实时读安全
   * 配置），缺省不滤——注入层过滤，禁用=对模型不存在 */
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
  return graphExecutorRuntime().db.automationRun.create({
    data: {
      taskId: task.id,
      attempt: opts.attempt,
      triggerType: opts.triggerType,
      status: 'running',
      startedAt: now,
    },
  });
}

/**
 * 单次执行（所有异常吞掉落库，绝不向调度器抛出）。
 * targetKind=graph 分流（spec §4）：workspace 校验后交 executeGraphRun，
 * 模型校验由 executor 按入口节点自查。
 * 返回值仅用于测试断言：最终 run.status。
 */
export async function executeTask(
  task: AutomationTaskRow,
  opts: ExecuteTaskOptions,
): Promise<'success' | 'failed'> {
  const now = new Date();
  const startedAt = Date.now();
  let runId: number | undefined;
  let sessionId: number | undefined;
  try {
    const workspace = await graphExecutorRuntime().db.workspace.findUnique({
      where: { id: task.workspaceId },
    });
    if (!workspace) {
      runId = (await createRunningRun(task, opts, now)).id;
      return await failRun(
        runId,
        task,
        'workspace_missing',
        startedAt,
        sessionId,
        opts.triggerType,
      );
    }
    if (task.targetKind === 'graph') {
      return await executeGraphTask(task, opts, workspace, startedAt);
    }
    const modelRow = await graphExecutorRuntime().db.model.findUnique({
      where: { id: task.modelId },
    });
    const providerRow = modelRow
      ? await graphExecutorRuntime().db.provider.findUnique({
          where: { id: modelRow.providerId },
        })
      : null;
    if (!modelRow || !providerRow) {
      runId = (await createRunningRun(task, opts, now)).id;
      return await failRun(
        runId,
        task,
        'model_missing',
        startedAt,
        sessionId,
        opts.triggerType,
      );
    }
    /** 项目任务：读项目指令注入 system prompt（子系统 E） */
    const projectRow = task.projectId
      ? await graphExecutorRuntime().db.project.findUnique({
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
    logger.error(`自动化任务执行异常 ${task.id} ${String(e)}`);
    // run 行未建（建行前异常）时补建，失败必留痕
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

/** graph 任务分流（spec §4）：校验图存在与启用——缺失=运行前图被删，置
 * task error/graph_missing（对齐 workspace_missing 先例，重试无益）；禁用=
 * 用户主动停用，run failed（graph_disabled）但不置 task error（重新启用
 * 图后调度自然恢复）；模型由 executor 按入口节点自查。run 行由 executor
 * 落库（带 graphId/graphTrace） */
async function executeGraphTask(
  task: AutomationTaskRow,
  opts: ExecuteTaskOptions,
  workspace: { id: number; directoryPath: string | null },
  startedAt: number,
): Promise<'success' | 'failed'> {
  const graph = task.graphId
    ? await graphExecutorRuntime().db.graphDefinition.findUnique({
        where: { id: task.graphId },
      })
    : null;
  if (!graph) {
    const run = await createRunningRun(task, opts, new Date());
    return await failRun(
      run.id,
      task,
      'graph_missing',
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
      'graph_disabled',
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
  const session = await graphExecutorRuntime().db.sessionRecord.create({
    data: {
      workspaceId: task.workspaceId,
      currentModelId: task.modelId,
      title: task.name,
      mode: 'agent',
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
): Promise<'success' | 'failed'> {
  // 引用解析(spec §2)：失败短路 failRun；成功取注入文本与聚焦技能清单
  const resolution = await resolveAttachments(
    task.prompt,
    ctx.workspacePath,
    new Date(),
  );
  if ('error' in resolution) {
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
  await graphExecutorRuntime().db.messageRecord.create({
    data: {
      sessionId: ctx.sessionId,
      role: 'user',
      blocks: serializeBlocks([{ type: 'text', text: userText }]),
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
        role: 'user',
        blocks: serializeBlocks([{ type: 'text', text: userText }]),
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
      // create_schedule 落库依据（任务行自带：链式创建场景）
      userId: task.userId ?? undefined,
      workspaceId: task.workspaceId,
      modelId: task.modelId,
      // 权限按任务持久化 accessMode 分流(spec §2.3)，不再无条件放行
      ...resolveAutomationPermissions(
        task.accessMode === 'full' ? 'full' : 'default',
      ),
      // 监控埋点（MO 批；mirror 同位）：终态工具事件 fire-and-forget
      toolStats: (e) =>
        void recordToolCall(graphExecutorRuntime().db, {
          ...e,
          scene: 'automation',
          userId: task.userId ?? undefined,
          sessionId: ctx.sessionId,
        }),
      // 命令判定门(SP2)：与 chat 共享模块单例；无人值守 ask 强拒不挂审批
      decideCommand: commandGate,
      // 文件判定门(SP3)：同命令门共享模块单例；无人值守 block 强拒不挂审批
      decideFileAccess: fileGate,
      // 改造点 8：SP4 数据安全 → server config 值面；unattended 强拒语义
      // 折进 autoDenyApprovals（无应答方不挂起）与 allowDangerousTools
      // （config 门，spec §6 联动——false 时 bash 整体拒绝）
      allowDangerousTools: opts.safety?.allowDangerousTools ?? false,
      deleteProtection: opts.safety?.deleteProtection ?? true,
      trashRoot: opts.safety?.trashRoot,
      autoDenyApprovals: true,
    },
  });
  // 定点豁免（GA-T3 graph.repository 同况）：@tianshu file: 包经 symlink 双
  // 路径解析出两份名义 MessageBlock 身份，tsc 判等而 typed-lint 误报
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  const usage = extractUsage(result.blocks);
  // 监控埋点（MO 批；mirror 同位）：automation prompt 任务 usage 提取后
  // fire-and-forget（recordLlmCall 自吞错）
  if (usage) {
    void recordLlmCall(graphExecutorRuntime().db, {
      userId: task.userId ?? undefined,
      scene: 'automation',
      modelId: task.modelId,
      sessionId: ctx.sessionId,
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      durationMs: Date.now() - ctx.startedAt,
    });
  }
  await graphExecutorRuntime().db.messageRecord.create({
    data: {
      sessionId: ctx.sessionId,
      role: 'assistant',
      blocks: serializeBlocks(result.blocks),
      modelId: task.modelId,
      error: result.errorMessage,
      durationMs: Date.now() - ctx.startedAt,
    },
  });
  const success = !result.errorCode;
  await graphExecutorRuntime().db.automationRun.update({
    where: { id: ctx.runId },
    data: {
      status: success ? 'success' : 'failed',
      // 终态 run 关联 session(spec §4 步骤7)：§5 运行记录点击跳回聊天的依据
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
    success ? 'success' : 'failed',
    opts.triggerType,
  );
  return success ? 'success' : 'failed';
}

/** 失败收尾：run failed + 可选 task 标异常（系统错误码） */
async function failRun(
  runId: number,
  task: AutomationTaskRow,
  errorCode: string,
  startedAt: number,
  sessionId: number | undefined,
  triggerType: ExecuteTaskOptions['triggerType'],
): Promise<'failed'> {
  await graphExecutorRuntime().db.automationRun.update({
    where: { id: runId },
    data: {
      status: 'failed',
      error: errorCode,
      durationMs: Date.now() - startedAt,
      sessionId: sessionId ?? null,
      finishedAt: new Date(),
    },
  });
  if (
    errorCode === 'workspace_missing' ||
    errorCode === 'model_missing' ||
    errorCode === 'graph_missing'
  ) {
    await graphExecutorRuntime().db.automationTask.update({
      where: { id: task.id },
      data: { status: 'error', enabled: false, statusNote: errorCode },
    });
  } else {
    // 非系统失败：once 不置 expired（留 status=active 待重试扫描，见
    // advanceTask 注释——居 executor 副本尾段）
    await advanceTask(task, new Date(), 'failed', triggerType);
  }
  return 'failed';
}
