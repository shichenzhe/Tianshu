// eslint 并检适配（GA-T4 备案，先例 metrics.interceptor/main.ts 整文件
// 豁免）：本文件为 mirror 逐行摘取副本——@tianshu/core（file: 包）类型在
// eslint projectService 下不可解析（GA-T3 graph.repository 同况，tsc 正常）
// 与未安装驱动的 vendor-decls 环境声明面（exceljs/nodemailer 等 any）触发
// typed-lint 噪音；require-await 系 mirror 原文即有的 async 无 await 形态
// （逐行保持优先）。规则豁免不改变运行时行为。
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-base-to-string */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */ /* 逐行同形：两处 mirror 原样断言被 typed-lint 判冗余，保持原形（drift 面最小化） */
/**
 * 图执行编排（spec §4）：run 落库 → 逐节点（模板渲染 → LangChain 模型/
 * agent → 节点详情落 graphRunNode → trace 追加）→ 收尾（run/task/
 * usage）。全部异常吞掉落库返回 "failed"，绝不向调用方抛。
 * checkpointer 不接：JS LangGraph 的 MemorySaver 只能挂 compile() 期，
 * 而 compileStateGraph（T7 冻结）不透出该口；v1 无 resume/interrupt
 * 消费方，invoke 仍带 thread_id 供未来接入即换。
 *
 * ================= GA-T4 server 副本改造点登记（其余逐行保持） =================
 * 1. Electron 副作用注入化：BrowserWindow 节点状态推送（notifyNodeStatus，
 *    原 orchestration:node-status 广播）→ EventBus graph.run.updated 的
 *    progress 投影；Notification（notify 节点桌面通知）→ 运行时 notify
 *    钩子（默认无通道）。openPreview 无消费点（executor 实际 Electron 面
 *    仅上述两处；规划文本 BrowserWindow×3 为含注释/导入的计数）。
 * 2. prisma → server 自有（授权面 2）：mirror 模块级 prisma 单例改为
 *    executor-runtime 进程级句柄（./executor-runtime，graph 模块工厂/测试
 *    安装）；run 行落库走 graph.repository createRun/finishRun 原语（GA-T3
 *    已备，终值状态由本文件计算自管——repo 只落库）；节点详情行落
 *    graphRunNode（去会话化 2026-10-28，经 db.graphRunNode——模型名/
 *    物理表名与 mirror 同）。
 * 3. ../chat/blocks、../chat/error-classify、src-react graph.schema、
 *    ./graph-prompt、./graph-compiler → @tianshu/core（GA-T2 收编；
 *    ruling 4 勘误：zod 面在 core 非 protocol）。
 * 4. ../../security/command-gate|file-gate、../agent/workspace-path|
 *    tool-gate|skill-loader → server 既有副本（src/core/security、
 *    src/core/tools）；./langchain-model-factory|langchain-tool-adapter →
 *    server src/core/provider/model-factory、src/core/tools 副本（spec §3.4
 *    裁定消费现有副本）。
 * 5. 依赖环剔除（授权面 5）：../automation/automation-runner 的
 *    advanceTask/collectTools/resolveAutomationPermissions/AutomationTaskRow
 *    四符号（runner 调 executor，executor 不反调 runner）忠实摘至本文件
 *    末尾「GA-T4 断环摘取」段——T5 runner 副本自此单向引；../monitor/
 *    monitor-events → 运行时 recordMonitorEvents 钩子（监控埋点非关键
 *    路径，未注入跳过）；../provider/provider-runtime → server
 *    src/core/provider/model-factory（ProviderRuntimeInfo/parseExtraHeaders
 *    已并入该副本）。
 * 6. webhook（授权面 6）：executor 原文即未引用 webhook-server——no-op
 *    钩子无需落点，无头端 webhook 由 T7 NestJS controller 承接。
 * 7. 事件出口（授权面 7）：run/节点状态变化处 publish graph.run.updated
 *    （经运行时 publishRunUpdated；state: running|succeeded|failed|aborted。
 *    queued 不在 executor 生命周期——run 行创建即 running（GA-T3 createRun
 *    原语与 mirror createRunRow 同款），queued 留给 T6 控制层队列语义）。
 *    单一状态源是 run 表（success|failed），事件是投影（aborted 为
 *    failed+user_aborted 的展示精化态）。
 * 8. 环境适配（超授权面逐项备案）：nodemailer 改懒加载（server 未装该
 *    驱动，静态导入会令整个模块加载崩溃；vendor-decls.d.ts 保类型）；
 *    libraryItem 表 PL-2 已摘入——librarySearch 节点的缺表空召回 stub
 *    自然失效（分支保留无害）；buildAgentContext 的
 *    unattended:true → autoDenyApprovals:true（server 无应答方 ask 即拒，
 *    spec §12 偏离 2 等价）；toLangChainTools 的 onToolCall 钩子在 server
 *    适配器无此面 → 经 onChunk tool-update 终态投影等价记录。
 * 9. PL-3 裁定（PL-T2 concern ①）：collectTools 无工作空间白名单加入
 *    library_search（资料库用户级无属地语义，与 chat 侧常驻一致）；mirror
 *    无该工具，白名单 mcp__ 前缀/run_command/create_skill 三件之外此一条
 *    为 server 独有偏离（断环摘取段 collectTools 的唯一有意分叉）。
 * ============================================================================
 */
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Logger } from '@nestjs/common';
import { GraphDefinition } from '@prisma/client';
import {
  validateGraph,
  isLlmNode,
  isHttpNode,
  isComfyUIImageGen,
  renderNodePrompt,
  GraphTemplateError,
  type PromptRenderContext,
  compileStateGraph,
  classifyError,
  computeNextRun,
  type ScheduleConfig,
  type GraphRunState,
  type NodeHandler,
  type NodeResult,
  type CodeNode,
  type FileReadNode,
  type GraphJson,
  type GraphNode,
  type HttpNode,
  type HttpKV,
  type IterateNode,
  type LibrarySearchNode,
  type JsonParseNode,
  type JsonStringifyNode,
  type ConditionBranch,
  type ConditionNode,
  type IntentNode,
  type DelayNode,
  type DocExtractNode,
  type FileWriteNode,
  type ImageGenNode,
  type ComfyImageGenNode,
  type VectorSearchNode,
  type VectorizeNode,
  type DatabaseNode,
  type ExcelReadNode,
  type ExcelWriteNode,
  type CsvReadNode,
  type CsvWriteNode,
  type VariableNode,
  type AggregateNode,
  type EmailNode,
  type VariableTransform,
  type MergeNode,
  type LlmNode,
  type NotifyNode,
  type SubflowNode,
} from '@tianshu/core';
import { format as dateFnsFormat } from 'date-fns';
import { GraphRecursionError, isNodeError } from '@langchain/langgraph';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import {
  createChatModel,
  type ProviderRuntimeInfo,
} from '../provider/model-factory';
import { toLangChainTools } from '../tools/langchain-tool-adapter';
import { normalizeWorkspacePath } from '../tools/workspace-path';
import type { AgentStreamOptions } from '../tools/tool-gate';
import { commandGate } from '../security/command-gate';
import { fileGate } from '../security/file-gate';
import { loadSkills, type SkillInfo } from '../tools/skill-loader';
import { makeReadSkillTool } from '../tools/read-skill';
import { registry, filterDisabledTools } from '../tools/tool-registry';
import {
  graphExecutorRuntime,
  type GraphNodeRunStatus,
  type GraphRunUpdatedPayload,
} from './executor-runtime';
import type { PrismaService } from '../../commons/database/prisma.service';

export interface TraceEntry {
  id: string;
  name: string;
  status: 'success' | 'failed' | 'skipped';
  startedAt: string;
  durationMs: number;
  tokens?: { promptTokens: number; completionTokens: number };
  error?: { code: string; message: string; toolName?: string; detail?: string };
  toolCalls?: Array<{ name: string; ok: boolean; durationMs: number }>;
  outputPreview?: string;
  /** 生成图片（imageGen 节点产物，相对数据根路径）→ 轨迹内缩略图展示 */
  outputImage?: string;
  /** 循环节点死信（continue 模式失败项清单）——运行历史排查用 */
  errorOutput?: string;
  /** 降级继续标记（llm 节点 onError=defaultValue）：实际执行失败但以
   * 默认输出继续，此处保留失败原因供运行历史展示 */
  fallback?: { code: string; message: string };
}

/** server 行类型（GA-T3 graph.repository 同款：@prisma/client 生成模型名
 * 替代 mirror 的 prisma 推导——授权面 2） */
export type GraphRow = GraphDefinition;

/** 自动化任务行类型（GA-T4 授权面 5：自 mirror automation-runner 断环
 * 摘取——server prisma client 同款推导；T5 runner 副本自此引） */
export type AutomationTaskRow = NonNullable<
  Awaited<ReturnType<PrismaService['automationTask']['findFirst']>>
>;

export interface GraphRunParams {
  graph: GraphRow;
  task: AutomationTaskRow | null;
  inputs: Record<string, string>;
  triggerType:
    | 'schedule'
    | 'catchUp'
    | 'retry'
    | 'manual'
    | 'event'
    | 'subflow'
    | 'webhook';
  attempt: number;
  abort: AbortSignal;
  workspace: { id: number; directoryPath: string | null };
  disabledTools?: () => string[];
  /** 子工作流调用链（图 id 链，防循环引用；顶层执行为空） */
  subflowStack?: string[];
  /** 显式覆盖代码/写节点授权（webhook 等外部触发传 false 对齐 default
   * 任务；缺省维持试运行 task=null 全权语义） */
  codeAuthorized?: boolean;
  /** run 行创建后即回调（webhook 异步响应在图完成前拿 runId 轮询） */
  onRunId?: (runId: number) => void;
}

/** server 日志面（授权面 2 环境适配：mirror commons/Log → Nest Logger） */
const logger = new Logger('graph-executor');

/** 依赖注入 seam：测试经模块 mock 替换三件，产线取真实实现 */
export interface GraphExecutorDeps {
  createChatModel: typeof createChatModel;
  toLangChainTools: typeof toLangChainTools;
  compileStateGraph: typeof compileStateGraph;
}

const defaultDeps: GraphExecutorDeps = {
  createChatModel,
  toLangChainTools,
  compileStateGraph,
};

/** tools 节点 agent 循环步数保险丝（recursionLimit 形态，spec §3 maxSteps） */
const DEFAULT_AGENT_STEPS = 10;

/** 图级失败（无节点归属）：graph_invalid / graph_recursion_limit 等 */
class GraphRunFailure extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GraphRunFailure';
  }
}

/** 节点失败：run.error 聚合格式 node:<id> <code>: <msg> 的数据源 */
class GraphNodeFailure extends Error {
  constructor(
    public nodeId: string,
    public code: string,
    message: string,
    /** 失败全貌（完整 stderr/响应体/堆栈，构造点已 clip）：落 trace
     * error.detail 与节点失败消息正文，message 仅为 200 字摘要 */
    public detail?: string,
  ) {
    super(message);
    this.name = 'GraphNodeFailure';
  }
}

/** 失败详情上限：trace 落库与消息正文的 detail 防失控截断（stderr/
 * 响应体收集上限 64KB，透出取前 4KB） */
const ERROR_DETAIL_LIMIT = 4096;

function clipDetail(text: string): string {
  return text.length > ERROR_DETAIL_LIMIT
    ? `${text.slice(0, ERROR_DETAIL_LIMIT)}…（已截断，共 ${text.length} 字符）`
    : text;
}

/** 未知异常 → detail（Error 取堆栈；GraphNodeFailure 自带 detail 优先） */
function errorDetailOf(e: unknown): string | undefined {
  return e instanceof Error && e.stack ? clipDetail(e.stack) : undefined;
}

interface RunError {
  code: string;
  message: string;
  nodeId?: string;
}

interface NodeOutput {
  output: string;
  /** 循环节点死信（continue 模式失败项清单） */
  errorOutput?: string;
  /** 生成图片相对数据根路径（imageGen 专用，trace 透传） */
  outputImage?: string;
  route?: string;
  usage?: NodeResult['usage'];
  toolCalls?: TraceEntry['toolCalls'];
}

export interface NodeContext {
  /** 节点详情行归属 run（去会话化 2026-10-28）：null=单节点测试即席不落 */
  runId: number | null;
  abort: AbortSignal;
  workspacePath?: string;
  workspace: { id: number; directoryPath: string | null };
  /** 子工作流节点加载子图按 userId 隔离 */
  userId: number;
  /** 代码节点授权：试运行（用户显式触发）或任务完全访问——default
   * 任务的代码节点拒执行（对齐 run_command 的 write 审批语义） */
  codeAuthorized: boolean;
  disabledTools?: () => string[];
  /** 子工作流调用链（图 id），循环引用在此拦截 */
  subflowStack: string[];
  skills: SkillInfo[];
  agent: AgentStreamOptions;
  now: Date;
  trace: TraceEntry[];
  modelCache: Map<number, Promise<ModelRuntime>>;
  deps: GraphExecutorDeps;
}

interface ModelRuntime {
  provider: ProviderRuntimeInfo;
  sdkId: string;
}

interface FinishParams {
  runId: number;
  status: 'success' | 'failed';
  trace: TraceEntry[];
  startedAt: number;
  task: AutomationTaskRow | null;
  triggerType: GraphRunParams['triggerType'];
  /** 监控埋点（spec §4.1 #4）：事件归属图 id */
  graphId: number;
  /** 监控埋点：事件归属用户（task 缺席时由调用方回退图归属） */
  userId?: number | null;
  error?: RunError;
  /** 终态 output（成功路径最后成功节点完整输出——graph.run.updated 投影） */
  finalOutput?: string;
}

/** 图执行结果：status + 终点节点完整 output（子工作流节点消费） */
export interface GraphRunResult {
  status: 'success' | 'failed';
  /** 最后一个成功节点的完整 output；失败/无成功节点为空串 */
  output: string;
  /** 终态各节点完整 output（webhook 自定义响应模板渲染 {{nodes.x.output}}） */
  nodeOutputs?: Record<string, string>;
  /** 本次运行的 runId（异步 job 状态查询定位） */
  runId?: number;
}

/**
 * 单图执行（所有异常吞掉落库，绝不向调度器抛出）。
 * 返回值仅用于测试断言与调用方记账：最终 run.status。
 */
export async function executeGraphRun(
  params: GraphRunParams,
  deps: GraphExecutorDeps = defaultDeps,
): Promise<'success' | 'failed'> {
  return (await runGraphToResult(params, deps)).status;
}

/** 子工作流/循环节点复用的执行内核：完整跑一遍图并返回终点 output */
export async function runGraphToResult(
  params: GraphRunParams,
  deps: GraphExecutorDeps = defaultDeps,
): Promise<GraphRunResult> {
  const startedAt = Date.now();
  const runId = await createRunRow(params);
  params.onRunId?.(runId);
  try {
    const json = parseGraphJson(params.graph.graphJson);
    return await runGraph(params, deps, json, runId, startedAt);
  } catch (e) {
    logger.error('图执行异常', params.graph.id, e);
    await finishRun({
      runId,
      status: 'failed',
      trace: [],
      startedAt,
      task: params.task,
      triggerType: params.triggerType,
      // 监控埋点（spec §4.1 #4）：收尾事件归属图/用户（task 缺席回退图归属）
      graphId: params.graph.id,
      userId: params.task?.userId ?? params.graph.userId ?? null,
      error: toRunError(e),
    });
    return { status: 'failed', output: '' };
  }
}

/** graph.run.updated 事件出口（授权面 7）：尽力而为——无事件通道/纯
 * 落库模式静默，绝不影响 run 主链 */
function publishRunUpdated(payload: GraphRunUpdatedPayload): void {
  try {
    graphExecutorRuntime().publishRunUpdated?.(payload);
  } catch {
    // 推送尽力而为（无事件出口/测试环境静默）
  }
}

/** run 行创建走仓储原语（授权面 2；GA-T3 createRun 即落 running——mirror
 * createRunRow 同款），随后投影 running 事件 */
async function createRunRow(params: GraphRunParams): Promise<number> {
  const runId = await graphExecutorRuntime().runs.createRun({
    taskId: params.task?.id ?? null,
    graphId: params.graph.id,
    attempt: params.attempt,
    triggerType: params.triggerType,
  });
  publishRunUpdated({
    runId,
    graphId: params.graph.id,
    state: 'running',
  });
  return runId;
}

/** 用户主动中断标记（cancelTestRun 以 abort(reason) 传入）：aborted 且
 * reason 为 USER_CANCELLED 才归一 user_aborted——webhook 同步超时
 * （SYNC_TIMEOUT_MS）/ 调度器 stop 等其它 abort 来源不携带该标记 */
function isUserCancelled(signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true &&
    signal.reason instanceof Error &&
    signal.reason.message === 'USER_CANCELLED'
  );
}

/** 编译图并驱动 LangGraph；节点异常已在 handler 落 trace，这里只收口
 * （成败都自行 finishRun 落库，返回结果对象；终点 output 为最后成功
 * 节点在终态 state 的完整值——trace 仅存 200 字预览） */
async function runGraph(
  params: GraphRunParams,
  deps: GraphExecutorDeps,
  json: GraphJson,
  runId: number,
  startedAt: number,
): Promise<GraphRunResult> {
  const ctx = buildNodeContext(params, deps, runId);
  const handlers = Object.fromEntries(
    json.nodes.map((node) => {
      const inner = makeNodeHandler(node, ctx);
      // 包装 node-status 推送：开始 running，结束 success/failed（试运行
      // 画布实时高亮消费；graphId 为 0 的单节点测试不推——但单节点测试
      // 不走 runGraph，无此包装）
      return [
        node.id,
        async (state: GraphRunState) => {
          notifyNodeStatus(runId, params.graph.id, node.id, 'running');
          try {
            const result = await inner(state);
            notifyNodeStatus(runId, params.graph.id, node.id, 'success');
            return result;
          } catch (e) {
            notifyNodeStatus(runId, params.graph.id, node.id, 'failed');
            throw e;
          }
        },
      ];
    }),
  );
  const compiled = deps.compileStateGraph(json, handlers);
  const base = {
    runId,
    startedAt,
    trace: ctx.trace,
    task: params.task,
    triggerType: params.triggerType,
    // 监控埋点（spec §4.1 #4）：收尾事件归属图/用户（task 缺席回退图归属）
    graphId: params.graph.id,
    userId: params.task?.userId ?? params.graph.userId ?? null,
  };
  try {
    const result = await compiled.graph.invoke(
      { inputs: params.inputs, nodes: {} },
      {
        ...compiled.config,
        configurable: { thread_id: `graph-${params.graph.id}-run-${runId}` },
      },
    );
    appendSkippedEntries(json, ctx.trace);
    const output = finalOutputOf(ctx.trace, result);
    await finishRun({ ...base, status: 'success', finalOutput: output });
    return {
      status: 'success',
      output,
      nodeOutputs: nodeOutputsOf(result),
      runId,
    };
  } catch (e) {
    logger.error('图节点执行失败', params.graph.id, `run=${runId}`, e);
    appendSkippedEntries(json, ctx.trace);
    // 图中止（cancelTestRun，reason=USER_CANCELLED）→ error 归一
    // user_aborted；webhook 同步超时/调度 stop 等无标记 abort 与节点
    // 超时路径（ctx.abort 未触发）不受影响，走 toRunError
    const userAborted = isUserCancelled(params.abort);
    await finishRun({
      ...base,
      status: 'failed',
      error: userAborted
        ? { code: 'user_aborted', message: '已被用户中断' }
        : toRunError(e),
    });
    // 失败路径无终态 state（invoke 抛出时 result 未产生）——nodeOutputs 空
    return {
      status: 'failed',
      output: '',
      nodeOutputs: {},
      runId,
    };
  }
}

/** 终点 output：trace 最后一个 success 节点在终态 state 的完整值
 * （trace 仅存 200 字预览，完整值从 invoke 返回的 state 取） */
/** 终态 state.nodes → 各节点完整 output 映射（webhook 响应模板消费） */
function nodeOutputsOf(result: unknown): Record<string, string> {
  const nodes = (
    result as {
      nodes?: Record<string, { output?: string }>;
    }
  )?.nodes;
  if (!nodes) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [id, entry] of Object.entries(nodes)) {
    out[id] = entry?.output ?? '';
  }
  return out;
}

function finalOutputOf(trace: TraceEntry[], result: unknown): string {
  const last = [...trace].reverse().find((entry) => entry.status === 'success');
  if (!last) {
    return '';
  }
  const nodes = (result as { nodes?: Record<string, { output?: string }> })
    ?.nodes;
  return nodes?.[last.id]?.output ?? '';
}

function parseGraphJson(raw: string): GraphJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new GraphRunFailure(
      'graph_invalid',
      `graphJson 不是合法 JSON: ${errorMessage(e)}`,
    );
  }
  const validated = validateGraph(parsed);
  if (!validated.ok) {
    throw new GraphRunFailure(
      'graph_invalid',
      validated.issues.map((issue) => issue.code).join('; '),
    );
  }
  return validated.value;
}

function buildNodeContext(
  params: GraphRunParams,
  deps: GraphExecutorDeps,
  runId: number | null,
): NodeContext {
  const workspacePath = params.workspace.directoryPath?.trim()
    ? normalizeWorkspacePath(params.workspace.directoryPath)
    : undefined;
  return {
    runId,
    abort: params.abort,
    workspacePath,
    workspace: params.workspace,
    // 历史 graph 行 userId 可空：0 永不匹配子图查询 → subflow_missing 兜底
    userId: params.graph.userId ?? 0,
    // 试运行（用户显式触发）或任务完全访问——default 任务的代码节点
    // 拒执行（对齐 run_command 的 write 审批语义）；webhook 等外部触发
    // 显式传 false 对齐 default 无人值守语义（params.codeAuthorized 覆盖）
    codeAuthorized:
      params.codeAuthorized ??
      (params.task === null || params.task.accessMode === 'full'),
    disabledTools: params.disabledTools,
    // 顶层执行以自身 id 起栈：直接自引用（子图=本图）第一层即拦
    subflowStack: params.subflowStack ?? [String(params.graph.id)],
    skills: loadRunSkills(workspacePath),
    agent: buildAgentContext(params, workspacePath),
    now: new Date(),
    trace: [],
    modelCache: new Map(),
    deps,
  };
}

/** 工具执行上下文：无人值守权限分流 + 命令/文件判定门（接线先例
 * automation-runner streamAndRecord）；图执行无会话归属（去会话化
 * 2026-10-28），sessionId 恒 null */
function buildAgentContext(
  params: GraphRunParams,
  workspacePath?: string,
): AgentStreamOptions {
  return {
    sessionId: null,
    workspacePath,
    projectId: params.task?.projectId ?? null,
    ...resolveAutomationPermissions(
      params.task?.accessMode === 'full' ? 'full' : 'default',
    ),
    decideCommand: commandGate,
    decideFileAccess: fileGate,
    // 授权面 8：mirror unattended:true（无人值守 ask 即拒）→ server
    // autoDenyApprovals（无应答方不挂起直接拒，spec §12 偏离 2 等价）
    autoDenyApprovals: true,
  };
}

/** 技能目录（对齐 resolve-attachments：用户级在前优先） */
function loadRunSkills(workspacePath?: string): SkillInfo[] {
  const dirs: Array<{ dir: string; source: 'user' | 'workspace' }> = [
    { dir: graphExecutorRuntime().skillsDir(), source: 'user' },
  ];
  if (workspacePath) {
    dirs.push({
      dir: path.join(workspacePath, '.tianshu', 'skills'),
      source: 'workspace',
    });
  }
  return loadSkills(dirs);
}

/** 节点执行器（spec §4 步骤3）：kind 分流——llm 渲染→模型/agent；
 * code 门禁→临时脚本→spawn 收 stdout；http 模板替换→fetch 收响应体。
 * 三类都节点详情落 graphRunNode + trace */
function makeNodeHandler(node: GraphNode, ctx: NodeContext): NodeHandler {
  if (node.kind === 'start') {
    // start 无执行语义：直通（不写 state.nodes，引用其 output 的
    // 模板会抛未定义——正确引导从 input 取值）
    return async () => ({ nodes: {} });
  }
  if (isHttpNode(node)) {
    return makeHttpNodeHandler(node, ctx);
  }
  if (node.kind === 'fileRead') {
    return makeFileReadNodeHandler(node, ctx);
  }
  if (node.kind === 'notify') {
    return makeNotifyNodeHandler(node, ctx);
  }
  if (node.kind === 'subflow') {
    return makeSubflowNodeHandler(node, ctx);
  }
  if (node.kind === 'iterate') {
    return makeIterateNodeHandler(node, ctx);
  }
  if (node.kind === 'librarySearch') {
    return makeLibrarySearchNodeHandler(node, ctx);
  }
  if (node.kind === 'jsonParse') {
    return makeJsonParseNodeHandler(node, ctx);
  }
  if (node.kind === 'jsonStringify') {
    return makeJsonStringifyNodeHandler(node, ctx);
  }
  if (node.kind === 'condition') {
    return makeConditionNodeHandler(node, ctx);
  }
  if (node.kind === 'intent') {
    return makeIntentNodeHandler(node, ctx);
  }
  if (node.kind === 'fileWrite') {
    return makeFileWriteNodeHandler(node, ctx);
  }
  if (node.kind === 'docExtract') {
    return makeDocExtractNodeHandler(node, ctx);
  }
  if (node.kind === 'delay') {
    return makeDelayNodeHandler(node, ctx);
  }
  if (node.kind === 'imageGen') {
    return makeImageGenNodeHandler(node, ctx);
  }
  if (node.kind === 'vectorize') {
    return makeVectorizeNodeHandler(node, ctx);
  }
  if (node.kind === 'vectorSearch') {
    return makeVectorSearchNodeHandler(node, ctx);
  }
  if (node.kind === 'database') {
    return makeDatabaseNodeHandler(node, ctx);
  }
  if (node.kind === 'excelRead') {
    return makeExcelReadNodeHandler(node, ctx);
  }
  if (node.kind === 'excelWrite') {
    return makeExcelWriteNodeHandler(node, ctx);
  }
  if (node.kind === 'csvRead') {
    return makeCsvReadNodeHandler(node, ctx);
  }
  if (node.kind === 'csvWrite') {
    return makeCsvWriteNodeHandler(node, ctx);
  }
  if (node.kind === 'variable') {
    return makeVariableNodeHandler(node, ctx);
  }
  if (node.kind === 'aggregate') {
    return makeAggregateNodeHandler(node, ctx);
  }
  if (node.kind === 'email') {
    return makeEmailNodeHandler(node, ctx);
  }
  if (node.kind === 'merge') {
    return makeMergeNodeHandler(node, ctx);
  }
  if (!isLlmNode(node)) {
    return makeCodeNodeHandler(node, ctx);
  }
  return async (state) => {
    const startedAt = Date.now();
    let prompt = node.prompt;
    try {
      prompt = renderNodePrompt(node.prompt, {
        inputs: state.inputs,
        nodes: state.nodes,
        now: ctx.now,
      });
      const done = await runNodeWithRetry(node, ctx, prompt);
      await writeNodeRecord(ctx, node, prompt, done.output, startedAt, done);
      ctx.trace.push(traceSuccess(node, startedAt, done));
      return toNodeUpdate(node.id, done);
    } catch (e) {
      const failure = toNodeFailure(node, e);
      // 异常处理方式=默认值：重试耗尽仍失败 → 以 errorOutput 作为节点
      // 输出继续下游（trace 带 fallback 标记，运行历史可辨降级原因；
      // branch 节点降级不写 route，条件边回落 __fallback__→END）。图中止
      // （用户中断/退出）不降级——中断意图优先于容错继续
      if (node.onError === 'defaultValue' && !ctx.abort.aborted) {
        const output = node.errorOutput ?? '';
        const fallback = { code: failure.code, message: failure.message };
        await writeNodeRecord(ctx, node, prompt, output, startedAt, {
          fallback,
        });
        ctx.trace.push({
          ...traceSuccess(node, startedAt, { output }),
          fallback,
        });
        return toNodeUpdate(node.id, { output });
      }
      await writeNodeFailureRecord(ctx, node, prompt, failure, startedAt);
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}

/** llm 节点执行超时重试间隔（与 HTTP 节点同款固定间隔） */
const LLM_RETRY_INTERVAL_MS = 500;

/** 易抖节点（code/database/email）失败重试：固定 0.5s 间隔（对齐 http/
 * llm 语义）；语义性失败（GraphNodeFailure）重试无益直接上抛 */
async function retryAsync<T>(
  fn: () => Promise<T>,
  retries: number,
): Promise<T> {
  const attempts = (retries ?? 0) + 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof GraphNodeFailure) {
        throw e;
      }
      lastError = e;
      if (attempt < attempts) {
        await new Promise((resolve) =>
          setTimeout(resolve, LLM_RETRY_INTERVAL_MS),
        );
      }
    }
  }
  throw lastError;
}

/** llm 节点调用：整体执行超时（含重试全程，对照 Coze「整体执行超时」）
 * + 失败重试（调用/超时/解析失败；GraphRunFailure 配置类错误重试无益
 * 直接上抛）。超时（signal 触发且非图中止）归一为 llm_timeout */
async function runNodeWithRetry(
  node: LlmNode,
  ctx: NodeContext,
  prompt: string,
): Promise<NodeOutput> {
  const signal = AbortSignal.any([
    ctx.abort,
    AbortSignal.timeout(node.timeoutMs ?? 180_000),
  ]);
  const attempts = (node.retries ?? 0) + 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await runNode(node, ctx, prompt, signal);
    } catch (e) {
      if (e instanceof GraphRunFailure) {
        throw e;
      }
      if (signal.aborted && !ctx.abort.aborted) {
        throw new GraphNodeFailure(
          node.id,
          'llm_timeout',
          `模型调用超时（${Math.round((node.timeoutMs ?? 180_000) / 1000)}s）`,
        );
      }
      lastError = e;
      if (attempt < attempts) {
        await new Promise((resolve) =>
          setTimeout(resolve, LLM_RETRY_INTERVAL_MS),
        );
      }
    }
  }
  throw lastError;
}

function toNodeUpdate(
  nodeId: string,
  done: NodeOutput,
): Partial<GraphRunState> {
  return {
    nodes: {
      [nodeId]: {
        output: done.output,
        ...(done.errorOutput !== undefined
          ? { errorOutput: done.errorOutput }
          : {}),
        usage: done.usage,
      },
    },
    ...(done.route ? { route: done.route } : {}),
  };
}

async function runNode(
  node: LlmNode,
  ctx: NodeContext,
  prompt: string,
  signal: AbortSignal,
): Promise<NodeOutput> {
  const model = await modelFor(ctx, node);
  if (node.tools) {
    return await runToolNode(node, ctx, model, prompt, signal);
  }
  return await runPlainNode(node, ctx, model, prompt, signal);
}

/** 无工具节点：branch 走 JSON 提示词 + 响应解析（单一受测路径——
 * withStructuredOutput 依赖模型实例方法形态，协议差异大且 mock 不可覆盖） */
async function runPlainNode(
  node: LlmNode,
  ctx: NodeContext,
  model: ReturnType<typeof createChatModel>,
  prompt: string,
  signal: AbortSignal,
): Promise<NodeOutput> {
  const options = node.branchOptions ?? [];
  const raw = await model.invoke(
    nodeMessages(node, promptWithBranch(node, prompt, options)),
    { signal },
  );
  const usage = extractTokenUsage(raw);
  if (node.outputMode !== 'branch') {
    return { output: extractText(raw), usage };
  }
  return branchOutcome(node, raw, options, usage);
}

/** branch 节点提示词后缀：约束模型输出可解析 JSON（给模型看，不进 i18n） */
function branchPrompt(prompt: string, options: string[]): string {
  return `${prompt}\n\n请只输出一个 JSON 对象 {"branch": "<选项>"}，选项取值：${options.join(' | ')}，不要输出任何其他内容。`;
}

/** 节点提示词终稿：branch 模式追加选项约束（tools/plain 两类节点同款拼装） */
function promptWithBranch(
  node: LlmNode,
  prompt: string,
  options: string[],
): string {
  return node.outputMode === 'branch' ? branchPrompt(prompt, options) : prompt;
}

/** branch 节点终局解析（tools/plain 共用失败语义）：不合选项 →
 * branch_parse_error 节点失败；命中则 output=route=标签 */
function branchOutcome(
  node: LlmNode,
  raw: unknown,
  options: string[],
  usage: NodeResult['usage'] | undefined,
): NodeOutput {
  const label = extractBranchLabel(raw, options, node.id);
  return { output: label, route: label, usage };
}

function nodeMessages(node: LlmNode, prompt: string) {
  return [
    ...(node.systemPrompt ? [new SystemMessage(node.systemPrompt)] : []),
    new HumanMessage(prompt),
  ];
}

/** tools 节点（spec §4 失败语义）：工具软失败经 onToolCall 记摘要，
 * 节点失败仅限 LLM 调用失败/达 maxSteps（recursionLimit 兜底）。
 * outputMode=branch 与无工具节点同款：提示词追加选项约束，终局
 * AIMessage 经 extractBranchLabel 解标签写 state.route（工具步产出
 * 不参与分支判定）；不合选项 → branch_parse_error 节点失败 */
async function runToolNode(
  node: LlmNode,
  ctx: NodeContext,
  model: ReturnType<typeof createChatModel>,
  prompt: string,
  signal: AbortSignal,
): Promise<NodeOutput> {
  const toolCalls: NonNullable<TraceEntry['toolCalls']> = [];
  const mark = { at: Date.now() };
  const defs = filterNodeTools(
    await collectTools(ctx.workspacePath, ctx.skills, ctx.disabledTools),
    node.tools,
  );
  const tools = ctx.deps.toLangChainTools(defs, ctx.agent, {
    // 工具步同样受节点超时约束（正在执行的工具随 signal 中断），
    // 与 LLM 调用同口径。onToolCall（mirror 适配器钩子）在 server 适配器
    // 无此面（授权面 8）——经 onChunk 的 tool-update 终态投影等价记录
    // （done=成功，denied/error=失败）
    abortSignal: AbortSignal.any([ctx.abort, signal]),
    onChunk: (chunk) => {
      if (
        chunk.type === 'tool-update' &&
        (chunk.state === 'done' ||
          chunk.state === 'denied' ||
          chunk.state === 'error')
      ) {
        trackToolCall(
          toolCalls,
          { name: chunk.toolName, ok: chunk.state === 'done' },
          mark,
        );
      }
    },
  });
  const options = node.branchOptions ?? [];
  const agent = createReactAgent({
    llm: model,
    tools,
    ...(node.systemPrompt ? { prompt: node.systemPrompt } : {}),
  });
  const result = await agent.invoke(
    { messages: nodeMessages(node, promptWithBranch(node, prompt, options)) },
    { recursionLimit: node.maxSteps ?? DEFAULT_AGENT_STEPS, signal },
  );
  const final = lastAgentMessage(result);
  const usage = extractTokenUsage(final);
  if (node.outputMode !== 'branch') {
    return { output: extractText(final), usage, toolCalls };
  }
  return { ...branchOutcome(node, final, options, usage), toolCalls };
}

/** node.tools 白名单（true=全部注入工具；数组=按名过滤） */
function filterNodeTools(
  defs: Awaited<ReturnType<typeof collectTools>>,
  tools: LlmNode['tools'],
) {
  return tools === true
    ? defs
    : defs.filter((def) => (tools as string[]).includes(def.name));
}

/** 代码节点解释器映射（python 缺省 python，节点 pythonCommand 可切
 * python3；无内嵌运行时，缺装报 interpreter_missing 引导） */
const INTERPRETERS: Record<CodeNode['language'], string> = {
  nodejs: 'node',
  python: 'python',
  bash: 'bash',
};

const SCRIPT_SUFFIX: Record<CodeNode['language'], string> = {
  nodejs: 'mjs',
  python: 'py',
  bash: 'sh',
};

/** 代码输出收集上限（stdout/stderr 各自），超出丢弃防撑爆 DB/渲染层 */
const CODE_OUTPUT_LIMIT = 64 * 1024;

interface CodeRunOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  aborted: boolean;
  spawnErrorCode?: string;
}

/** 子进程结果 → 错误码（纯函数，测试覆盖全分支）；成功返回 null */
export function classifyCodeFailure(outcome: {
  timedOut?: boolean;
  spawnErrorCode?: string;
  aborted?: boolean;
  exitCode?: number;
}): string | null {
  if (outcome.timedOut) {
    return 'code_timeout';
  }
  if (outcome.spawnErrorCode === 'ENOENT') {
    return 'interpreter_missing';
  }
  if (outcome.aborted) {
    return 'aborted';
  }
  if ((outcome.exitCode ?? 0) !== 0) {
    return 'code_exit_nonzero';
  }
  return null;
}

/** 代码节点 handler：模板替换（复用 renderNodePrompt，{{input.x}}/
 * {{nodes.*.output}} 零学习成本）→ 解释器过 commandGate（无人值守 ask 即拒，
 * 与 run_command 同语义）→ 临时文件 spawn（避开 -c 注入面）→ stdout 即
 * 节点 output（branch 模式末行作路由标签）；stdin 注入完整 {inputs,
 * nodes} JSON 供脚本自行解析 */
function makeCodeNodeHandler(node: CodeNode, ctx: NodeContext): NodeHandler {
  return async (state) => {
    const startedAt = Date.now();
    let script = node.script;
    try {
      script = renderNodePrompt(node.script, {
        inputs: state.inputs,
        nodes: state.nodes,
        now: ctx.now,
      });
      const stdout = await retryAsync(
        () => runCodeScript(node, ctx, script, state),
        node.retries,
      );
      const done: NodeOutput =
        node.outputMode === 'branch'
          ? codeBranchOutcome(node, stdout)
          : { output: stdout };
      await writeNodeRecord(ctx, node, script, done.output, startedAt);
      ctx.trace.push(traceSuccess(node, startedAt, done));
      return toNodeUpdate(node.id, done);
    } catch (e) {
      const failure = toNodeFailure(node, e);
      await writeNodeFailureRecord(ctx, node, script, failure, startedAt);
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}

/** code 分支节点终局解析：stdout 最后一个非空行须精确命中 branchOptions
 * （脚本输出可控，不做 LLM 式宽松解析——echo 标签即路由）；未命中 →
 * branch_parse_error 节点失败。output=标签，与 llm 分支节点同语义 */
export function codeBranchOutcome(
  node: Pick<CodeNode, 'id' | 'branchOptions'>,
  stdout: string,
): NodeOutput {
  const options = node.branchOptions ?? [];
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const label = lines[lines.length - 1] ?? '';
  if (!options.includes(label)) {
    throw new GraphNodeFailure(
      node.id,
      'branch_parse_error',
      `stdout 末行不在分支选项内: ${label.slice(0, 100)}`,
    );
  }
  return { output: label, route: label };
}

/** HTTP 响应体收集上限（对齐 code 节点 stdout 上限，防撑爆 DB/渲染层） */
const HTTP_OUTPUT_LIMIT = 64 * 1024;

/** bodyType → 缺省 Content-Type（headers 显式指定则不覆盖） */
const HTTP_BODY_CONTENT_TYPE: Record<
  Exclude<HttpNode['bodyType'], 'none'>,
  string
> = {
  json: 'application/json',
  text: 'text/plain',
  form: 'application/x-www-form-urlencoded',
  // binary 由用户显式设精确类型（如 image/png），缺省兜底流式八进制
  binary: 'application/octet-stream',
};

/** binary 请求体文件大小上限（防误读巨型文件撑爆内存/请求） */
const HTTP_BINARY_LIMIT = 10 * 1024 * 1024;

/** 失败重试固定间隔（网络失败/非 2xx 均重试，Coze 同款简化语义） */
const HTTP_RETRY_INTERVAL_MS = 500;

/** HTTP 节点 handler（参照 Coze HTTP 节点）：url/headers/query/body 全量
 * 模板替换（{{input.x}}/{{nodes.*.output}}，与 llm/code 同一套）→ fetch
 * （超时与图中止信号任一触发即断开）→ 响应体文本（截 64KB）即节点
 * output；非 2xx → http_status_error；网络层失败 → http_request_failed；
 * 失败按 retries 重试（固定间隔） */
function makeHttpNodeHandler(node: HttpNode, ctx: NodeContext): NodeHandler {
  return async (state) => {
    const startedAt = Date.now();
    try {
      const output = await runHttpRequest(node, ctx, state);
      await writeNodeRecord(
        ctx,
        node,
        `${node.method} ${node.url}`,
        output,
        startedAt,
      );
      ctx.trace.push(traceSuccess(node, startedAt, { output }));
      return toNodeUpdate(node.id, { output });
    } catch (e) {
      const failure = toNodeFailure(node, e);
      await writeNodeFailureRecord(
        ctx,
        node,
        `${node.method} ${node.url}`,
        failure,
        startedAt,
      );
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}

async function runHttpRequest(
  node: HttpNode,
  ctx: NodeContext,
  state: { inputs: Record<string, string>; nodes: Record<string, NodeResult> },
): Promise<string> {
  const attempts = (node.retries ?? 0) + 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchOnce(node, ctx, state);
    } catch (e) {
      lastError = e;
      if (attempt < attempts) {
        await new Promise((resolve) =>
          setTimeout(resolve, HTTP_RETRY_INTERVAL_MS),
        );
      }
    }
  }
  throw lastError;
}

async function fetchOnce(
  node: HttpNode,
  ctx: NodeContext,
  state: { inputs: Record<string, string>; nodes: Record<string, NodeResult> },
): Promise<string> {
  const render = (text: string) =>
    renderNodePrompt(text, {
      inputs: state.inputs,
      nodes: state.nodes,
      now: ctx.now,
    });
  const url = withQueryParams(
    render(node.url),
    node.query.map((kv) => ({ key: kv.key, value: render(kv.value) })),
  );
  const headers: Record<string, string> = {};
  for (const kv of node.headers) {
    headers[kv.key] = render(kv.value);
  }
  // 鉴权注入（显式配置优先，覆盖同名头）；凭据支持模板占位符。
  // acs3 需要完整请求（URL/body）参与签名，延后到 body 构造后注入
  const auth = node.auth;
  if (auth.type !== 'acs3') {
    applyHttpAuth(headers, auth, render);
  }
  let body: string | Uint8Array | undefined;
  if (node.bodyType !== 'none' && (node.body ?? '') !== '') {
    const raw = render(node.body ?? '');
    if (node.bodyType === 'binary') {
      // Buffer → Uint8Array 视图（共享内存零拷贝，落进 fetch BodyInit 类型）
      body = new Uint8Array(await readBinaryBody(node.id, raw, ctx));
    } else {
      body = raw;
    }
    const hasContentType = Object.keys(headers).some(
      (name) => name.toLowerCase() === 'content-type',
    );
    if (!hasContentType) {
      headers['Content-Type'] = HTTP_BODY_CONTENT_TYPE[node.bodyType];
    }
  }
  // ACS3 签名在 body/content-type 就绪后注入：自动补 x-acs-date/nonce/
  // content-sha256，签名写进 auth.authHeader（默认 Authorization，可改）
  if (auth.type === 'acs3') {
    const { signAcs3 } = await import('./acs3-sign');
    const signed = signAcs3({
      method: node.method,
      url: new URL(url),
      headers,
      body: body ?? '',
      accessKeyId: render(auth.accessKeyId),
      accessKeySecret: render(auth.accessKeySecret),
      headerPrefix: render(auth.headerPrefix),
      algorithm: render(auth.algorithm),
    });
    Object.assign(headers, signed.headers);
  }
  const init: RequestInit = {
    method: node.method,
    headers,
    signal: AbortSignal.any([
      ctx.abort,
      AbortSignal.timeout(node.timeoutMs ?? 120_000),
    ]),
  };
  if (body !== undefined && node.method !== 'GET') {
    // TS TypedArray 泛型差异（Uint8Array<ArrayBufferLike> 不协变
    // BodyInit 的 <ArrayBuffer>）；运行时 fetch 完全接受，显式收口
    init.body = body as BodyInit;
  }
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (e) {
    throw new GraphNodeFailure(
      node.id,
      'http_request_failed',
      `请求失败: ${errorMessage(e)}`,
      errorDetailOf(e),
    );
  }
  const text = await response.text();
  if (!response.ok) {
    throw new GraphNodeFailure(
      node.id,
      'http_status_error',
      `HTTP ${response.status}: ${text.slice(0, 200)}`,
      // 响应体全貌进 detail（错误页/网关诊断信息常超 200 字摘要）
      text !== '' ? clipDetail(text) : undefined,
    );
  }
  return text.length > HTTP_OUTPUT_LIMIT
    ? text.slice(0, HTTP_OUTPUT_LIMIT)
    : text;
}

/** 鉴权头注入（headers 合并后调用 → 显式鉴权配置覆盖同名头） */
function applyHttpAuth(
  headers: Record<string, string>,
  auth: HttpNode['auth'],
  render: (text: string) => string,
): void {
  if (auth.type === 'none') {
    return;
  }
  if (auth.type === 'basic') {
    const encoded = Buffer.from(
      `${render(auth.user)}:${render(auth.password)}`,
    ).toString('base64');
    headers.Authorization = `Basic ${encoded}`;
    return;
  }
  if (auth.type === 'bearer') {
    headers.Authorization = `Bearer ${render(auth.token)}`;
    return;
  }
  if (auth.type === 'acs3') {
    return; // fetchOnce 内 body 就绪后统一签名注入
  }
  headers[render(auth.name)] = render(auth.value);
}

/** binary 请求体：body 为文件路径，限「工作空间 ∪ 应用 workflow-assets」
 * 两根内（fileRead 同款授权边界；workflow-assets 承载 imageGen 产物供
 * 直传，不要求绑定工作空间），读 Buffer 上传（10MB 上限） */
async function readBinaryBody(
  nodeId: string,
  rawPath: string,
  ctx: NodeContext,
): Promise<Buffer> {
  const assetsRoot = graphExecutorRuntime().workflowAssetsDir();
  const resolved = path.isAbsolute(rawPath)
    ? rawPath
    : ctx.workspacePath
      ? path.resolve(ctx.workspacePath, rawPath)
      : null;
  const inAssets =
    resolved !== null &&
    (resolved === assetsRoot ||
      resolved.startsWith(`${assetsRoot}${path.sep}`));
  const inWorkspace =
    resolved !== null &&
    ctx.workspacePath !== undefined &&
    (resolved === ctx.workspacePath ||
      resolved.startsWith(`${ctx.workspacePath}${path.sep}`));
  if (!inAssets && !inWorkspace) {
    if (resolved === null) {
      throw new GraphNodeFailure(
        nodeId,
        'file_workspace_missing',
        '未绑定工作空间目录，binary 请求体的相对路径不可用',
      );
    }
    throw new GraphNodeFailure(
      nodeId,
      'http_body_outside_workspace',
      `请求体文件越界（仅可读工作空间与应用产物目录内文件）: ${rawPath}`,
    );
  }
  let content: Buffer;
  try {
    content = await readFile(resolved);
  } catch (e) {
    throw new GraphNodeFailure(
      nodeId,
      'http_body_file_missing',
      `请求体文件不可读: ${resolved} (${errorMessage(e)})`,
    );
  }
  if (content.length > HTTP_BINARY_LIMIT) {
    throw new GraphNodeFailure(
      nodeId,
      'http_body_too_large',
      `请求体文件超过 10MB 上限: ${resolved}`,
    );
  }
  return content;
}

/** query 键值对拼进 URL（保留原 query string，值做 URL 编码） */
export function withQueryParams(url: string, query: HttpKV[]): string {
  if (query.length === 0) {
    return url;
  }
  const qs = query
    .map(
      (kv) => `${encodeURIComponent(kv.key)}=${encodeURIComponent(kv.value)}`,
    )
    .join('&');
  return url.includes('?') ? `${url}&${qs}` : `${url}?${qs}`;
}

async function runCodeScript(
  node: CodeNode,
  ctx: NodeContext,
  script: string,
  state: { inputs: Record<string, string>; nodes: Record<string, NodeResult> },
): Promise<string> {
  // python 命令节点级可配（pythonCommand，缺省 python）；?? 兜底防
  // 调用方绕过 schema parse 直构节点对象
  const interpreter =
    node.language === 'python'
      ? node.pythonCommand ?? 'python'
      : INTERPRETERS[node.language];
  const decision = commandGate(interpreter);
  if (decision === 'block' || decision === 'ask') {
    throw new GraphNodeFailure(
      node.id,
      'code_command_blocked',
      `解释器被命令安全策略禁止: ${interpreter}`,
    );
  }
  // 权限模式门（评审 I-1）：代码节点等价 write 类操作——default 任务的
  // default 决策不放行（对齐 run_command 无人值守审批拒绝语义），仅
  // 命令门显式 allow 名单或已授权上下文（试运行/full 任务）可执行
  if (decision !== 'allow' && !ctx.codeAuthorized) {
    throw new GraphNodeFailure(
      node.id,
      'code_permission_denied',
      '代码节点需要任务开启「允许完全访问」，或在设置-安全中心命令名单放行解释器（bash/python/node）——放行脚本内命令（如 git）无效，脚本以解释器整段执行',
    );
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tianshu-code-'));
  const file = path.join(dir, `script.${SCRIPT_SUFFIX[node.language]}`);
  try {
    await writeFile(file, script, 'utf-8');
    const outcome = await execScript(interpreter, file, {
      cwd: ctx.workspacePath ?? os.tmpdir(),
      timeoutMs: node.timeoutMs ?? 30_000,
      signal: ctx.abort,
      stdin: JSON.stringify({ inputs: state.inputs, nodes: state.nodes }),
    });
    const code = classifyCodeFailure(outcome);
    if (code) {
      const message =
        code === 'interpreter_missing'
          ? `解释器未安装或不可用: ${interpreter}`
          : `${interpreter} 退出异常（exit=${outcome.exitCode}）`;
      throw new GraphNodeFailure(
        node.id,
        code,
        message,
        // 完整 stderr 进 detail（trace/消息可查全貌；收集上限 64KB）
        outcome.stderr !== '' ? clipDetail(outcome.stderr) : undefined,
      );
    }
    return outcome.stdout;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function execScript(
  interpreter: string,
  file: string,
  opts: { cwd: string; timeoutMs: number; signal: AbortSignal; stdin: string },
): Promise<CodeRunOutcome> {
  return new Promise((resolve) => {
    const outcome: CodeRunOutcome = {
      stdout: '',
      stderr: '',
      exitCode: -1,
      timedOut: false,
      aborted: false,
    };
    // detached + 进程组击杀：脚本解释器（bash 等）会 fork 子进程，单杀
    // 主进程后孤儿持有 stdio 管道，close 要等孤儿童自然退出——超时/中止
    // 必须杀整组（win32 无负 pid，退回单杀）
    const child = spawn(interpreter, [file], {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const killGroup = () => {
      if (process.platform === 'win32' || !child.pid) {
        child.kill('SIGKILL');
        return;
      }
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const settle = () => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', killGroup);
    };
    const timer = setTimeout(() => {
      outcome.timedOut = true;
      killGroup();
    }, opts.timeoutMs);
    opts.signal.addEventListener('abort', killGroup, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (outcome.stdout.length < CODE_OUTPUT_LIMIT) {
        outcome.stdout += chunk.toString();
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (outcome.stderr.length < CODE_OUTPUT_LIMIT) {
        outcome.stderr += chunk.toString();
      }
    });
    // 子进程先死（超时击杀/解释器缺失）后写 stdin 触发 EPIPE——流错误
    // 无监听器会升级为进程级未捕获异常，全部吞掉（结果经 close 归口）
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream?.on('error', () => {});
    }
    child.on('error', (err: NodeJS.ErrnoException) => {
      settle();
      outcome.spawnErrorCode = err.code;
      if (opts.signal.aborted) {
        outcome.aborted = true;
      }
      resolve(outcome);
    });
    child.on('close', (code) => {
      settle();
      outcome.exitCode = code ?? -1;
      outcome.aborted = opts.signal.aborted;
      resolve(outcome);
    });
    child.stdin?.end(opts.stdin);
  });
}

/** 适配器只回调完成时刻，durationMs 为上次事件以来的近似值
 * （首次含模型思考间隔）——工具级精度需适配器补 start 事件，v1 从简 */
function trackToolCall(
  toolCalls: NonNullable<TraceEntry['toolCalls']>,
  call: { name: string; ok: boolean },
  mark: { at: number },
): void {
  const durationMs = Date.now() - mark.at;
  mark.at = Date.now();
  toolCalls.push({ name: call.name, ok: call.ok, durationMs });
}

function lastAgentMessage(result: unknown): unknown {
  const messages = (result as { messages?: unknown[] })?.messages;
  return Array.isArray(messages) && messages.length > 0
    ? messages[messages.length - 1]
    : result;
}

async function modelFor(
  ctx: NodeContext,
  node: { modelId: number; temperature?: number },
): Promise<ReturnType<typeof createChatModel>> {
  const runtime = await resolveModelRuntime(ctx, node.modelId);
  return ctx.deps.createChatModel(runtime.provider, runtime.sdkId, {
    temperature: node.temperature,
  });
}

/** 节点模型解析缓存（同图多节点共模型只查一次；anthropic 空 apiKey
 * 构造即抛由 handler 的 toNodeFailure 兜住映射节点失败） */
function resolveModelRuntime(
  ctx: NodeContext,
  modelId: number,
): Promise<ModelRuntime> {
  const cached = ctx.modelCache.get(modelId);
  if (cached) {
    return cached;
  }
  const promise = loadModelRuntime(modelId);
  ctx.modelCache.set(modelId, promise);
  return promise;
}

async function loadModelRuntime(modelId: number): Promise<ModelRuntime> {
  const db = graphExecutorRuntime().db;
  const modelRow = await db.model.findUnique({ where: { id: modelId } });
  const providerRow = modelRow
    ? await db.provider.findUnique({ where: { id: modelRow.providerId } })
    : null;
  if (!modelRow || !providerRow) {
    throw new GraphRunFailure(
      'model_missing',
      `节点模型或服务商不存在: ${modelId}`,
    );
  }
  return {
    provider: {
      type: providerRow.type,
      baseUrl: providerRow.baseUrl,
      apiKey: providerRow.apiKey ?? undefined,
      extraHeaders: providerRow.extraHeaders,
    },
    sdkId: modelRow.modelId,
  };
}

/** AI 润色提示词（编辑器「润色」钮，spec 外轻量能力）：用指定模型改写，
 * 硬约束 {{...}} 变量占位符逐字保留（运行期替换依赖）；异常原样上抛
 * （IPC 层转 message，前端 toast）；只返回润色文本，采用与否前端裁定 */
export async function polishNodePrompt(
  modelId: number,
  prompt: string,
): Promise<string> {
  const runtime = await loadModelRuntime(modelId);
  const model = defaultDeps.createChatModel(runtime.provider, runtime.sdkId);
  const raw = await model.invoke([
    new SystemMessage(
      '你是提示词工程师。改写用户的提示词，保持原意与原语言（中文），' +
        '指令更清晰、结构更完整、任务要求更具体可执行。' +
        '其中的 {{...}} 变量占位符必须逐字保留、不得增删改。' +
        '只输出改写后的提示词本身，不要任何解释或前后缀。',
    ),
    new HumanMessage(prompt),
  ]);
  return extractText(raw).trim();
}

/** LangChain AIMessage usage_metadata（input_tokens/output_tokens）→
 * run/trace 口径；openai 兼容协议另读 response_metadata.usage 兜底，
 * 均缺席则省略（不硬造） */
function extractTokenUsage(raw: unknown): NodeResult['usage'] | undefined {
  const meta = (
    raw as {
      usage_metadata?: { input_tokens: number; output_tokens: number };
    }
  )?.usage_metadata;
  if (meta && typeof meta.input_tokens === 'number') {
    return {
      promptTokens: meta.input_tokens,
      completionTokens: meta.output_tokens,
    };
  }
  const usage = (
    raw as {
      response_metadata?: {
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
    }
  )?.response_metadata?.usage;
  if (usage && typeof usage.prompt_tokens === 'number') {
    return {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens ?? 0,
    };
  }
  return undefined;
}

/** AIMessage content → 纯文本（string / 分块数组归并） */
function extractText(raw: unknown): string {
  const content = contentOf(raw);
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(textPartOf).filter(Boolean).join('\n');
  }
  return content == null ? '' : String(content);
}

function contentOf(raw: unknown): unknown {
  return raw && typeof raw === 'object' && 'content' in raw
    ? (raw as { content: unknown }).content
    : raw;
}

function textPartOf(part: unknown): string {
  if (typeof part === 'string') {
    return part;
  }
  const text = (part as { text?: unknown })?.text;
  return typeof text === 'string' ? text : '';
}

/** branch 结果 → 选项标签：兼容裸枚举串 / JSON 串 / 对象字段三种形态
 * （真实模型 content 为 JSON 串，结构化直返对象亦可）；全部不合 →
 * branch_parse_error */
function extractBranchLabel(
  raw: unknown,
  options: string[],
  nodeId: string,
): string {
  for (const candidate of labelCandidates(raw)) {
    const label = matchLabel(candidate, options);
    if (label) {
      return label;
    }
  }
  throw new GraphNodeFailure(
    nodeId,
    'branch_parse_error',
    `结构化输出不合选项: ${previewOf(raw)}`,
  );
}

function labelCandidates(raw: unknown): string[] {
  if (typeof raw === 'string') {
    return [raw];
  }
  const own = Object.values((raw ?? {}) as Record<string, unknown>).filter(
    (v): v is string => typeof v === 'string',
  );
  const content = contentOf(raw);
  return [
    ...own,
    ...(typeof content === 'string' ? [content] : []),
    ...(Array.isArray(content) ? content.map(textPartOf) : []),
  ];
}

function matchLabel(candidate: string, options: string[]): string | null {
  const trimmed = candidate.trim();
  if (options.includes(trimmed)) {
    return trimmed;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'string' && options.includes(parsed)) {
      return parsed;
    }
    const hit = Object.values(parsed as Record<string, unknown>).find(
      (v) => typeof v === 'string' && options.includes(v),
    );
    if (typeof hit === 'string') {
      return hit;
    }
  } catch {
    // 非 JSON 候选：留待下一个
  }
  return options.length === 0 && trimmed ? trimmed : null;
}

function previewOf(raw: unknown): string {
  try {
    return JSON.stringify(raw)?.slice(0, 200) ?? String(raw);
  } catch {
    return String(raw);
  }
}

/** 节点执行详情落库（去会话化 2026-10-28）：Coze 式运行记录——节点
 * 完整输入/输出落 graphRunNode（单节点测试 runId=null 不落，对齐 Coze
 * 即席试跑）；input/output 截 64KB 对齐 code 节点输出上限 */
const NODE_IO_LIMIT = 64 * 1024;
const clipNodeIo = (text: string) => text.slice(0, NODE_IO_LIMIT);

interface NodeRecordExtra {
  usage?: { promptTokens: number; completionTokens: number };
  toolCalls?: Array<{ name: string; ok: boolean; durationMs: number }>;
  outputImage?: string;
  fallback?: { code: string; message: string };
  errorOutput?: string;
}

function nodeRecordData(
  ctx: NodeContext,
  node: GraphNode,
  status: 'success' | 'failed',
  input: string,
  output: string,
  startedAt: number,
  extra: NodeRecordExtra,
) {
  return {
    runId: ctx.runId as number,
    nodeId: node.id,
    nodeName: node.name,
    status,
    input: clipNodeIo(input),
    output: clipNodeIo(output),
    toolCallsJson: extra.toolCalls ? JSON.stringify(extra.toolCalls) : null,
    promptTokens: extra.usage?.promptTokens,
    completionTokens: extra.usage?.completionTokens,
    durationMs: Date.now() - startedAt,
    startedAt: new Date(startedAt).toISOString(),
    outputImage: extra.outputImage,
    errorOutput: extra.errorOutput ? clipNodeIo(extra.errorOutput) : null,
    fallbackJson: extra.fallback ? JSON.stringify(extra.fallback) : null,
  };
}

/** (runId, nodeId) 复合唯一键 upsert 载体：create/update 同 data 全量覆盖
 * （失败行附加 errorJson） */
function upsertNodeRecord(
  ctx: NodeContext,
  data: ReturnType<typeof nodeRecordData> & { errorJson?: string },
): Promise<unknown> {
  return graphExecutorRuntime().db.graphRunNode.upsert({
    where: { runId_nodeId: { runId: data.runId, nodeId: data.nodeId } },
    create: data,
    update: data,
  });
}

/** 节点成功详情落 graphRunNode；环图重入 upsert 覆盖（最后一轮为准）：
 * validateGraph 不查回边，条件回边下同节点多轮执行 create 撞
 * (runId, nodeId) 唯一约束——聚合一行，每轮全量覆盖 */
async function writeNodeRecord(
  ctx: NodeContext,
  node: GraphNode,
  input: string,
  output: string,
  startedAt: number,
  extra: NodeRecordExtra = {},
): Promise<void> {
  if (ctx.runId === null) return; // 单节点测试即席，不留痕
  await upsertNodeRecord(
    ctx,
    nodeRecordData(ctx, node, 'success', input, output, startedAt, extra),
  );
}

/** 节点失败落 graphRunNode：output=失败全貌（code: message + detail），
 * errorJson 同 trace error 形状（GraphNodeFailure 无 toolName 归属，
 * 该键缺省——trace error 同款可选字段）；环图重入 upsert 覆盖（最后一轮
 * 为准），同 writeNodeRecord */
async function writeNodeFailureRecord(
  ctx: NodeContext,
  node: GraphNode,
  input: string,
  failure: GraphNodeFailure,
  startedAt: number,
): Promise<void> {
  if (ctx.runId === null) return; // 单节点测试即席，不留痕
  const summary = `${failure.code}: ${failure.message}`;
  const output = failure.detail
    ? `${summary}\n【详情】\n${failure.detail}`
    : summary;
  await upsertNodeRecord(ctx, {
    ...nodeRecordData(ctx, node, 'failed', input, output, startedAt, {}),
    errorJson: JSON.stringify({
      code: failure.code,
      message: failure.message,
      detail: failure.detail,
    }),
  });
}

function traceSuccess(
  node: GraphNode,
  startedAt: number,
  done: NodeOutput,
): TraceEntry {
  return {
    id: node.id,
    name: node.name,
    status: 'success',
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    ...(done.usage ? { tokens: done.usage } : {}),
    ...(done.toolCalls?.length ? { toolCalls: done.toolCalls } : {}),
    outputPreview: done.output.slice(0, 200),
    ...(done.outputImage ? { outputImage: done.outputImage } : {}),
    ...(done.errorOutput ? { errorOutput: done.errorOutput } : {}),
  };
}

function traceFailure(
  node: GraphNode,
  startedAt: number,
  failure: GraphNodeFailure,
): TraceEntry {
  return {
    id: node.id,
    name: node.name,
    status: 'failed',
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    error: {
      code: failure.code,
      message: failure.message.slice(0, 200),
      ...(failure.detail ? { detail: failure.detail } : {}),
    },
  };
}

/** 节点内异常 → GraphNodeFailure（错误码映射：模板缺引用/结构化不合/
 * 模型缺失/LLM 网络分类码） */
function toNodeFailure(node: GraphNode, e: unknown): GraphNodeFailure {
  if (e instanceof GraphNodeFailure) {
    return e;
  }
  if (e instanceof GraphTemplateError) {
    return new GraphNodeFailure(
      node.id,
      'template_ref_missing',
      `模板变量未定义: ${e.varName}`,
    );
  }
  if (e instanceof GraphRunFailure) {
    return new GraphNodeFailure(node.id, e.code, e.message);
  }
  return new GraphNodeFailure(
    node.id,
    classifyError(e),
    errorMessage(e),
    errorDetailOf(e),
  );
}

/** invoke 逃逸异常 → run 级错误（LangGraph 包 NodeError 时解包还原） */
function toRunError(e: unknown): RunError {
  if (e instanceof GraphRecursionError) {
    return { code: 'graph_recursion_limit', message: errorMessage(e) };
  }
  const inner = isNodeError(e) ? e.error : e;
  if (inner instanceof GraphNodeFailure) {
    return { code: inner.code, message: inner.message, nodeId: inner.nodeId };
  }
  if (inner instanceof GraphRunFailure) {
    return { code: inner.code, message: inner.message };
  }
  return { code: classifyError(inner), message: errorMessage(inner) };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 未执行节点补 skipped（spec §4：失败截断后剩余节点显式落 skipped；
 * 成功但被分支绕开的节点同样标注。start 是参数载体非执行节点，
 * 不补 skipped 条目（否则每张带 start 的图恒显一条噪音） */
function appendSkippedEntries(json: GraphJson, trace: TraceEntry[]): void {
  const executed = new Set(
    trace.filter((t) => t.status !== 'skipped').map((t) => t.id),
  );
  const skippedAt = new Date().toISOString();
  for (const node of json.nodes) {
    if (node.kind === 'start') {
      continue;
    }
    if (!executed.has(node.id)) {
      trace.push({
        id: node.id,
        name: node.name,
        status: 'skipped',
        startedAt: skippedAt,
        durationMs: 0,
      });
    }
  }
}

/** run 收尾（成功/失败同径）：graphTrace/durationMs/tokens/finishedAt
 * 全量落库，error 聚合 node:<id> <code>: <msg> 截 500（sessionId 列
 * 保留但 graph 路径不再写——去会话化 2026-10-28） */
async function finishRun(p: FinishParams): Promise<'success' | 'failed'> {
  const tokens = sumTokens(p.trace);
  // 监控埋点（spec §4.1 #4）：授权面 5——server 无 monitor 域，经运行时
  // 钩子注入（内部吞错不影响收尾；未注入跳过）
  graphExecutorRuntime().recordMonitorEvents?.({
    graphId: p.graphId,
    userId: p.task?.userId ?? p.userId ?? null,
    sessionId: null,
    trace: p.trace,
  });
  // run 行收尾落库走仓储原语（授权面 2）：终值由本函数计算自管，repo 只
  // 落库——行可能已被删除（在途删图先删 run），原语内部吞错记日志不向
  // 调用方抛（P2025 类预期冲突；外层兜底会把二次落库抛错误判为新失败）
  await graphExecutorRuntime().runs.finishRun({
    runId: p.runId,
    status: p.status,
    graphTrace: JSON.stringify(p.trace),
    error: p.error ? formatRunError(p.error) : null,
    durationMs: Date.now() - p.startedAt,
    promptTokens: tokens?.promptTokens,
    completionTokens: tokens?.completionTokens,
  });
  // 终态事件投影（授权面 7）：aborted = failed + user_aborted 的展示精化
  // （run 表单一状态源仍为 success|failed）
  publishRunUpdated({
    runId: p.runId,
    graphId: p.graphId,
    state:
      p.status === 'success'
        ? 'succeeded'
        : p.error?.code === 'user_aborted'
          ? 'aborted'
          : 'failed',
    ...(p.finalOutput !== undefined ? { output: p.finalOutput } : {}),
    ...(p.error ? { error: formatRunError(p.error) } : {}),
  });
  await advanceTaskAfterRun(p);
  return p.status;
}

function formatRunError(error: RunError): string {
  const text = error.nodeId
    ? `node:${error.nodeId} ${error.code}: ${error.message}`
    : `${error.code}: ${error.message}`;
  return text.slice(0, 500);
}

function sumTokens(
  trace: TraceEntry[],
): { promptTokens: number; completionTokens: number } | undefined {
  const entries = trace.filter((t) => t.tokens);
  if (entries.length === 0) {
    return undefined;
  }
  return entries.reduce(
    (acc, t) => ({
      promptTokens: acc.promptTokens + (t.tokens?.promptTokens ?? 0),
      completionTokens:
        acc.completionTokens + (t.tokens?.completionTokens ?? 0),
    }),
    { promptTokens: 0, completionTokens: 0 },
  );
}

/** 任务推进：model_missing 标异常停调度（automation-runner failRun 先例，
 * 系统级配置缺失重试无益）；其余复用 advanceTask（manual/event 内部直返） */
async function advanceTaskAfterRun(p: FinishParams): Promise<void> {
  if (!p.task) {
    return;
  }
  if (p.error?.code === 'model_missing') {
    await graphExecutorRuntime().db.automationTask.update({
      where: { id: p.task.id },
      data: { status: 'error', enabled: false, statusNote: 'model_missing' },
    });
    return;
  }
  await advanceTask(
    p.task,
    new Date(),
    p.status,
    // 子图执行 task 恒 null（上方早退），非空时必为任务级五类触发
    p.triggerType as Parameters<typeof advanceTask>[3],
  );
}

/** 文件读取上限：下游 prompt/输出皆文本，1MB 足够且防撑爆 DB/渲染层 */
const FILE_READ_LIMIT = 1024 * 1024;

/** 文件读取节点 handler：path 模板替换 → 限工作空间目录内（授权边界，
 * 相对/绝对都 resolve 后校验前缀，防 ../ 越界）→ utf-8 文本即 output */
function makeFileReadNodeHandler(
  node: FileReadNode,
  ctx: NodeContext,
): NodeHandler {
  return async (state) => {
    const startedAt = Date.now();
    try {
      const output = await runFileRead(node, ctx, state);
      await writeNodeRecord(ctx, node, node.path, output, startedAt);
      ctx.trace.push(traceSuccess(node, startedAt, { output }));
      return toNodeUpdate(node.id, { output });
    } catch (e) {
      const failure = toNodeFailure(node, e);
      await writeNodeFailureRecord(ctx, node, node.path, failure, startedAt);
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}

async function runFileRead(
  node: FileReadNode,
  ctx: NodeContext,
  state: { inputs: Record<string, string>; nodes: Record<string, NodeResult> },
): Promise<string> {
  const raw = renderNodePrompt(node.path, {
    inputs: state.inputs,
    nodes: state.nodes,
    now: ctx.now,
  });
  if (!ctx.workspacePath) {
    throw new GraphNodeFailure(
      node.id,
      'file_workspace_missing',
      '未绑定工作空间目录，文件读取节点须在绑定了目录的工作空间下执行',
    );
  }
  const resolved = path.resolve(ctx.workspacePath, raw);
  const inside =
    resolved === ctx.workspacePath ||
    resolved.startsWith(`${ctx.workspacePath}${path.sep}`);
  if (!inside) {
    throw new GraphNodeFailure(
      node.id,
      'file_outside_workspace',
      `路径越界（仅可读工作空间内文件）: ${raw}`,
    );
  }
  let content: string;
  try {
    content = await readFile(resolved, 'utf-8');
  } catch (e) {
    throw new GraphNodeFailure(
      node.id,
      'file_missing',
      `文件不可读: ${resolved} (${errorMessage(e)})`,
    );
  }
  if (Buffer.byteLength(content, 'utf-8') > FILE_READ_LIMIT) {
    throw new GraphNodeFailure(
      node.id,
      'file_too_large',
      `文件超过 1MB 上限: ${resolved}`,
    );
  }
  return content;
}

/** 通知节点 handler：title/body 模板替换后发系统桌面通知（发送失败仅
 * 记日志不炸节点——通知是尽力而为的提醒通道）；output 为标题+正文 */
function makeNotifyNodeHandler(
  node: NotifyNode,
  ctx: NodeContext,
): NodeHandler {
  return async (state) => {
    const startedAt = Date.now();
    const render = (text: string) =>
      renderNodePrompt(text, {
        inputs: state.inputs,
        nodes: state.nodes,
        now: ctx.now,
      });
    try {
      const title = render(node.title);
      const body = node.body ? render(node.body) : '';
      try {
        // 授权面 1：Electron Notification → 运行时 notify 钩子（无头端
        // 默认无通道；发送失败不炸节点——通知尽力而为语义保持）
        graphExecutorRuntime().notify?.(title, body === '' ? undefined : body);
      } catch (e) {
        logger.warn('桌面通知发送失败（节点继续）', node.id, e);
      }
      if (node.webhookProvider !== 'none' && node.webhookUrl.trim() !== '') {
        // IM webhook：失败仅记日志不炸节点（通知尽力而为，与桌面通知同语义）
        try {
          await sendNotifyWebhook(
            node.webhookProvider,
            render(node.webhookUrl),
            title,
            body,
            ctx.abort,
          );
        } catch (e) {
          logger.warn('IM webhook 发送失败（节点继续）', node.id, e);
        }
      }
      const output = body ? `${title}\n${body}` : title;
      await writeNodeRecord(ctx, node, title, output, startedAt);
      ctx.trace.push(traceSuccess(node, startedAt, { output }));
      return toNodeUpdate(node.id, { output });
    } catch (e) {
      const failure = toNodeFailure(node, e);
      await writeNodeFailureRecord(ctx, node, node.title, failure, startedAt);
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}

/** 子工作流/循环节点共用的子图执行：userId 隔离加载 → 循环引用拦截 →
 * 复用完整执行管线（run 归属子图，triggerType=subflow）→ 终点
 * output；子图失败抛 subflow_failed（详情见子图自身运行记录） */
/** 异步子工作流：fire-and-forget 提交（独立 AbortController——父流程
 * 结束/中止不波及子任务），结果只落子工作流运行历史；回执不含 runId
 * （run 行创建在后台，等它返回会退化成同步等待） */
async function launchAsyncSubflow(
  graphId: number,
  ctx: NodeContext,
  inputs: Record<string, string>,
): Promise<string> {
  void runSubflowGraph(
    'async',
    graphId,
    ctx,
    inputs,
    new AbortController().signal,
  ).catch((e) => {
    // runGraphToResult 已吞错落库；这里仅兜底防未处理拒绝
    logger.warn('异步子工作流异常（已落运行记录）', graphId, e);
  });
  return `已提交异步任务 #${graphId}（后台运行，详情见子工作流运行历史）`;
}

async function runSubflowGraph(
  nodeId: string,
  graphId: number,
  ctx: NodeContext,
  inputs: Record<string, string>,
  outerAbort?: AbortSignal,
): Promise<string> {
  if (ctx.subflowStack.includes(String(graphId))) {
    throw new GraphNodeFailure(
      nodeId,
      'subflow_cycle',
      `子工作流循环引用: ${graphId}`,
    );
  }
  const row = await graphExecutorRuntime().db.graphDefinition.findFirst({
    where: { id: graphId, userId: ctx.userId },
  });
  if (!row) {
    throw new GraphNodeFailure(
      nodeId,
      'subflow_missing',
      `子工作流不存在或不归当前用户: ${graphId}`,
    );
  }
  const result = await runGraphToResult({
    graph: row,
    task: null, // 子图不推进父任务调度（advanceTask 由父图收尾一次）
    inputs,
    triggerType: 'subflow',
    attempt: 1,
    abort: outerAbort ?? ctx.abort,
    workspace: ctx.workspace,
    disabledTools: ctx.disabledTools,
    subflowStack: [...ctx.subflowStack, String(row.id)],
  });
  if (result.status !== 'success') {
    throw new GraphNodeFailure(
      nodeId,
      'subflow_failed',
      `子工作流执行失败（详见子工作流 #${graphId} 的运行记录）`,
    );
  }
  return result.output;
}

/** 子工作流节点 handler：inputs 键值映射（key=子图变量名，value 支持
 * 模板占位符）→ 子图执行 → 终点 output 即本节点 output */
function makeSubflowNodeHandler(
  node: SubflowNode,
  ctx: NodeContext,
): NodeHandler {
  return async (state) => {
    const startedAt = Date.now();
    const label = `子工作流 #${node.graphId}`;
    try {
      const inputs: Record<string, string> = {};
      for (const kv of node.inputs) {
        if (kv.key !== '') {
          inputs[kv.key] = renderNodePrompt(kv.value, {
            inputs: state.inputs,
            nodes: state.nodes,
            now: ctx.now,
          });
        }
      }
      const output = node.async
        ? await launchAsyncSubflow(node.graphId, ctx, inputs)
        : await runSubflowGraph(node.id, node.graphId, ctx, inputs);
      await writeNodeRecord(ctx, node, label, output, startedAt);
      ctx.trace.push(traceSuccess(node, startedAt, { output }));
      return toNodeUpdate(node.id, { output });
    } catch (e) {
      const failure = toNodeFailure(node, e);
      await writeNodeFailureRecord(ctx, node, label, failure, startedAt);
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}

/** 循环节点 handler（Coze 循环对齐）：loopMode=array/count/while 三模式
 * 逐项执行子工作流 → 各项输出按行 join。carryVariable 承接变量（Coze
 * 中间变量极简版）每轮注入上一轮子图输出。串行循环在 handler 内完成
 * （不进 LangGraph 状态机，天然绕开 recursionLimit） */
function makeIterateNodeHandler(
  node: IterateNode,
  ctx: NodeContext,
): NodeHandler {
  return async (state) => {
    const startedAt = Date.now();
    const label = `循环 × 子工作流 #${node.graphId}`;
    try {
      const { slots, failures } = await runIterateRounds(node, state, ctx);
      const outputs = slots.filter((slot): slot is string => slot !== null);
      if (outputs.length === 0) {
        throw new GraphNodeFailure(
          node.id,
          'iterate_all_failed',
          '全部项执行失败（详见子工作流运行记录与 errorOutput 死信）',
        );
      }
      const output = outputs.join('\n');
      // 死信输出（continue 模式失败项清单）：下游 {{nodes.<id>.errorOutput}}
      // 可引用（典型落侧文件/通知），trace 一并携带供运行历史排查
      const errorOutput = failures.length > 0 ? failures.join('\n') : undefined;
      await writeNodeRecord(ctx, node, label, output, startedAt, {
        errorOutput,
      });
      ctx.trace.push(traceSuccess(node, startedAt, { output, errorOutput }));
      return toNodeUpdate(node.id, { output, errorOutput });
    } catch (e) {
      const failure = toNodeFailure(node, e);
      await writeNodeFailureRecord(ctx, node, label, failure, startedAt);
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}

/** 单轮执行：item/index/carry 注入子工作流（carry=上一轮输出 trim 值，
 * 首轮用 carryInitial）；失败项在 continue 模式下落 null 槽位并记死信行 */
async function runIterateRound(
  node: IterateNode,
  ctx: NodeContext,
  index: number,
  itemValue: string,
  carry: string | undefined,
  failures: string[],
): Promise<string | null> {
  try {
    const vars: Record<string, string> = {
      [node.itemVariable]: itemValue,
      [`${node.itemVariable}Index`]: String(index),
    };
    if (node.carryVariable) {
      vars[node.carryVariable] = carry ?? node.carryInitial ?? '';
    }
    return await runSubflowGraph(node.id, node.graphId, ctx, vars);
  } catch (e) {
    if ((node.onItemError ?? 'abort') === 'continue') {
      logger.warn('循环单项失败（continue 模式跳过）', node.id, index, e);
      const reason = e instanceof Error ? e.message : String(e);
      const preview =
        itemValue.length > 50 ? `${itemValue.slice(0, 50)}…` : itemValue;
      failures.push(`#${index} ${preview}: ${reason}`);
      return null;
    }
    throw e;
  }
}

/** array/count 模式：拆项 → 空列表/超上限拦截 → 串行或分批并发执行；
 * carry 在并发下为批间传递（中间变量本为串行语义） */
async function runBoundedRounds(
  node: IterateNode,
  state: GraphRunState,
  ctx: NodeContext,
): Promise<{ slots: Array<string | null>; failures: string[] }> {
  const failures: string[] = [];
  const items = resolveIterateItems(node, state, ctx);
  if (items.length === 0) {
    throw new GraphNodeFailure(
      node.id,
      'iterate_empty_items',
      '列表为空（来源表达式未解析出任何项）',
    );
  }
  if (items.length > node.maxItems) {
    throw new GraphNodeFailure(
      node.id,
      'iterate_too_many_items',
      `列表 ${items.length} 项超过上限 ${node.maxItems}`,
    );
  }
  // 按序保持结果槽位（并发不乱序）；失败项在 continue 模式下记 null
  const slots: Array<string | null> = new Array(items.length).fill(null);
  let carry: string | undefined;
  const runItem = async (index: number) => {
    const output = await runIterateRound(
      node,
      ctx,
      index,
      items[index],
      carry,
      failures,
    );
    slots[index] = output;
    if (output !== null) {
      carry = output.trim();
    }
  };
  const concurrency = Math.min(node.concurrency ?? 1, 5);
  if (concurrency <= 1) {
    for (let i = 0; i < items.length; i += 1) {
      await runItem(i);
    }
  } else {
    // 分批 Promise.all：批内并发、批间串行（SQLite 写队列友好）
    for (let start = 0; start < items.length; start += concurrency) {
      const batch = items
        .slice(start, start + concurrency)
        .map((_, offset) => runItem(start + offset));
      await Promise.all(batch);
    }
  }
  return { slots, failures };
}

/** while 模式（Coze 无限循环）：串行逐轮执行子图（item=迭代序数可当
 * 计数器）→ 求值终止条件满足即跳出；maxItems 保险丝防失控；并发不
 * 适用（多轮循环严格串行，同 Coze） */
async function runWhileRounds(
  node: IterateNode,
  state: GraphRunState,
  ctx: NodeContext,
): Promise<{ slots: Array<string | null>; failures: string[] }> {
  const slots: Array<string | null> = [];
  const failures: string[] = [];
  let carry: string | undefined;
  for (let round = 0; ; round += 1) {
    if (round >= node.maxItems) {
      throw new GraphNodeFailure(
        node.id,
        'iterate_too_many_items',
        `已达上限 ${node.maxItems} 轮仍未满足终止条件（防失控保险丝）`,
      );
    }
    const output = await runIterateRound(
      node,
      ctx,
      round,
      String(round + 1),
      carry,
      failures,
    );
    slots.push(output);
    if (output === null) {
      continue;
    }
    carry = output.trim();
    if (meetsIterateBreak(node, state, ctx, output)) {
      break;
    }
  }
  return { slots, failures };
}

function runIterateRounds(
  node: IterateNode,
  state: GraphRunState,
  ctx: NodeContext,
): Promise<{ slots: Array<string | null>; failures: string[] }> {
  return node.loopMode === 'while'
    ? runWhileRounds(node, state, ctx)
    : runBoundedRounds(node, state, ctx);
}

/** while 终止条件求值：source/value 模板渲染（nodes 上下文临时覆盖
 * 注入本轮子图输出 trim 值，{{nodes.<本节点>.output}} 可引用本轮结果）
 * 后复用 evalCondition 比较 */
function meetsIterateBreak(
  node: IterateNode,
  state: GraphRunState,
  ctx: NodeContext,
  roundOutput: string,
): boolean {
  const cond = node.breakCondition;
  if (!cond) {
    return false;
  }
  const render = (text: string) =>
    renderNodePrompt(text, {
      inputs: state.inputs,
      nodes: { ...state.nodes, [node.id]: { output: roundOutput.trim() } },
      now: ctx.now,
    });
  return evalCondition(
    render(cond.source),
    cond.operator,
    cond.value === undefined ? '' : render(cond.value),
  );
}

/** 列表拆分：JSON 字符串数组优先（解析失败按非空行），供循环节点 */
export function splitIterateItems(source: string): string[] {
  const trimmed = source.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const strings = parsed.map((item) => String(item));
        // 优先整串判定成功即用（含非字符串项时 String 化）
        if (parsed.every((item) => typeof item === 'string')) {
          return strings;
        }
        if (parsed.length > 0) {
          return strings;
        }
      }
    } catch {
      // 非法 JSON：回落按行拆
    }
  }
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** 次数求值：正整数（含纯数字串）返回数值，其余返回 null */
export function parseIterateCount(raw: string): number | null {
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= 1 ? value : null;
}

/** 循环拆项统一出口：array 模式求值 itemsSource 拆列表；count 模式求值
 * countSource（{{}} 占位后须为正整数）生成 1..N 序数，超上限沿用
 * maxItems 保险丝拦截 */
function resolveIterateItems(
  node: IterateNode,
  state: GraphRunState,
  ctx: NodeContext,
): string[] {
  const render = (source: string) =>
    renderNodePrompt(source, {
      inputs: state.inputs,
      nodes: state.nodes,
      now: ctx.now,
    });
  if (node.loopMode === 'count') {
    const raw = render(node.countSource ?? '');
    const count = parseIterateCount(raw);
    if (count === null) {
      throw new GraphNodeFailure(
        node.id,
        'iterate_bad_count',
        `循环次数无效（须为正整数）：${raw.trim() || '空'}`,
      );
    }
    return Array.from({ length: count }, (_, index) => String(index + 1));
  }
  return splitIterateItems(render(node.itemsSource));
}

/** 资料库文本文件扩展名白名单（跳过二进制/超大，读取失败静默跳过） */
const LIBRARY_TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'csv',
  'log',
  'yml',
  'yaml',
  'toml',
  'html',
  'xml',
  'ts',
  'js',
  'py',
  'sh',
]);

/** 资料库检索单文件读取上限 */
const LIBRARY_SCAN_LIMIT = 1024 * 1024;

/** 片段长度：关键词命中位置前后各取半 */
const LIBRARY_SNIPPET_RADIUS = 120;

/** 资料库检索 handler：query 空格分词 AND 匹配资料库文本文件内容，
 * 输出「【文件名】片段」（≤maxResults）；无命中输出空串（节点成功，
 * 空召回不算错，下游可据此走分支/降级） */
function makeLibrarySearchNodeHandler(
  node: LibrarySearchNode,
  ctx: NodeContext,
): NodeHandler {
  return async (state) => {
    const startedAt = Date.now();
    try {
      const keywords = renderNodePrompt(node.keywords, {
        inputs: state.inputs,
        nodes: state.nodes,
        now: ctx.now,
      });
      const output = await searchLibrary(
        keywords,
        node.maxResults ?? 5,
        ctx.userId,
      );
      await writeNodeRecord(ctx, node, keywords, output, startedAt);
      ctx.trace.push(traceSuccess(node, startedAt, { output }));
      return toNodeUpdate(node.id, { output });
    } catch (e) {
      const failure = toNodeFailure(node, e);
      await writeNodeFailureRecord(
        ctx,
        node,
        node.keywords,
        failure,
        startedAt,
      );
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}

async function searchLibrary(
  query: string,
  maxResults: number,
  userId: number,
): Promise<string> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== '');
  if (terms.length === 0) {
    return '';
  }
  // 授权面 8：server 未摘 libraryItem 表（spec §5 摘表清单无资料库域）
  // ——缺表探测为空行集（mirror「空召回不算错」语义，下游可走分支/
  // 降级），资料库域落地后本节点自然恢复
  const db = graphExecutorRuntime().db as PrismaService & {
    libraryItem?: {
      findMany: (args: {
        where: { userId: number; kind: string };
      }) => Promise<Array<{ id: number; name: string }>>;
    };
  };
  const rows = db.libraryItem
    ? await db.libraryItem.findMany({ where: { userId, kind: 'file' } })
    : [];
  const root = graphExecutorRuntime().libraryDir();
  const hits: string[] = [];
  for (const row of rows) {
    if (hits.length >= maxResults) {
      break;
    }
    const ext = path.extname(row.name).slice(1).toLowerCase();
    if (!LIBRARY_TEXT_EXTENSIONS.has(ext)) {
      continue;
    }
    const filePath = path.join(root, String(row.id), row.name);
    let content: string;
    try {
      const info = await stat(filePath);
      if (info.size > LIBRARY_SCAN_LIMIT) {
        continue;
      }
      content = await readFile(filePath, 'utf-8');
    } catch {
      continue; // 坏行/缺文件静默跳过（检索尽力而为）
    }
    const lowered = content.toLowerCase();
    const at = terms.findIndex((term) => !lowered.includes(term));
    if (at !== -1) {
      continue; // 任一词未命中 → AND 不满足
    }
    const first = lowered.indexOf(terms[0]);
    const start = Math.max(0, first - LIBRARY_SNIPPET_RADIUS);
    const snippet = content
      .slice(start, first + LIBRARY_SNIPPET_RADIUS)
      .replace(/\s+/g, ' ')
      .trim();
    hits.push(`【${row.name}】${snippet}`);
  }
  return hits.join('\n\n');
}

/** JSON 点路径解析（a.b / a[0].b 混合；[n] 归一为 .n 段）：
 * root 处 walk，对象按 key、数组按下标；miss 返回 ok:false。导出供测试 */
export function resolveJsonPath(
  root: unknown,
  path: string,
): { ok: boolean; value?: unknown } {
  if (path.trim() === '') {
    return { ok: true, value: root };
  }
  let current: unknown = root;
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((seg) => seg !== '');
  for (const seg of segments) {
    if (current === null || typeof current !== 'object') {
      return { ok: false };
    }
    if (Array.isArray(current)) {
      const index = Number(seg);
      if (!Number.isInteger(index) || index < 0) {
        return { ok: false };
      }
      current = current[index];
    } else {
      current = (current as Record<string, unknown>)[seg];
    }
    if (current === undefined) {
      return { ok: false };
    }
  }
  return { ok: true, value: current };
}

/** jsonParse 节点 handler：解析+点路径提取。输出规则：path 空 → pretty
 * 规范 JSON；path 命中字符串 → 原样；arrayLines 且命中数组 → 每项一行
 * （字符串原样、其余紧凑 JSON，直连循环节点）；其余值 → 紧凑 JSON */
function makeJsonParseNodeHandler(
  node: JsonParseNode,
  ctx: NodeContext,
): NodeHandler {
  return async (state) => {
    const startedAt = Date.now();
    try {
      const output = await runJsonParse(node, ctx, state);
      await writeNodeRecord(ctx, node, node.source, output, startedAt);
      ctx.trace.push(traceSuccess(node, startedAt, { output }));
      return toNodeUpdate(node.id, { output });
    } catch (e) {
      const failure = toNodeFailure(node, e);
      await writeNodeFailureRecord(ctx, node, node.source, failure, startedAt);
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}

async function runJsonParse(
  node: JsonParseNode,
  ctx: NodeContext,
  state: { inputs: Record<string, string>; nodes: Record<string, NodeResult> },
): Promise<string> {
  const source = renderNodePrompt(node.source, {
    inputs: state.inputs,
    nodes: state.nodes,
    now: ctx.now,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (e) {
    throw new GraphNodeFailure(
      node.id,
      'json_parse_error',
      `输入不是合法 JSON: ${errorMessage(e)}`,
    );
  }
  const path = node.path ?? '';
  const hit = resolveJsonPath(parsed, path);
  if (!hit.ok || hit.value === undefined) {
    throw new GraphNodeFailure(
      node.id,
      'json_path_missing',
      `路径不存在: ${path || '(根)'}`,
    );
  }
  const value = hit.value;
  if (node.arrayLines && Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
      .join('\n');
  }
  if (typeof value === 'string') {
    return value;
  }
  return path === '' ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

/** jsonStringify 节点 handler：合法 JSON 对象/数组 → 紧凑规范化；
 * 其余（含数字/布尔/普通文本）→ JSON 字符串字面量（引号换行转义） */
function makeJsonStringifyNodeHandler(
  node: JsonStringifyNode,
  ctx: NodeContext,
): NodeHandler {
  return async (state) => {
    const startedAt = Date.now();
    try {
      const source = renderNodePrompt(node.source, {
        inputs: state.inputs,
        nodes: state.nodes,
        now: ctx.now,
      });
      let output: string;
      try {
        const parsed: unknown = JSON.parse(source);
        output =
          parsed !== null && typeof parsed === 'object'
            ? JSON.stringify(parsed)
            : JSON.stringify(source);
      } catch {
        output = JSON.stringify(source);
      }
      await writeNodeRecord(ctx, node, node.source, output, startedAt);
      ctx.trace.push(traceSuccess(node, startedAt, { output }));
      return toNodeUpdate(node.id, { output });
    } catch (e) {
      const failure = toNodeFailure(node, e);
      await writeNodeFailureRecord(ctx, node, node.source, failure, startedAt);
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}

/** 条件求值：source 与 value 均已模板渲染为字符串后比较。
 * eq/neq/contains 系字符串比较；gt~lte 数字比较（NaN 视为不满足）；
 * isEmpty/notEmpty 不需要 value；regex 非法正则视为不满足 */
export function evalCondition(
  left: string,
  operator: ConditionBranch['conditions'][number]['operator'],
  right: string,
): boolean {
  switch (operator) {
    case 'eq':
      return left === right;
    case 'neq':
      return left !== right;
    case 'contains':
      return left.includes(right);
    case 'notContains':
      return !left.includes(right);
    case 'isEmpty':
      return left.trim() === '';
    case 'notEmpty':
      return left.trim() !== '';
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = Number(left);
      const b = Number(right);
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        return false;
      }
      if (operator === 'gt') return a > b;
      if (operator === 'gte') return a >= b;
      if (operator === 'lt') return a < b;
      return a <= b;
    }
    case 'regex':
      try {
        return new RegExp(right).test(left);
      } catch {
        return false;
      }
  }
}

/** 意图识别节点 handler（Coze Intent 式）：内置分类提示词（意图清单 +
 * query），模型只输出意图名（复用 branch 的候选标签解析）；命中清单 →
 * route=output=意图名，未命中且有 fallback → 兜底，否则 intent_no_match
 * 节点失败（模型调用失败沿用 llm 系错误码归因） */
function makeIntentNodeHandler(
  node: IntentNode,
  ctx: NodeContext,
): NodeHandler {
  return async (state) => {
    const startedAt = Date.now();
    const query = renderNodePrompt(node.querySource, {
      inputs: state.inputs,
      nodes: state.nodes,
      now: ctx.now,
    });
    try {
      const model = await modelFor(ctx, node);
      const raw = await model.invoke(
        [
          new SystemMessage(
            '你是意图识别助手，只输出意图名对应的 JSON，不输出其他内容。',
          ),
          new HumanMessage(intentPrompt(query, node.intents)),
        ],
        {
          signal: AbortSignal.any([
            ctx.abort,
            AbortSignal.timeout(node.timeoutMs),
          ]),
        },
      );
      const usage = extractTokenUsage(raw);
      const names = node.intents.map((intent) => intent.name);
      const matched = matchIntentLabel(raw, names) ?? node.fallback ?? null;
      if (!matched) {
        throw new GraphNodeFailure(
          node.id,
          'intent_no_match',
          `模型输出不合任何意图且无兜底: ${previewOf(raw)}`,
        );
      }
      const output = matched;
      await writeNodeRecord(ctx, node, query, output, startedAt, { usage });
      ctx.trace.push(traceSuccess(node, startedAt, { output, usage }));
      return toNodeUpdate(node.id, { output, usage, route: output });
    } catch (e) {
      const failure = toNodeFailure(node, e);
      await writeNodeFailureRecord(ctx, node, query, failure, startedAt);
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}

/** 意图分类提示词（给模型看，不进 i18n）：意图清单（描述辅助分类）+
 * 输入内容 + 只输出意图名 JSON 的约束（branchPrompt 同形） */
function intentPrompt(query: string, intents: IntentNode['intents']): string {
  const list = intents
    .map((intent) => `- ${intent.name}: ${intent.description || '（无描述）'}`)
    .join('\n');
  const names = intents.map((intent) => intent.name).join(' | ');
  return [
    '根据以下意图清单，判断输入内容最匹配的意图：',
    list,
    '',
    `输入内容：${query}`,
    '',
    `请只输出一个 JSON 对象 {"intent": "<意图名>"}，意图名取值：${names}，不要输出任何其他内容。`,
  ].join('\n');
}

/** 模型输出 → 意图名（不抛错版 extractBranchLabel：候选标签宽松匹配，
 * 全不中返回 null 由调用方走 fallback/失败语义） */
function matchIntentLabel(raw: unknown, names: string[]): string | null {
  for (const candidate of labelCandidates(raw)) {
    const label = matchLabel(candidate, names);
    if (label) {
      return label;
    }
  }
  return null;
}

/** 条件分支节点 handler（Coze Choice 式）：分支按序评估（内含条件 AND，
 * source/value 均经模板渲染），首个命中 → route=分支名；全不中且配置
 * fallback → route=fallback；否则不写 route（条件边回落 __fallback__→
 * END）。output=命中分支名（或空），trace/消息照常 */
function makeConditionNodeHandler(
  node: ConditionNode,
  ctx: NodeContext,
): NodeHandler {
  return async (state) => {
    const startedAt = Date.now();
    const render = (text: string) =>
      renderNodePrompt(text, {
        inputs: state.inputs,
        nodes: state.nodes,
        now: ctx.now,
      });
    try {
      let matched: string | null = null;
      for (const branch of node.branches) {
        const hit = branch.conditions.every((cond) =>
          evalCondition(
            render(cond.source),
            cond.operator,
            cond.value === undefined ? '' : render(cond.value),
          ),
        );
        if (hit) {
          matched = branch.name;
          break;
        }
      }
      if (matched === null && node.fallback) {
        matched = node.fallback;
      }
      const output = matched ?? '';
      const summary = node.branches
        .map((b) => `${b.name}: ${b.conditions.length} 条件`)
        .join('; ');
      await writeNodeRecord(
        ctx,
        node,
        `条件判断（${summary}${node.fallback ? `；兜底: ${node.fallback}` : ''}）`,
        output,
        startedAt,
      );
      ctx.trace.push(traceSuccess(node, startedAt, { output }));
      return matched
        ? toNodeUpdate(node.id, { output, route: matched })
        : toNodeUpdate(node.id, { output });
    } catch (e) {
      const failure = toNodeFailure(node, e);
      await writeNodeFailureRecord(ctx, node, '条件判断', failure, startedAt);
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}

/** 工作空间内路径归一（fileRead/fileWrite/docExtract 共用）：相对/绝对
 * 都 resolve 后校验前缀，越界抛 file_outside_workspace */
function resolveWorkspaceFile(
  nodeId: string,
  rawPath: string,
  ctx: NodeContext,
): string {
  if (!ctx.workspacePath) {
    throw new GraphNodeFailure(
      nodeId,
      'file_workspace_missing',
      '未绑定工作空间目录，文件节点须在绑定了目录的工作空间下执行',
    );
  }
  const resolved = path.resolve(ctx.workspacePath, rawPath);
  const inside =
    resolved === ctx.workspacePath ||
    resolved.startsWith(`${ctx.workspacePath}${path.sep}`);
  if (!inside) {
    throw new GraphNodeFailure(
      nodeId,
      'file_outside_workspace',
      `路径越界（仅可访问工作空间内文件）: ${rawPath}`,
    );
  }
  return resolved;
}

/** 文件写入节点 handler：content 模板替换后写回工作空间（append 追加带
 * 换行 / overwrite 覆盖），目录自动创建；写操作走 codeAuthorized 门禁
 * （default 任务拒写，对齐 run_command 语义） */
function makeFileWriteNodeHandler(
  node: FileWriteNode,
  ctx: NodeContext,
): NodeHandler {
  return async (state) => {
    const startedAt = Date.now();
    try {
      if (!ctx.codeAuthorized) {
        throw new GraphNodeFailure(
          node.id,
          'file_write_denied',
          '文件写入需要任务开启「允许完全访问」（试运行不受限）',
        );
      }
      const render = (text: string) =>
        renderNodePrompt(text, {
          inputs: state.inputs,
          nodes: state.nodes,
          now: ctx.now,
        });
      // path 与 content 都要渲染——曾用原始 path resolve，{{...}} 被当
      // 字面量文件名写盘（测试抓出）
      const target = resolveWorkspaceFile(node.id, render(node.path), ctx);
      const content = render(node.content);
      const dir = path.dirname(target);
      const { mkdir, appendFile, writeFile } = await import('node:fs/promises');
      await mkdir(dir, { recursive: true });
      if (node.mode === 'overwrite') {
        await writeFile(target, content, 'utf-8');
      } else {
        await appendFile(target, `${content}\n`, 'utf-8');
      }
      const output = `${node.mode === 'overwrite' ? '已覆盖' : '已追加'}: ${target}`;
      await writeNodeRecord(ctx, node, node.path, output, startedAt);
      ctx.trace.push(traceSuccess(node, startedAt, { output }));
      return toNodeUpdate(node.id, { output });
    } catch (e) {
      const failure = toNodeFailure(node, e);
      await writeNodeFailureRecord(ctx, node, node.path, failure, startedAt);
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}

/** 文档提取节点 handler：PDF/docx/文本 → 纯文本（maxChars 截断） */
function makeDocExtractNodeHandler(
  node: DocExtractNode,
  ctx: NodeContext,
): NodeHandler {
  return async (state) => {
    const startedAt = Date.now();
    try {
      const raw = renderNodePrompt(node.path, {
        inputs: state.inputs,
        nodes: state.nodes,
        now: ctx.now,
      });
      const resolved = resolveWorkspaceFile(node.id, raw, ctx);
      const { extractDocumentText, DocExtractError } =
        await import('./doc-extract');
      let text: string;
      try {
        text = await extractDocumentText(resolved);
      } catch (e) {
        if (e instanceof DocExtractError) {
          throw new GraphNodeFailure(node.id, e.code, e.message);
        }
        throw e;
      }
      const limit = node.maxChars ?? 64_000;
      const output =
        text.length > limit
          ? `${text.slice(0, limit)}\n…（已截断，共 ${text.length} 字符）`
          : text;
      await writeNodeRecord(ctx, node, node.path, output, startedAt);
      ctx.trace.push(traceSuccess(node, startedAt, { output }));
      return toNodeUpdate(node.id, { output });
    } catch (e) {
      const failure = toNodeFailure(node, e);
      await writeNodeFailureRecord(ctx, node, node.path, failure, startedAt);
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}

/** 延时节点 handler：可中止的 sleep（轮询间隔/节流） */
function makeDelayNodeHandler(node: DelayNode, ctx: NodeContext): NodeHandler {
  return async () => {
    const startedAt = Date.now();
    const seconds = node.seconds ?? 60;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, seconds * 1000);
        ctx.abort.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('延时被中止'));
          },
          { once: true },
        );
      });
      const output = `已等待 ${seconds}s`;
      await writeNodeRecord(ctx, node, output, output, startedAt);
      ctx.trace.push(traceSuccess(node, startedAt, { output }));
      return toNodeUpdate(node.id, { output });
    } catch (e) {
      const failure = toNodeFailure(node, e);
      await writeNodeFailureRecord(
        ctx,
        node,
        `等待 ${seconds}s`,
        failure,
        startedAt,
      );
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}

/** 图像生成节点 handler：openai/comfyui 双协议分流——openai 调 images/
 * generations（b64_json 优先、url 回退下载），comfyui 走 workflow API
 * 提交/轮询/取图；产物统一存 userData/workflow-assets/，output=文件
 * 绝对路径（可接 binary 上传/文件写入/通知） */
function makeImageGenNodeHandler(
  node: ImageGenNode,
  ctx: NodeContext,
): NodeHandler {
  return async (state) => {
    const startedAt = Date.now();
    try {
      const prompt = renderNodePrompt(node.prompt, {
        inputs: state.inputs,
        nodes: state.nodes,
        now: ctx.now,
      });
      const output = isComfyUIImageGen(node)
        ? await generateImageComfyUI(
            node,
            ctx,
            {
              inputs: state.inputs,
              nodes: state.nodes,
              now: ctx.now,
            },
            prompt,
          )
        : await generateImage(node, ctx, prompt);
      const outputImage = relativeAssetPath(output);
      await writeNodeRecord(
        ctx,
        node,
        prompt.slice(0, 100),
        output,
        startedAt,
        { outputImage },
      );
      ctx.trace.push(traceSuccess(node, startedAt, { output, outputImage }));
      return toNodeUpdate(node.id, { output });
    } catch (e) {
      const failure = toNodeFailure(node, e);
      await writeNodeFailureRecord(
        ctx,
        node,
        node.prompt.slice(0, 100),
        failure,
        startedAt,
      );
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}

/** 生图产物落盘 workflow-assets，返回绝对路径（两协议共用） */
async function writeWorkflowImage(buffer: Buffer): Promise<string> {
  const dir = graphExecutorRuntime().workflowAssetsDir();
  await (await import('node:fs/promises')).mkdir(dir, { recursive: true });
  const file = path.join(dir, `image-${Date.now()}.png`);
  await (await import('node:fs/promises')).writeFile(file, buffer);
  return file;
}

/** 产物绝对路径 → 相对数据根路径（workflow-assets/xxx.png，MessageImage
 * 展示通道）；不在 workflow-assets 下（理论不可达）→ undefined */
function relativeAssetPath(output: string): string | undefined {
  const dir = graphExecutorRuntime().workflowAssetsDir();
  return output.startsWith(dir + path.sep)
    ? `workflow-assets/${path.basename(output)}`
    : undefined;
}

async function generateImage(
  node: ImageGenNode,
  ctx: NodeContext,
  prompt: string,
): Promise<string> {
  // openai 协议 superRefine 保证 modelId 必填（comfyui 已在分流前摘走）
  const runtime = await loadModelRuntime(node.modelId!);
  const base = runtime.provider.baseUrl.replace(/\/+$/, '');
  const url = `${base}/images/generations`;
  const { parseExtraHeaders } = await import('../provider/model-factory');
  const extraHeaders = parseExtraHeaders(runtime.provider.extraHeaders);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(runtime.provider.apiKey
          ? { Authorization: `Bearer ${runtime.provider.apiKey}` }
          : {}),
        ...extraHeaders,
      },
      body: JSON.stringify({
        model: runtime.sdkId,
        prompt,
        size: node.size ?? '1024x1024',
        n: 1,
      }),
      signal: ctx.abort,
    });
  } catch (e) {
    throw new GraphNodeFailure(
      node.id,
      'image_request_failed',
      `生图请求失败: ${errorMessage(e)}`,
    );
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new GraphNodeFailure(
      node.id,
      'image_api_error',
      `生图接口返回 HTTP ${response.status}: ${JSON.stringify(payload)?.slice(0, 200)}`,
    );
  }
  const entry = (
    payload as { data?: Array<{ b64_json?: string; url?: string }> }
  )?.data?.[0];
  let buffer: Buffer | null = null;
  if (entry?.b64_json) {
    buffer = Buffer.from(entry.b64_json, 'base64');
  } else if (entry?.url) {
    try {
      const download = await fetch(entry.url, { signal: ctx.abort });
      buffer = Buffer.from(await download.arrayBuffer());
    } catch (e) {
      throw new GraphNodeFailure(
        node.id,
        'image_download_failed',
        `生图结果下载失败: ${errorMessage(e)}`,
      );
    }
  }
  if (!buffer) {
    throw new GraphNodeFailure(
      node.id,
      'image_api_error',
      '生图接口未返回 b64_json 或 url',
    );
  }
  return writeWorkflowImage(buffer);
}

/** ComfyUI 服务商直取（comfyui 协议无 model 行，providerId 即引用） */
async function loadProviderRuntime(providerId: number) {
  const db = graphExecutorRuntime().db;
  const row = await db.provider.findUnique({ where: { id: providerId } });
  if (!row) {
    throw new GraphRunFailure(
      'provider_missing',
      `节点服务商不存在: ${providerId}`,
    );
  }
  return {
    baseUrl: row.baseUrl,
    apiKey: row.apiKey ?? undefined,
    extraHeaders: row.extraHeaders ?? undefined,
  };
}

/** "1024x1024" → [w, h]；非法格式报 comfyui_invalid_size（防御性，UI
 * Select 已限定格式） */
function parseImageSize(size: string): [number, number] {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(size);
  if (!m) {
    throw new GraphRunFailure('comfyui_invalid_size', `尺寸格式非法: ${size}`);
  }
  return [Number(m[1]), Number(m[2])];
}

/** 深度遍历应用本地占位：{{prompt}} 字符串内嵌入替换（可多次出现）；
 * {{width}}/{{height}}/{{seed}} 整值匹配替换保数值类型。返回是否已显式
 * 占位 {{seed}} */
function applyPlaceholders(
  value: unknown,
  vars: { prompt: string; width: number; height: number; seed: number },
): { value: unknown; seedPlaced: boolean } {
  if (typeof value === 'string') {
    const withPrompt = value.split('{{prompt}}').join(vars.prompt);
    const m = /^\{\{(width|height|seed)\}\}$/.exec(withPrompt);
    if (m) {
      const key = m[1] as 'width' | 'height' | 'seed';
      return { value: vars[key], seedPlaced: key === 'seed' };
    }
    return { value: withPrompt, seedPlaced: false };
  }
  if (Array.isArray(value)) {
    return {
      value: value.map((v) => applyPlaceholders(v, vars).value),
      seedPlaced: false,
    };
  }
  if (value && typeof value === 'object') {
    let seedPlaced = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = applyPlaceholders(v, vars);
      out[k] = r.value;
      seedPlaced = seedPlaced || r.seedPlaced;
    }
    return { value: out, seedPlaced };
  }
  return { value, seedPlaced: false };
}

/** randomizeSeed 且未显式占位时，替换 inputs 中 seed/noise_seed/rand_seed
 * 为随机 int——防 ComfyUI 缓存命中同 prompt 出同图 */
function randomizeSeedsInPlace(
  workflow: Record<string, unknown>,
  seed: number,
): void {
  for (const node of Object.values(workflow)) {
    const inputs = (node as { inputs?: Record<string, unknown> })?.inputs;
    if (!inputs) continue;
    for (const key of ['seed', 'noise_seed', 'rand_seed']) {
      if (key in inputs) inputs[key] = seed;
    }
  }
}

/** workflowJson 两段渲染：renderNodePrompt 注入上游变量（JSON 串层）→
 * parse → 深度应用本地占位 → 按需 seed 随机化 */
function buildComfyWorkflow(
  node: ComfyImageGenNode,
  renderCtx: PromptRenderContext,
  prompt: string,
): Record<string, unknown> {
  const [width, height] = parseImageSize(node.size);
  const seed = Math.floor(Math.random() * 1_000_000_000);
  const upstream = renderNodePrompt(node.workflowJson, renderCtx);
  let parsed: unknown;
  try {
    parsed = JSON.parse(upstream);
  } catch {
    throw new GraphRunFailure(
      'comfyui_workflow_invalid',
      'workflowJson 渲染后不是合法 JSON',
    );
  }
  const { value: applied, seedPlaced } = applyPlaceholders(parsed, {
    prompt,
    width,
    height,
    seed,
  });
  const workflow = applied as Record<string, unknown>;
  if (node.randomizeSeed && !seedPlaced) {
    randomizeSeedsInPlace(workflow, seed);
  }
  return workflow;
}

/** comfyui 请求头（Bearer 可选 + provider extraHeaders） */
async function comfyHeaders(runtime: {
  apiKey?: string;
  extraHeaders?: string;
}): Promise<Record<string, string>> {
  const { parseExtraHeaders } = await import('../provider/model-factory');
  return {
    'Content-Type': 'application/json',
    ...(runtime.apiKey ? { Authorization: `Bearer ${runtime.apiKey}` } : {}),
    ...parseExtraHeaders(runtime.extraHeaders),
  };
}

/** 轮询 sleep（abort 立即醒） */
function sleepMs(ms: number, abort: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    abort.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** ComfyUI workflow API 生图：/prompt 提交 → 1s 轮询 /history → /view
 * 取第一张 output 图落盘（多图只取第一张，对齐 n:1 语义） */
async function generateImageComfyUI(
  node: ComfyImageGenNode,
  ctx: NodeContext,
  renderCtx: PromptRenderContext,
  prompt: string,
): Promise<string> {
  const runtime = await loadProviderRuntime(node.providerId);
  const base = runtime.baseUrl.replace(/\/+$/, '');
  const headers = await comfyHeaders(runtime);
  const workflow = buildComfyWorkflow(node, renderCtx, prompt);
  const promptId = await submitComfyPrompt(node, base, headers, workflow, ctx);
  const historyEntry = await pollComfyHistory(
    node,
    base,
    headers,
    promptId,
    ctx,
  );
  const image = firstComfyImage(node, historyEntry);
  const buffer = await downloadComfyImage(node, base, headers, image, ctx);
  return writeWorkflowImage(buffer);
}

/** POST /prompt；非 200 或 node_errors 非空 → comfyui_api_error */
async function submitComfyPrompt(
  node: ComfyImageGenNode,
  base: string,
  headers: Record<string, string>,
  workflow: Record<string, unknown>,
  ctx: NodeContext,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt: workflow,
        client_id: `tianshu-${Date.now()}`,
      }),
      signal: ctx.abort,
    });
  } catch (e) {
    throw new GraphNodeFailure(
      node.id,
      'comfyui_request_failed',
      `ComfyUI 提交失败: ${errorMessage(e)}`,
    );
  }
  const payload = (await res.json().catch(() => null)) as {
    prompt_id?: string;
    node_errors?: Record<string, unknown>;
  } | null;
  if (!res.ok || !payload?.prompt_id || hasEntries(payload.node_errors)) {
    throw new GraphNodeFailure(
      node.id,
      'comfyui_api_error',
      `ComfyUI 提交被拒 HTTP ${res.status}: ${JSON.stringify(payload)?.slice(0, 200)}`,
    );
  }
  return payload.prompt_id;
}

function hasEntries(obj: Record<string, unknown> | undefined): boolean {
  return Boolean(obj && Object.keys(obj).length > 0);
}

/** 轮询 GET /history/{id}，1s 间隔，超 timeoutMs → comfyui_timeout */
async function pollComfyHistory(
  node: ComfyImageGenNode,
  base: string,
  headers: Record<string, string>,
  promptId: string,
  ctx: NodeContext,
): Promise<Record<string, unknown>> {
  const timeoutMs = node.timeoutMs ?? 300_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ctx.abort.aborted) break;
    let payload: Record<string, unknown> | null = null;
    try {
      const res = await fetch(`${base}/history/${promptId}`, {
        headers,
        signal: ctx.abort,
      });
      payload = res.ok ? await res.json().catch(() => null) : null;
    } catch {
      // 单轮网络抖动吞掉（payload 维持 null），靠 deadline 兜底
    }
    const entry = payload?.[promptId];
    if (entry) return entry as Record<string, unknown>;
    await sleepMs(1_000, ctx.abort);
  }
  throw new GraphNodeFailure(
    node.id,
    'comfyui_timeout',
    `ComfyUI 生图超时（${timeoutMs}ms）`,
  );
}

/** history entry.outputs 取第一张 type=output 图 */
function firstComfyImage(
  node: ComfyImageGenNode,
  entry: Record<string, unknown>,
): { filename: string; subfolder: string; type: string } {
  const outputs = (
    entry as {
      outputs?: Record<
        string,
        {
          images?: Array<{ filename: string; subfolder: string; type: string }>;
        }
      >;
    }
  ).outputs;
  for (const out of Object.values(outputs ?? {})) {
    const img = out.images?.find((i) => i.type === 'output');
    if (img) return img;
  }
  throw new GraphNodeFailure(
    node.id,
    'comfyui_no_output',
    'ComfyUI 未产出图片',
  );
}

/** GET /view 下载图 */
async function downloadComfyImage(
  node: ComfyImageGenNode,
  base: string,
  headers: Record<string, string>,
  image: { filename: string; subfolder: string; type: string },
  ctx: NodeContext,
): Promise<Buffer> {
  const query = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder,
    type: image.type,
  });
  try {
    const res = await fetch(`${base}/view?${query}`, {
      headers,
      signal: ctx.abort,
    });
    if (!res.ok) {
      throw new GraphNodeFailure(
        node.id,
        'comfyui_download_failed',
        `ComfyUI 取图失败 HTTP ${res.status}`,
      );
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    if (e instanceof GraphNodeFailure) throw e;
    throw new GraphNodeFailure(
      node.id,
      'comfyui_download_failed',
      `ComfyUI 取图失败: ${errorMessage(e)}`,
    );
  }
}

/** 节点状态实时投影（原 BrowserWindow orchestration:node-status 广播——
 * 授权面 1：UI 关注点改经 EventBus graph.run.updated progress；run 级
 * state 保持 running，节点态在 progress，试运行画布高亮同源消费） */
function notifyNodeStatus(
  runId: number,
  graphId: number,
  nodeId: string,
  status: GraphNodeRunStatus,
): void {
  publishRunUpdated({
    runId,
    graphId,
    state: 'running',
    progress: { nodeId, nodeStatus: status },
  });
}

/** 单节点测试（Coze 式）：轻量构造 ctx 单跑该节点 handler——不落 run
 * 记录；即席执行不留痕（Coze 式，节点详情行 runId=null 不落）；nodeStatus
 * 不推（无图运行态）。inputs/nodes 由前端从占位符表单构造 */
export async function testSingleNode(params: {
  node: GraphNode;
  inputs: Record<string, string>;
  nodes: Record<string, { output: string }>;
  workspace: { id: number; directoryPath: string | null };
  userId: number;
}): Promise<
  { ok: true; output: string } | { ok: false; code: string; message: string }
> {
  const abort = new AbortController().signal;
  // 伪图行：buildNodeContext 只消费 id/userId/graphJson 等少数字段
  const fakeGraph = {
    id: 0,
    name: '单节点测试',
    graphJson: '{}',
    version: 1,
    enabled: false,
    userId: params.userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never;
  const ctx = buildNodeContext(
    {
      graph: fakeGraph,
      task: null,
      inputs: params.inputs,
      triggerType: 'manual',
      attempt: 1,
      abort,
      workspace: params.workspace,
    },
    defaultDeps,
    null, // 即席执行：无 run 归属，节点详情不落库
  );
  const handler = makeNodeHandler(params.node, ctx);
  try {
    const update = await handler({
      inputs: params.inputs,
      nodes: params.nodes as Record<string, NodeResult>,
    });
    const output =
      (update.nodes as Record<string, { output?: string }> | undefined)?.[
        params.node.id
      ]?.output ?? '';
    return { ok: true, output };
  } catch (e) {
    const failure = toNodeFailure(params.node, e);
    return { ok: false, code: failure.code, message: failure.message };
  }
}

/** embeddings 批量上限（OpenAI 兼容接口单请求 input 数组稳妥值） */
const EMBED_BATCH_SIZE = 16;

/** OpenAI 兼容 /embeddings 批量向量化（复用模型运行时解析；分批串行
 * 防限流）；signal 供节点级超时/取消接入（AbortSignal.any 组装）；
 * 导出供测试 */
export async function embedTexts(
  modelId: number,
  texts: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  const runtime = await loadModelRuntime(modelId);
  const { parseExtraHeaders } = await import('../provider/model-factory');
  const extraHeaders = parseExtraHeaders(runtime.provider.extraHeaders);
  const base = runtime.provider.baseUrl.replace(/\/+$/, '');
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
    let response: Response;
    try {
      response = await fetch(`${base}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(runtime.provider.apiKey
            ? { Authorization: `Bearer ${runtime.provider.apiKey}` }
            : {}),
          ...extraHeaders,
        },
        body: JSON.stringify({ model: runtime.sdkId, input: batch }),
        signal,
      });
    } catch (e) {
      throw new GraphRunFailure(
        'embed_request_failed',
        `向量化请求失败: ${errorMessage(e)}`,
      );
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new GraphRunFailure(
        'embed_api_error',
        `向量化接口返回 HTTP ${response.status}: ${JSON.stringify(payload)?.slice(0, 200)}`,
      );
    }
    const data = (
      payload as {
        data?: Array<{ index?: number; embedding?: number[] }>;
      }
    )?.data;
    if (!Array.isArray(data) || data.length !== batch.length) {
      throw new GraphRunFailure(
        'embed_api_error',
        `向量化接口返回条目数不符（期望 ${batch.length} 实得 ${data?.length ?? 0}）`,
      );
    }
    // 按 index 归位（规范允许乱序）
    const ordered: number[][] = new Array(batch.length);
    data.forEach((entry, i) => {
      const at = typeof entry.index === 'number' ? entry.index : i;
      ordered[at] = entry.embedding ?? [];
    });
    vectors.push(...ordered);
  }
  return vectors;
}

/** 向量化入库节点 handler：text 渲染 → 分块 → embedding → 条目级
 * upsert（重跑幂等）→ 回执输出（块数/集合名/条目名） */
function makeVectorizeNodeHandler(
  node: VectorizeNode,
  ctx: NodeContext,
): NodeHandler {
  return async (state) => {
    const startedAt = Date.now();
    try {
      const render = (text: string) =>
        renderNodePrompt(text, {
          inputs: state.inputs,
          nodes: state.nodes,
          now: ctx.now,
        });
      const text = render(node.text);
      const collection = render(node.collection);
      const sourceName = render(node.sourceName);
      const { chunkText, upsertChunks } = await import('./vector-store');
      const chunks = chunkText(
        text,
        node.chunkSize ?? 500,
        node.chunkOverlap ?? 100,
      );
      if (chunks.length === 0) {
        throw new GraphNodeFailure(
          node.id,
          'vector_empty_text',
          '入库文本为空（未解析出任何内容）',
        );
      }
      const embedSignal = AbortSignal.any([
        ctx.abort,
        AbortSignal.timeout(node.timeoutMs ?? 120_000),
      ]);
      const vectors = await embedTexts(node.modelId, chunks, embedSignal);
      const modelKey = String(node.modelId);
      await upsertChunks({
        userId: ctx.userId,
        collection,
        sourceName,
        model: modelKey,
        chunks: chunks.map((chunk, index) => ({
          seq: index,
          text: chunk,
          vector: vectors[index],
        })),
      });
      const output = `已向量化入库：集合「${collection}」条目「${sourceName}」${chunks.length} 块`;
      await writeNodeRecord(ctx, node, sourceName, output, startedAt);
      ctx.trace.push(traceSuccess(node, startedAt, { output }));
      return toNodeUpdate(node.id, { output });
    } catch (e) {
      const failure = toNodeFailure(node, e);
      await writeNodeFailureRecord(
        ctx,
        node,
        node.collection,
        failure,
        startedAt,
      );
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}

/** 语义检索节点 handler：query → embedding → 同模型余弦 topK →
 * 「【条目名】片段」多段（对齐 librarySearch 输出形态，接 AI 节点） */
function makeVectorSearchNodeHandler(
  node: VectorSearchNode,
  ctx: NodeContext,
): NodeHandler {
  return async (state) => {
    const startedAt = Date.now();
    try {
      const render = (text: string) =>
        renderNodePrompt(text, {
          inputs: state.inputs,
          nodes: state.nodes,
          now: ctx.now,
        });
      const query = render(node.searchQuery);
      const collection = render(node.collection ?? '');
      const embedSignal = AbortSignal.any([
        ctx.abort,
        AbortSignal.timeout(node.timeoutMs ?? 120_000),
      ]);
      const [queryVector] = await embedTexts(
        node.modelId,
        [query],
        embedSignal,
      );
      const { searchChunks } = await import('./vector-store');
      const hits = await searchChunks({
        userId: ctx.userId,
        collection,
        model: String(node.modelId),
        queryVector,
        topK: node.topK ?? 5,
      });
      const output = hits
        .map(
          (hit) =>
            `【${hit.sourceName}｜相似度 ${hit.score.toFixed(2)}】${hit.text}`,
        )
        .join('\n\n');
      await writeNodeRecord(ctx, node, query, output, startedAt);
      ctx.trace.push(traceSuccess(node, startedAt, { output }));
      return toNodeUpdate(node.id, { output });
    } catch (e) {
      const failure = toNodeFailure(node, e);
      await writeNodeFailureRecord(
        ctx,
        node,
        node.searchQuery,
        failure,
        startedAt,
      );
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}

/** 数据库节点 handler：连接参数/SQL/params 全渲染 → runDatabaseQuery →
 * 结果 JSON 为 output（SELECT 行数组 / 写操作 affectedRows） */
function makeDatabaseNodeHandler(
  node: DatabaseNode,
  ctx: NodeContext,
): NodeHandler {
  return async (state) => {
    const startedAt = Date.now();
    const label = `${node.engine}:${node.database || node.sqlitePath}`;
    try {
      const render = (text: string) =>
        renderNodePrompt(text, {
          inputs: state.inputs,
          nodes: state.nodes,
          now: ctx.now,
        });
      const db = await import('./db-client');
      // 批量模式：batchSource 渲染后解析为二维参数数组（非数组/非二维 →
      // db_batch_invalid，与单语句 params 互不影响）
      let batchRows: string[][] | null = null;
      const batchRaw = render(node.batchSource ?? '');
      if (batchRaw.trim() !== '') {
        try {
          const parsed: unknown = JSON.parse(batchRaw);
          if (
            Array.isArray(parsed) &&
            parsed.every((row) => Array.isArray(row))
          ) {
            batchRows = (parsed as unknown[][]).map((row) =>
              row.map((cell) => String(cell ?? '')),
            );
          }
        } catch {
          // 非法 JSON 统一走下方报错
        }
        if (batchRows === null) {
          throw new GraphNodeFailure(
            node.id,
            'db_batch_invalid',
            '批量数据须为二维参数数组的 JSON（如 [[1,"a"],[2,"b"]]）',
          );
        }
      }
      const result = await retryAsync(
        () =>
          db.runDatabaseQuery({
            engine: node.engine,
            sqlitePath: render(node.sqlitePath),
            host: render(node.host),
            port: node.port,
            database: render(node.database),
            username: render(node.username),
            password: render(node.password),
            sql: render(node.sql),
            params: node.params.map((param) => render(param)),
            maxRows: node.maxRows ?? 1_000,
            batchRows,
            ctx,
          }),
        node.retries,
      );
      const output = db.formatDbResult(result, node.maxRows ?? 1_000);
      await writeNodeRecord(ctx, node, label, output, startedAt);
      ctx.trace.push(traceSuccess(node, startedAt, { output }));
      return toNodeUpdate(node.id, { output });
    } catch (e) {
      // DbError（db-client 定义）→ 结构化节点失败码；其余走通用归因
      const failure =
        e !== null && typeof e === 'object' && e.constructor?.name === 'DbError'
          ? new GraphNodeFailure(
              node.id,
              (e as { code: string }).code,
              (e as { message: string }).message,
            )
          : toNodeFailure(node, e);
      await writeNodeFailureRecord(ctx, node, label, failure, startedAt);
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}

/** Excel 读取节点 handler：xlsx → sheet 行数组 JSON（首行为键） */
function makeExcelReadNodeHandler(
  node: ExcelReadNode,
  ctx: NodeContext,
): NodeHandler {
  return async (state) => {
    const startedAt = Date.now();
    try {
      const raw = renderNodePrompt(node.path, {
        inputs: state.inputs,
        nodes: state.nodes,
        now: ctx.now,
      });
      const resolved = resolveWorkspaceFile(node.id, raw, ctx);
      const ExcelJS = await import('exceljs');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(resolved);
      const sheet = node.sheet ? wb.getWorksheet(node.sheet) : wb.worksheets[0];
      if (!sheet) {
        throw new GraphNodeFailure(
          node.id,
          'excel_sheet_missing',
          `工作表不存在: ${node.sheet || '(第一个)'}`,
        );
      }
      const header: string[] = [];
      sheet.getRow(1).eachCell((cell, col) => {
        header[col - 1] = String(cell.value ?? `col${col}`);
      });
      const maxRows = node.maxRows ?? 1_000;
      const rows: Array<Record<string, unknown>> = [];
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) {
          return;
        }
        // 熔断（csvRead 同款）：超限即失败，不静默截断行数组
        if (rows.length >= maxRows) {
          throw new GraphNodeFailure(
            node.id,
            'excel_too_many_rows',
            `Excel 数据超过上限 ${maxRows} 行（防失控熔断，可调大 maxRows 或分片处理）`,
          );
        }
        const record: Record<string, unknown> = {};
        header.forEach((key, index) => {
          const cell = row.getCell(index + 1);
          const value = cell.value;
          record[key] =
            value instanceof Object && 'result' in (value as object)
              ? (value as { result?: unknown }).result
              : value;
        });
        rows.push(record);
      });
      const output = JSON.stringify(rows);
      await writeNodeRecord(ctx, node, node.path, output, startedAt);
      ctx.trace.push(traceSuccess(node, startedAt, { output }));
      return toNodeUpdate(node.id, { output });
    } catch (e) {
      const failure = toNodeFailure(node, e);
      await writeNodeFailureRecord(ctx, node, node.path, failure, startedAt);
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}

/** Excel 写入节点 handler：JSON 行数组 → xlsx 写回工作空间（写授权） */
function makeExcelWriteNodeHandler(
  node: ExcelWriteNode,
  ctx: NodeContext,
): NodeHandler {
  return async (state) => {
    const startedAt = Date.now();
    try {
      if (!ctx.codeAuthorized) {
        throw new GraphNodeFailure(
          node.id,
          'file_write_denied',
          'Excel 写入需要任务开启「允许完全访问」（试运行不受限）',
        );
      }
      const render = (text: string) =>
        renderNodePrompt(text, {
          inputs: state.inputs,
          nodes: state.nodes,
          now: ctx.now,
        });
      const target = resolveWorkspaceFile(node.id, render(node.path), ctx);
      const source = render(node.rowsSource);
      let rows: Array<Record<string, unknown>>;
      try {
        const parsed: unknown = JSON.parse(source);
        if (!Array.isArray(parsed)) {
          throw new Error('不是 JSON 数组');
        }
        rows = parsed as Array<Record<string, unknown>>;
      } catch (e) {
        throw new GraphNodeFailure(
          node.id,
          'excel_rows_invalid',
          `行数据解析失败（须为 JSON 数组）: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const ExcelJS = await import('exceljs');
      const wb = new ExcelJS.Workbook();
      const sheet = wb.addWorksheet(node.sheet || 'Sheet1');
      if (rows.length > 0) {
        sheet.columns = Object.keys(rows[0]).map((key) => ({
          header: key,
          key,
        }));
        rows.forEach((row) => sheet.addRow(row));
      }
      const dir = path.dirname(target);
      const { mkdir } = await import('node:fs/promises');
      await mkdir(dir, { recursive: true });
      await wb.xlsx.writeFile(target);
      const output = `已写入 ${rows.length} 行: ${target}`;
      await writeNodeRecord(ctx, node, node.path, output, startedAt);
      ctx.trace.push(traceSuccess(node, startedAt, { output }));
      return toNodeUpdate(node.id, { output });
    } catch (e) {
      const failure = toNodeFailure(node, e);
      await writeNodeFailureRecord(ctx, node, node.path, failure, startedAt);
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}

/** CSV 分隔符语义枚举 → 字符（schema 语义值，前端下拉友好） */
const CSV_DELIMITERS: Record<CsvReadNode['delimiter'], string> = {
  comma: ',',
  semicolon: ';',
  tab: '\t',
};

/** RFC4180 字符级状态机：分块喂入，逐记录收集（跨行引号内容、引号内
 * "" 转义自然支持——pendingQuote 两字符判定兼容 chunk 边界切割）；记
 * 录数达 hardLimit 即抛（提前熔断不读尽大文件） */
class CsvParser {
  private field = '';
  private row: string[] = [];
  private inQuotes = false;
  /** 引号态下已见一个 "：下一字符是 " 则为转义，否则关闭引号 */
  private pendingQuote = false;

  constructor(
    private readonly delimiter: string,
    private readonly hardLimit: number,
    readonly records: string[][] = [],
  ) {}

  feed(chunk: string): void {
    for (const ch of chunk) {
      if (this.inQuotes) {
        if (this.pendingQuote) {
          if (ch === '"') {
            this.field += '"';
            this.pendingQuote = false;
            continue;
          }
          this.inQuotes = false;
          this.pendingQuote = false;
          // 引号关闭，当前字符交由下方非引号态处理
        } else if (ch === '"') {
          this.pendingQuote = true;
          continue;
        } else {
          this.field += ch;
          continue;
        }
      }
      if (ch === '"' && this.field === '') {
        this.inQuotes = true;
        continue;
      }
      if (ch === this.delimiter) {
        this.row.push(this.field);
        this.field = '';
        continue;
      }
      if (ch === '\n') {
        this.endRow();
        continue;
      }
      if (ch === '\r') {
        continue; // CRLF 容错（引号态的 \r 走上面分支保真）
      }
      this.field += ch;
    }
  }

  private endRow(): void {
    this.row.push(this.field);
    // 全空行（常见尾随换行产生的单空字段）跳过
    if (!(this.row.length === 1 && this.row[0] === '')) {
      this.records.push(this.row);
      if (this.records.length >= this.hardLimit) {
        throw new Error('csv-too-many-records');
      }
    }
    this.row = [];
    this.field = '';
  }

  /** 末行无换行时的收尾（悬空 pendingQuote 视为引号关闭） */
  flush(): void {
    this.pendingQuote = false;
    this.inQuotes = false;
    if (this.field !== '' || this.row.length > 0) {
      this.endRow();
    }
  }
}

/** 流式解析 CSV（createReadStream 分块喂状态机，源文件不全量驻留内存）；
 * hardLimit = 表头 + maxRows + 1 超额哨兵：达到即证明数据行必超上限 */
async function parseCsvStream(
  filePath: string,
  delimiter: string,
  hardLimit: number,
): Promise<string[][]> {
  const parser = new CsvParser(delimiter, hardLimit);
  const stream = createReadStream(filePath, 'utf8');
  try {
    for await (const chunk of stream) {
      parser.feed(String(chunk));
    }
    parser.flush();
  } catch (e) {
    stream.destroy();
    if (e instanceof Error && e.message === 'csv-too-many-records') {
      throw e;
    }
    throw new Error(`csv-read-error: ${e instanceof Error ? e.message : e}`, {
      cause: e,
    });
  }
  return parser.records;
}

/** CSV 字段转义（RFC4180）：含分隔符/引号/换行的值引号包裹 + 双引号
 * 翻倍；空串输出 ""（读回语义明确） */
function csvEscape(value: unknown): string {
  const s = value == null ? '' : String(value);
  return s === '' || /[",;\n\r\t]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** 行数组 → CSV 文本（表头 = 各行键的并集，保持首现顺序） */
function rowsToCsv(rows: Array<Record<string, unknown>>): string {
  const headers: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!headers.includes(key)) {
        headers.push(key);
      }
    }
  }
  return [
    headers.map(csvEscape).join(','),
    ...rows.map((row) => headers.map((key) => csvEscape(row[key])).join(',')),
  ].join('\n');
}

/** CSV 读取节点 handler：流式解析 → 首行为键的 JSON 行数组（excelRead
 * 同款输出形态）；maxRows 熔断（哨兵提前停读） */
function makeCsvReadNodeHandler(
  node: CsvReadNode,
  ctx: NodeContext,
): NodeHandler {
  return async (state) => {
    const startedAt = Date.now();
    try {
      const raw = renderNodePrompt(node.path, {
        inputs: state.inputs,
        nodes: state.nodes,
        now: ctx.now,
      });
      const resolved = resolveWorkspaceFile(node.id, raw, ctx);
      try {
        await stat(resolved);
      } catch {
        throw new GraphNodeFailure(
          node.id,
          'file_missing',
          `文件不存在: ${raw}`,
        );
      }
      const delimiter = CSV_DELIMITERS[node.delimiter];
      let records: string[][];
      try {
        records = await parseCsvStream(resolved, delimiter, node.maxRows + 2);
      } catch (e) {
        if (e instanceof Error && e.message === 'csv-too-many-records') {
          throw new GraphNodeFailure(
            node.id,
            'csv_too_many_rows',
            `CSV 数据超过上限 ${node.maxRows} 行（防失控熔断，可调大 maxRows 或分片处理）`,
          );
        }
        throw new GraphNodeFailure(
          node.id,
          'csv_read_failed',
          `CSV 读取失败: ${e instanceof Error ? e.message : e}`,
        );
      }
      const header = (records[0] ?? []).map((key, index) =>
        key.trim() !== '' ? key : `col${index + 1}`,
      );
      const rows = records.slice(1).map((record) => {
        const item: Record<string, unknown> = {};
        header.forEach((key, index) => {
          item[key] = record[index] ?? '';
        });
        return item;
      });
      const output = JSON.stringify(rows);
      await writeNodeRecord(ctx, node, node.path, output, startedAt);
      ctx.trace.push(traceSuccess(node, startedAt, { output }));
      return toNodeUpdate(node.id, { output });
    } catch (e) {
      const failure = toNodeFailure(node, e);
      await writeNodeFailureRecord(ctx, node, node.path, failure, startedAt);
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}

/** CSV 写入节点 handler：JSON 行数组 → 转义序列化写回工作空间（写授权
 * 与目录自建同 excelWrite）；输出回执 */
function makeCsvWriteNodeHandler(
  node: CsvWriteNode,
  ctx: NodeContext,
): NodeHandler {
  return async (state) => {
    const startedAt = Date.now();
    try {
      if (!ctx.codeAuthorized) {
        throw new GraphNodeFailure(
          node.id,
          'file_write_denied',
          'CSV 写入需要任务开启「允许完全访问」（试运行不受限）',
        );
      }
      const render = (text: string) =>
        renderNodePrompt(text, {
          inputs: state.inputs,
          nodes: state.nodes,
          now: ctx.now,
        });
      const target = resolveWorkspaceFile(node.id, render(node.path), ctx);
      const source = render(node.rowsSource);
      let rows: Array<Record<string, unknown>>;
      try {
        const parsed: unknown = JSON.parse(source);
        if (!Array.isArray(parsed)) {
          throw new Error('不是 JSON 数组');
        }
        rows = parsed as Array<Record<string, unknown>>;
      } catch (e) {
        throw new GraphNodeFailure(
          node.id,
          'csv_rows_invalid',
          `行数据解析失败（须为 JSON 数组）: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const dir = path.dirname(target);
      const { mkdir } = await import('node:fs/promises');
      await mkdir(dir, { recursive: true });
      await writeFile(target, rowsToCsv(rows), 'utf8');
      const output = `已写入 ${rows.length} 行: ${target}`;
      await writeNodeRecord(ctx, node, node.path, output, startedAt);
      ctx.trace.push(traceSuccess(node, startedAt, { output }));
      return toNodeUpdate(node.id, { output });
    } catch (e) {
      const failure = toNodeFailure(node, e);
      await writeNodeFailureRecord(ctx, node, node.path, failure, startedAt);
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}

/** 变量操作链求值（纯函数，导出受测）：toNumber 终态可为 number，其余
 * 保持 string；default 仅在当前为空串时兜底；日期算子以 now 为基准
 * （now 取执行时刻、dateAdd/dateFormat 解析当前值，非法日期保持原样） */
export function applyVariableTransforms(
  value: string,
  ops: VariableTransform[],
  now: Date,
): string | number {
  let current: string | number = value;
  for (const op of ops) {
    if (typeof current === 'number') {
      break; // toNumber 为终态（后续无字符串语义可应用）
    }
    switch (op.type) {
      case 'trim':
        current = current.trim();
        break;
      case 'upper':
        current = current.toUpperCase();
        break;
      case 'lower':
        current = current.toLowerCase();
        break;
      case 'replace':
        current = current.split(op.find).join(op.replacement);
        break;
      case 'slice':
        current =
          op.end === undefined
            ? current.slice(op.start)
            : current.slice(op.start, op.end);
        break;
      case 'default':
        current = current === '' ? op.value : current;
        break;
      case 'append':
        current = `${current}${op.text}`;
        break;
      case 'toNumber': {
        const text = current.trim();
        const parsed: number = Number(text);
        current = Number.isFinite(parsed) && text !== '' ? parsed : current;
        break;
      }
      case 'now':
        current = now.toISOString();
        break;
      case 'dateAdd': {
        const date = new Date(current);
        if (Number.isNaN(date.getTime())) {
          break; // 非法日期串保持原样
        }
        const shifted: Date = new Date(date.getTime());
        if (op.unit === 'minutes')
          shifted.setMinutes(shifted.getMinutes() + op.amount);
        else if (op.unit === 'hours')
          shifted.setHours(shifted.getHours() + op.amount);
        else if (op.unit === 'days')
          shifted.setDate(shifted.getDate() + op.amount);
        else shifted.setMonth(shifted.getMonth() + op.amount);
        current = shifted.toISOString();
        break;
      }
      case 'dateFormat': {
        const date = new Date(current);
        if (Number.isNaN(date.getTime())) {
          break; // 非法日期串保持原样
        }
        current = dateFnsFormat(date, op.format);
        break;
      }
    }
  }
  return current;
}

/** 变量节点 handler：多变量赋值（source 渲染 + 操作链）→ JSON 对象 */
function makeVariableNodeHandler(
  node: VariableNode,
  ctx: NodeContext,
): NodeHandler {
  return async (state) => {
    const startedAt = Date.now();
    const render = (text: string) =>
      renderNodePrompt(text, {
        inputs: state.inputs,
        nodes: state.nodes,
        now: ctx.now,
      });
    try {
      const result: Record<string, string | number> = {};
      for (const assignment of node.assignments) {
        result[assignment.name] = applyVariableTransforms(
          render(assignment.source),
          assignment.ops,
          ctx.now,
        );
      }
      const output = JSON.stringify(result);
      await writeNodeRecord(ctx, node, '变量赋值', output, startedAt);
      ctx.trace.push(traceSuccess(node, startedAt, { output }));
      return toNodeUpdate(node.id, { output });
    } catch (e) {
      const failure = toNodeFailure(node, e);
      await writeNodeFailureRecord(ctx, node, '变量赋值', failure, startedAt);
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}

/** 聚合行形态：JSON 行数组（对象行）优先，否则按非空行字符串 */
function aggregateRows(source: string): Array<Record<string, unknown>> {
  const trimmed = source.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item): item is Record<string, unknown> =>
            item !== null && typeof item === 'object' && !Array.isArray(item),
        );
      }
    } catch {
      // 非法 JSON：回落按行
    }
  }
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => ({ line }));
}

/** 数值字段提取：行值（string/number）Number 化，其余类型报错（键名带
 * 字段名，定位到列） */
function numericField(
  node: VariableNode | AggregateNode,
  row: Record<string, unknown>,
  field: string,
): number {
  const raw = row[field];
  if (raw === undefined) {
    throw new GraphNodeFailure(
      node.id,
      'aggregate_bad_field',
      `字段不存在: ${field}`,
    );
  }
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (
    !Number.isFinite(value) ||
    (typeof raw !== 'number' && String(raw).trim() === '')
  ) {
    throw new GraphNodeFailure(
      node.id,
      'aggregate_bad_field',
      `字段非数值: ${field}=${String(raw)}`,
    );
  }
  return value;
}

/** 聚合统计节点 handler：source → 各操作结果按键的 JSON 对象 */
function makeAggregateNodeHandler(
  node: AggregateNode,
  ctx: NodeContext,
): NodeHandler {
  return async (state) => {
    const startedAt = Date.now();
    try {
      const source = renderNodePrompt(node.source, {
        inputs: state.inputs,
        nodes: state.nodes,
        now: ctx.now,
      });
      const rows = aggregateRows(source);
      const result: Record<string, unknown> = {};
      for (const op of node.ops) {
        const key =
          'field' in op && op.field ? `${op.type}:${op.field}` : op.type;
        switch (op.type) {
          case 'count':
            result[key] = rows.length;
            break;
          case 'sum':
          case 'avg':
          case 'min':
          case 'max': {
            const values = rows.map((row) => numericField(node, row, op.field));
            const sum = values.reduce((acc, value) => acc + value, 0);
            result[key] =
              op.type === 'sum'
                ? sum
                : op.type === 'avg'
                  ? values.length === 0
                    ? 0
                    : sum / values.length
                  : op.type === 'min'
                    ? Math.min(...values)
                    : Math.max(...values);
            break;
          }
          case 'distinctCount': {
            const seen = new Set(
              rows.map((row) =>
                op.field ? String(row[op.field] ?? '') : JSON.stringify(row),
              ),
            );
            result[key] = seen.size;
            break;
          }
          case 'groupByCount': {
            const groups: Record<string, number> = {};
            for (const row of rows) {
              const group = String(row[op.field] ?? '');
              groups[group] = (groups[group] ?? 0) + 1;
            }
            result[key] = groups;
            break;
          }
        }
      }
      const output = JSON.stringify(result);
      await writeNodeRecord(ctx, node, '聚合统计', output, startedAt);
      ctx.trace.push(traceSuccess(node, startedAt, { output }));
      return toNodeUpdate(node.id, { output });
    } catch (e) {
      const failure = toNodeFailure(node, e);
      await writeNodeFailureRecord(ctx, node, '聚合统计', failure, startedAt);
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}

/** 邮件节点 handler：nodemailer SMTP 直连；from/to/subject/body 渲染后
 * 发送（30s 超时），失败归因 email_send_failed */
function makeEmailNodeHandler(node: EmailNode, ctx: NodeContext): NodeHandler {
  return async (state) => {
    const startedAt = Date.now();
    const render = (text: string) =>
      renderNodePrompt(text, {
        inputs: state.inputs,
        nodes: state.nodes,
        now: ctx.now,
      });
    try {
      // 授权面 8：nodemailer server 未安装（vendor-decls.d.ts 保类型）——
      // 由静态导入改懒加载：未装驱动时本节点报 email_send_failed（驱动
      // 按需安装后即通，不影响模块加载与其余节点）
      const mod = await import('nodemailer');
      const nodemailer = ((mod as { default?: unknown }).default ??
        mod) as unknown as {
        createTransport: (opts: unknown) => {
          sendMail: (opts: unknown) => Promise<{ messageId?: string }>;
        };
      };
      const transport = nodemailer.createTransport({
        host: node.host,
        port: node.port,
        secure: node.secure,
        ...(node.username !== ''
          ? { auth: { user: node.username, pass: node.password } }
          : {}),
        connectionTimeout: 30_000,
      });
      const info = await retryAsync(
        () =>
          transport.sendMail({
            from: render(node.from),
            to: render(node.to),
            subject: render(node.subject),
            text: render(node.body),
          }),
        node.retries,
      );
      const output = `邮件已发送: ${render(node.to)} (#${info.messageId ?? '-'})`;
      await writeNodeRecord(ctx, node, node.subject, output, startedAt);
      ctx.trace.push(traceSuccess(node, startedAt, { output }));
      return toNodeUpdate(node.id, { output });
    } catch (e) {
      const failure = toNodeFailure(
        node,
        new GraphNodeFailure(
          node.id,
          'email_send_failed',
          `邮件发送失败: ${e instanceof Error ? e.message : e}`,
        ),
      );
      await writeNodeFailureRecord(ctx, node, node.subject, failure, startedAt);
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}

/** 聚合节点 handler：多上游输出按模板聚合为单 output（多入边天然
 * 等待全部上游完成——LangGraph 拓扑同步，state.nodes 已含各上游结果） */
function makeMergeNodeHandler(node: MergeNode, ctx: NodeContext): NodeHandler {
  return async (state) => {
    const startedAt = Date.now();
    try {
      const output = renderNodePrompt(node.template, {
        inputs: state.inputs,
        nodes: state.nodes,
        now: ctx.now,
      });
      await writeNodeRecord(ctx, node, '聚合', output, startedAt);
      ctx.trace.push(traceSuccess(node, startedAt, { output }));
      return toNodeUpdate(node.id, { output });
    } catch (e) {
      const failure = toNodeFailure(node, e);
      await writeNodeFailureRecord(ctx, node, '聚合', failure, startedAt);
      ctx.trace.push(traceFailure(node, startedAt, failure));
      throw failure;
    }
  };
}

/** IM webhook 消息体（飞书/钉钉/企微文本格式；custom 发标准
 * {title, body} JSON 供自建服务解析） */
function notifyWebhookPayload(
  provider: 'feishu' | 'dingtalk' | 'wecom' | 'custom',
  title: string,
  body: string,
): Record<string, unknown> {
  const text = body ? `${title}\n${body}` : title;
  switch (provider) {
    case 'feishu':
      return { msg_type: 'text', content: { text } };
    case 'dingtalk':
      return { msgtype: 'text', text: { content: text } };
    case 'wecom':
      return { msgtype: 'text', text: { content: text } };
    case 'custom':
      return { title, body };
  }
}

/** POST IM webhook（30s 超时；非 2xx 抛错由调用方记日志） */
async function sendNotifyWebhook(
  provider: 'feishu' | 'dingtalk' | 'wecom' | 'custom',
  url: string,
  title: string,
  body: string,
  abort: AbortSignal,
): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(notifyWebhookPayload(provider, title, body)),
    signal: AbortSignal.any([abort, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok) {
    throw new Error(`webhook HTTP ${response.status}`);
  }
}

/** ================= GA-T4 授权面 5 断环摘取（自 mirror
 * electron/domains/ai/automation/automation-runner.ts 忠实搬移；runner 调
 * executor、executor 不反调 runner——四符号居 executor 侧，T5 runner 副本
 * 自此处单向引；函数体与 mirror 逐行等价（唯一例外 collectTools 白名单含
 * library_search，PL-3 独有分叉——header 改造点 9），prisma 经运行时句柄
 * 与 registry/makeReadSkillTool 指 server 副本） ================= */

/** 工具集组装（对齐 chat.service collectToolDefinitions：read_skill 常驻）。
 * 第三参（注入层禁用=对模型不存在）：闭包实时读配置，缺省不滤（行为与
 * mirror 一致）。
 * PL-3 裁定（PL-T2 concern ①）：无工作空间白名单加入 library_search——
 * 用户级资料库无属地语义，与 chat 侧 collectToolDefinitions 常驻一致；
 * mirror 无该工具，此为 server 独有偏离（header 改造点 9） */
export async function collectTools(
  workspacePath: string | undefined,
  skills: SkillInfo[],
  disabled: () => string[] = () => [],
) {
  // plan_* 仅项目会话可用（依赖 ctx.projectId）；定时任务 agent 不带
  // projectId，带上只会得到「未关联项目」拒绝——剔除，避免污染模型的
  // 工具列表
  const registered = registry
    .getDefinitions()
    .filter((def) => !def.name.startsWith('plan_'));
  const injected = workspacePath
    ? registered
    : registered.filter(
        (def) =>
          def.name.startsWith('mcp__') ||
          def.name === 'run_command' ||
          def.name === 'create_skill' ||
          // PL-3 裁定：library_search 常驻（资料库用户级无属地语义）
          def.name === 'library_search',
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

/** 无人值守权限分流：full=完全访问+审批放行（原行为）；default=只读执行，
 * 写类审批被拒但任务继续（agent 收到拒绝反馈），与会话 default 语义对齐。
 * isToolAllowed 必须随 full 变 false：写门禁对 isToolAllowed=true 的工具
 * 直接放行（门禁短路），requestApproval 永不触达 */
export function resolveAutomationPermissions(
  accessMode: 'default' | 'full',
): AutomationPermissions {
  const full = accessMode === 'full';
  return {
    fullAccess: () => full,
    isToolAllowed: async () => full,
    requestApproval: async () => full,
  };
}

/** 调度推进（mirror advanceTask 同款）：manual/event 直返；其余按
 * scheduleJson 算下次运行，once+成功 → expired */
export async function advanceTask(
  task: AutomationTaskRow,
  now: Date,
  outcome: 'success' | 'failed',
  triggerType: 'schedule' | 'catchUp' | 'retry' | 'manual' | 'event',
): Promise<void> {
  if (triggerType === 'manual' || triggerType === 'event') {
    return;
  }
  const schedule = JSON.parse(task.scheduleJson) as ScheduleConfig;
  const next = computeNextRun(schedule, now, now);
  await graphExecutorRuntime().db.automationTask.update({
    where: { id: task.id },
    data: {
      lastRunAt: now,
      nextRunAt: next,
      ...(schedule.mode === 'periodic' &&
        schedule.kind === 'once' &&
        outcome === 'success' && { status: 'expired' }),
    },
  });
}
