import { clipboard, dialog, ipcMain, shell, type WebContents } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  DEFAULT_MAX_STEPS,
  listWorkspaceFiles,
  readTextFileGuarded,
  runChatStream as runChatStreamCore,
  type ChatStreamOptions as ChatStreamOptionsCore,
  type ChatStreamResult,
} from "@tianshu/core";
import prisma from "../../../commons/prisma-client";
import {
  skillsDir,
  attachmentsDir,
  libraryDir,
  appDataHome,
} from "../../../commons/paths";
import Log from "../../../commons/Log";
import { handleUser } from "../../../commons/ipc-user";
import { buildPersonalizedSystem } from "../personalization/personalization.prompt";
import { loadPersonalization } from "../personalization/personalization.repo";
import { aiMessageContentToText } from "./ai-content";
import { createLangChainAgentRunner } from "./agent-runner";
import { parseBlocks, serializeBlocks, type ImageBlock } from "./blocks";
import { mergeParams, type ChatModelParams } from "./param-merge";
import { buildScenarioSystem } from "./scenario-prompt";
import { withTimeBlock } from "./time-context";
import {
  estimateMessageTokens,
  estimateReserveTokens,
  estimateTokens,
} from "./history-truncate";
import { trimHistoryToolOutputs } from "./tool-output-trim";
import {
  computeUsageBreakdown,
  type ContextUsageBreakdown,
} from "./context-usage";
import {
  imageAttachmentBlocks,
  readImageAsDataUrl,
  readWorkspaceFile,
  stageImageIntoAttachments,
} from "./workspace-files";
import { savePastedImage } from "./pasted-image-store";
// 聊天输出导出批：dataUrl 图片另存为纯函数（file:saveDataUrl 消费）
import {
  parseImageDataUrl,
  sanitizeSaveName,
  saveImageDataUrl,
} from "./media-export";
import {
  broadcastFileChangedFor,
  notifyLibraryFileWritten,
} from "../file-window/file-write-ipc";
import { grantedPathsOf, grantedSyncOf } from "../file-window/granted-paths";
import { emitChatChunk } from "../../server-face/chat-tap";
import {
  grantExternalPaths,
  isExternalReadAllowed,
} from "./external-file-gate";
import { createChatModel } from "../orchestration/langchain-model-factory";
import { toLangChainTools } from "../orchestration/langchain-tool-adapter";
import {
  runHandoverSummary,
  type HandoverModelTextFn,
} from "./handover-summary";
import { SessionRepository, type AppendMessageParams } from "./session.repo";
import {
  registry,
  registerTools,
  filterDisabledTools,
} from "../agent/tool-registry";
import {
  filterToolsBySession,
  isWorkflowGroupAllowed,
  WORKFLOW_CREATOR_SKILL_NAME,
  type ToolGroupGate,
} from "../agent/tool-groups";
import { loadSkills, type SkillInfo } from "../agent/skill-loader";
import { buildSystemPrompt } from "../agent/skill-prompt";
import { makeReadSkillTool } from "../agent/read-skill";
import { makePlanTools } from "../agent/plan-tools";
import { makeWidgetTool, WIDGET_TOOL_NAME } from "../agent/widget-tool";
import {
  DISPATCH_MEMBER_TOOL_NAME,
  makeDispatchMemberTool,
  type DispatchMemberDeps,
  type DispatchMemberModelTextFn,
} from "../agent/dispatch-member-tool";
import { RECOMMEND_TOOL_NAME } from "../agent/recommend-expert-tool";
import {
  CREATE_EXPERT_TOOL_NAME,
  UPDATE_EXPERT_TOOL_NAME,
} from "../agent/create-expert";
import {
  buildExpertCatalogPrompt,
  mergeExpertSkills,
  parseJsonStringArray,
} from "./expert-catalog";
import { buildTeamLeadSystem, parseTeamMembers } from "./expert-team";
import { MARKET_EXPERTS } from "../../../../src-react/domains/ai/experts/data/marketplace";
import { filterDisabledSkills } from "../skill/skill-sync";
import type { ToolDefinition } from "../agent/file-tools";
import { resolveSafePath } from "../agent/file-tools";
import { ApprovalCoordinator } from "../agent/approval";
import { PermissionStore } from "../agent/permission-mode";
import {
  BULK_DELETE_THRESHOLD_DEFAULT,
  type AgentStreamOptions,
} from "../agent/tool-gate";
import { normalizeWorkspacePath } from "../agent/workspace-path";
import {
  buildProjectSystemBase,
  type ProjectPromptContext,
} from "../../project/project-prompt";
import type ProjectRepository from "../../project/project.repo";
import type {
  ChatSendParams,
  ChatStatusResult,
  ChatStreamChunk,
  PolishStyle,
} from "../../../../src-react/domains/ai/api/chat.api";
import type { WorkspaceRecord } from "../../../../src-react/domains/ai/api/workspace.api";
import type { SecurityEventSink } from "../../../../src-react/domains/security/model/types";
import { commandGate } from "../../security/command-gate";
import { fileGate } from "../../security/file-gate";
import type { BackupFileResult } from "../../security/file-history";
import {
  recordLlmCall,
  recordToolCall,
  usageFromBlocks,
} from "../monitor/monitor-events";

type AssistantRow = NonNullable<
  Awaited<ReturnType<typeof prisma.assistant.findFirst>>
>;

/** 会话消息行（regenerate / editAndResend 定位与截断共用） */
type ChatMessageRow = Awaited<
  ReturnType<typeof prisma.message.findMany>
>[number];

// plan_* 工具组静态注册进聚合 registry（模块加载一次；create_skill 经
// SkillRepository 构造注册先例）。项目会话专属——collectToolDefinitions
// 按会话归属过滤，非项目会话剔除；三工具均 write → 走统一两级审批门禁
registerTools(makePlanTools({ prisma }));
// show_widget：聊天面板可视化组件（渲染层消费 args，无工作空间依赖）
registerTools([makeWidgetTool()]);

/** /compact 摘要指令:让模型基于全量历史输出可独立携带的上下文摘要 */
export const COMPACT_DIRECTIVE =
  "请把以上对话压缩为一份简洁的上下文摘要,供后续对话直接引用:保留关键事实、已做的决定、未决事项、重要的文件路径/引用与代码要点,舍弃寒暄与过程细节。直接输出摘要正文,不要任何前言。";

/**
 * 自动压缩指令（spec §18 项 2）：COMPACT_DIRECTIVE 加「[自动压缩]」前缀
 * 落库——自动触发时用户并未输入指令，前缀标明该轮来源（主进程文案不
 * 适用 i18n，中文常量风格同 COMPACT_DIRECTIVE；模型可见前缀无害）
 */
export const AUTO_COMPACT_DIRECTIVE = `[自动压缩] ${COMPACT_DIRECTIVE}`;

/** 压缩指令轮豁免判定：指令原文 send 不再触发自动压缩（防递归/重复压缩） */
const isCompactDirective = (content: string): boolean =>
  content === COMPACT_DIRECTIVE || content === AUTO_COMPACT_DIRECTIVE;

/** 自动压缩触发阈值：估算预算占 contextWindow 比例（spec §18 项 2） */
const AUTO_COMPACT_TRIGGER_RATIO = 0.8;
/** 自动压缩冷却带：上次压缩后成本需再涨 20% 才可再压（防每轮连压） */
const AUTO_COMPACT_COOLDOWN_GROWTH = 1.2;

/** 落地页润色补全指令（新建任务 spec §4.3）：给模型看，不进 i18n */
const STYLE_PROMPTS: Record<string, string> = {
  professional:
    "请将以下文本改写得更专业、正式，保留原意与结构，直接输出改写结果：",
  concise: "请将以下文本精简压缩，保留关键信息，直接输出精简结果：",
  "translate-en": "请将以下中文文本翻译成英文，直接输出译文：",
};

/** assistant blocks JSON → 纯文本(text 块拼接;解析失败返回空串) */
function extractAssistantText(blocksJson: string): string {
  try {
    const blocks = JSON.parse(blocksJson) as Array<{
      type: string;
      text?: string;
    }>;
    return blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
  } catch {
    return "";
  }
}

/** P3 计划模式指令段（设计 spec §4 逐字） */
const PLAN_MODE_INSTRUCTION =
  "当前处于计划模式：请先分析任务并输出完整可执行的计划（步骤/涉及文件/命令），在我明确确认之前不要调用任何工具执行操作。";

/**
 * 工作流意图尾注（spec §20 项 B 第三信号）：read_skill 读到
 * workflow-creator 时追加在正文尾——工具面经 langgraph 构造期固定，
 * 同 send 内无法动态挂载，尾注指引模型告知用户下一轮即可用
 */
const WORKFLOW_INTENT_NOTE =
  "（系统注：已为本会话挂载工作流工具（create_workflow 等）。工具面自下一轮对话起生效——若本轮不可调用，请提示用户继续发送一条消息。）";

/**
 * 工作流挂载元说明（未挂载会话注入 system，场景段之后）：模型面对
 * 「工具面板没有 create_workflow」曾无从知晓解锁路径（场景切换/读
 * workflow-creator 下一轮挂载），只能"猜生效时机"并以写文件绕行兜底
 * ——本段把挂载规则显式告知。注入条件四合一（缺一不注入）：agent
 * 模式（ask/plan 零工具语境无意义）、工作流组未挂载、workflow-creator
 * 在可读技能集（不在则 read_skill 指向死路）、read_skill 未被安全
 * 中心禁用（G1 联动：目录段同款门控）
 */
const WORKFLOW_MOUNT_NOTE =
  "【工作流工具挂载】create_workflow 等工作流工具当前未挂载。需要创建或管理工作流时：先调用 read_skill 读取 workflow-creator 技能——读取后自下一轮对话起自动挂载工作流工具（届时请提示用户再发送一条消息）；或请用户将场景切换为 automation/coding。工作流定义应经 create_workflow 落库，不要以写文件方式绕行保存。";

/**
 * 数据安全装配（SP4）：ChatService 构造注入，闭包实时读安全中心配置
 * （运行中改配置即生效）；缺席（测试/未接线）时走缺省值
 */
export interface ChatDataSafety {
  /** 图执行无会话传 null（备份落 0/ 目录，见 FileHistoryService.backupFile） */
  backupFile: (
    absPath: string,
    sessionId: number | null,
  ) => Promise<BackupFileResult>;
  deleteProtection: () => boolean;
  bulkDeleteThreshold: () => number;
}

/**
 * 流式执行入参/出参契约：定义在 @tianshu/core（RC-T4 随 runChatStream 剥出
 * 入包，packages/tianshu-core/src/run-chat-stream.ts）；此处按 mirror 域内
 * 真身收窄泛型（toolDefinitions=agent 域 ToolDefinition、agent=
 * AgentStreamOptions）并隐藏 toTools 注入点——适配器由下方包装层固定注入，
 * 既有调用方（streamAndPersist/automation-runner/单测）签名不变
 */
export type ChatStreamOptions = Omit<
  ChatStreamOptionsCore<ToolDefinition, AgentStreamOptions>,
  "toTools"
>;

export type { ChatStreamResult };

/**
 * 流式执行核心（实现已入 @tianshu/core，RC-T4）：mirror 装配薄包装——固定
 * 注入 toLangChainTools（工具适配依赖 agent/tool-gate 的 runToolCall 安全
 * 门/审批/审计链与 zod，electron 域闭包不入包，故经参数注入）。可注入
 * model 与工具，供单测；行为与剥出前逐行等价
 */
export async function runChatStream(
  options: ChatStreamOptions,
): Promise<ChatStreamResult> {
  return runChatStreamCore({
    ...options,
    toTools: toLangChainTools,
  });
}

/**
 * 按会话模式组装 system（P3 spec R5）：ask 仅助手原文（技能清单不注入）；
 * plan 在技能组装结果之后以空行追加计划指令段；agent 现状
 */
function buildModeSystem(
  mode: "agent" | "ask" | "plan",
  base: string | undefined,
  skills: SkillInfo[],
): string | undefined {
  if (mode === "ask") {
    return base;
  }
  const withSkills = buildSystemPrompt(base, skills);
  if (mode !== "plan") {
    return withSkills;
  }
  return withSkills
    ? `${withSkills}\n\n${PLAN_MODE_INSTRUCTION}`
    : PLAN_MODE_INSTRUCTION;
}

/** 项目会话工具硬隔离结果（项目模块二期 §3.7）：ask 模式不适用（零工具零技能） */
interface ProjectToolIsolation {
  /** 过滤后技能清单（= 启用扫描结果 ∩ 挂载技能名，system 清单预设聚焦用） */
  skills: SkillInfo[];
  /** 声明段消费的项目上下文（技能名收窄到实际可用集，防声明未安装技能名） */
  declaredCtx: ProjectPromptContext;
}

/**
 * 项目会话能力预设（二期 §3.7 修正：预设≠围墙）：技能清单与声明段
 * 按挂载集收窄（system prompt 引导优先），但工具集不做硬过滤——
 * 会话中可按需使用预设外的技能/连接器（read_skill 全量、mcp 全量）。
 * 纯函数：由 assembleContext 在项目上下文非空且非 ask 模式时调用
 */
function isolateProjectTools(
  skills: SkillInfo[],
  projectCtx: ProjectPromptContext,
): ProjectToolIsolation {
  const mounted = skills.filter((skill) =>
    projectCtx.boundSkillNames.includes(skill.name),
  );
  return {
    skills: mounted,
    declaredCtx: {
      ...projectCtx,
      boundSkillNames: mounted.map((skill) => skill.name),
    },
  };
}

/** SP6 系统授权卡：完全访问会话行（permission:listFullGrants 载荷，spec §4.1） */
export interface FullSessionGrant {
  sessionId: number;
  title: string;
}

/** SP6 系统授权卡：工具记忆行（permission:listRemembered 载荷，spec §4.2） */
export interface RememberedToolGrant {
  id: number;
  workspaceName: string;
  toolName: string;
  createdAt: string;
}

/** 流式工具态快照（chat:status 恢复渲染层 agent 态用，与 T6 store 同构） */
export interface ToolSnapshotState {
  toolName: string;
  args?: unknown;
  state: string;
  output?: string;
  argSummary?: string;
}

interface StreamSnapshot {
  text: string;
  thinking: string;
  tools: { order: string[]; map: Record<string, ToolSnapshotState> };
}

function emptySnapshot(): StreamSnapshot {
  return { text: "", thinking: "", tools: { order: [], map: {} } };
}

type ToolStreamChunk = Extract<
  ChatStreamChunk,
  { type: "tool-update" | "approval-request" }
>;

/** 最小依赖接口：禁用名单（测试可注入 stub）+ 工作流门控三列清单
 *  （可选成员——窄 stub 缺席时 workflow-creator 视为未启用；生产实例为
 *  SkillRepository，门控与 AssistantRepository 装配共用同一实例） */
type SkillDisabledLookup = {
  getDisabledNames(): Promise<Set<string>>;
  listGateStatus?(): Promise<
    Array<{ name: string; source: string; enabled: boolean }>
  >;
};

export default class ChatService {
  private aborts = new Map<number, AbortController>();
  private snapshots = new Map<number, StreamSnapshot>();
  private approvals = new ApprovalCoordinator();
  /**
   * 引擎接缝（AR-T1）：LangChain runChatStream 桥接 AgentRunner 契约
   * （@tianshu/protocol agent-runner——AsyncIterable chunk 流 + approve）。
   * streamAndPersist 已切至 runner.run() 消费（AR-T2 焊实）；换基座
   * （DeepSeek harness 等）时第二实现替换此处注入即可——chunk 协议/
   * 审批流/UI 零改动
   */
  private readonly agentRunner = createLangChainAgentRunner({
    runStream: runChatStream,
    respond: (toolCallId, approved) =>
      this.approvals.respond(toolCallId, approved),
  });
  /** P3：会话工具权限模式（内存态，spec §8：无会话校验静默收） */
  private permissions = new PermissionStore();
  /**
   * 会话级工作流意图（spec §20 项 B 第三信号）：read_skill 读过
   * workflow-creator 的会话自此开门——「使用即意图」。进程内存态
   * （重启清零，重读技能即恢复；会话删除不清理，量级为数字键可忽略）
   */
  private readonly workflowIntentSessions = new Set<number>();
  /** CU 批会话工具权限公有面（server-face 桥消费——归属校验同 IPC 口径） */
  async getAccessMode(
    sessionId: number,
    userId: number,
  ): Promise<"default" | "full"> {
    await this.sessions.assertSessionOwned(sessionId, userId);
    return this.permissions.get(sessionId);
  }

  async setAccessMode(
    sessionId: number,
    mode: "default" | "full",
    userId: number,
  ): Promise<void> {
    await this.sessions.assertSessionOwned(sessionId, userId);
    this.permissions.set(sessionId, mode);
  }
  /**
   * 自动压缩冷却基线（spec §18 项 2）：sessionId → 上次自动压缩完成后的
   * 即时预算成本；再压需当前成本 ≥ 基线 × 1.2。内存态（会话粒度，重启
   * 丢失可接受——丢失只是允许再压，冷却带是防抖非安全语义）
   */
  private autoCompactBaselines = new Map<number, number>();

  constructor(
    private sessions: SessionRepository,
    private skillRepo?: SkillDisabledLookup,
    // 项目模块一期：项目会话 base 注入项目上下文（项目指令+挂载专家）；
    // repo 缺席（测试）时回退助手 prompt，行为与非项目会话一致
    private projectRepo?: ProjectRepository,
    // 审计事件出口（SP1）：Application 注入 auditLogService.append；
    // 缺席（测试/未接线）时全部回调静默空转，行为与接入前一致
    private auditSink?: SecurityEventSink,
    // 数据安全装配（SP4）：Application 注入备份/删除保护/批量阈值闭包；
    // 缺席（测试/未接线）时走缺省值，行为与接入前一致
    private dataSafety?: ChatDataSafety,
    // 运行时工具过滤（SP6 裁定 2）：Application 注入安全配置禁用清单闭包；
    // 缺席（测试）不滤，行为与接入前一致
    private runtimeFilter?: () => string[],
    // 转办交接摘要模型补全（批 12）：缺席走真实 LangChain invoke；
    // 测试注入 stub（memory-compiler ModelTextFn 同款模式）
    private handoverModelText?: HandoverModelTextFn,
  ) {
    this.registerHandlers();
  }

  private registerHandlers() {
    // v12 多用户隔离：用户数据通道统一 handleUser（token → userId），
    // 归属校验在会话/空间维度（不存在与他人所有同报错）
    handleUser("chat:send", (event, userId, params: ChatSendParams) =>
      this.send(params, userId, event.sender),
    );
    handleUser("chat:compact", (event, userId, sessionId: number) =>
      this.compact(sessionId, userId, event.sender),
    );
    handleUser(
      "chat:regenerate",
      (event, userId, sessionId: number, messageId?: number) =>
        this.regenerate(sessionId, userId, messageId, event.sender),
    );
    // 编辑重发：改写目标 user 消息并删除其后全部，重跑流
    handleUser(
      "chat:editAndResend",
      (event, userId, sessionId: number, messageId: number, content: string) =>
        this.editAndResend(sessionId, userId, messageId, content, event.sender),
    );
    handleUser("chat:stop", async (_, userId, sessionId: number) => {
      await this.sessions.assertSessionOwned(sessionId, userId);
      this.stop(sessionId);
    });
    handleUser("chat:status", async (_, userId, sessionId: number) => {
      await this.sessions.assertSessionOwned(sessionId, userId);
      return this.status(sessionId);
    });
    // 上下文用量拆解（输入框环形指示器数据源）
    handleUser("chat:usage", (_, userId, sessionId: number) =>
      this.getUsageBreakdown(sessionId, userId),
    );
    // 落地页润色（新建任务 spec §4.3）：一次性非流式补全，不落库不建 session
    handleUser(
      "chat:polish",
      (
        _,
        userId,
        p: { workspaceId: number; text: string; style: PolishStyle },
      ) => this.polishText(p, userId),
    );
    // 转办交接摘要（批 12）：一次性补全不落库，摘要经弹框确认后另存待办
    handleUser("chat:handoverSummary", (_, userId, sessionId: number) =>
      this.handoverSummary(sessionId, userId),
    );
    // P1 审批决议：渲染层 → 主进程，resolve 挂起的 write 工具。
    // 审批卡产生于已校验归属的会话流内（toolCallId 一次性），运行态不落库；
    // handleUser 鉴权后 userId 亦不参与（工具执行时按会话归属校验）
    handleUser(
      "agent:approve",
      (_, _userId, toolCallId: string, approved: boolean) =>
        this.approvals.respond(toolCallId, approved),
    );
    // P3 会话工具权限：default 询问 / full 放行（spec §8：无会话校验静默收）
    handleUser("permission:get", async (_, userId, sessionId: number) => {
      await this.sessions.assertSessionOwned(sessionId, userId);
      return this.permissions.get(sessionId);
    });
    handleUser(
      "permission:set",
      async (_, userId, sessionId: number, mode: "default" | "full") => {
        await this.sessions.assertSessionOwned(sessionId, userId);
        return this.permissions.set(sessionId, mode);
      },
    );
    // P4 工作空间级工具记忆（参照 Claude Code allowed-tools）：
    // 「允许并记住」写表 → 该工具在本工作空间后续免审
    handleUser(
      "permission:rememberTool",
      async (
        _,
        userId,
        workspaceId: number,
        toolName: string,
      ): Promise<void> => {
        await this.rememberTool(workspaceId, toolName, userId);
      },
    );
    handleUser(
      "permission:listAllowedTools",
      async (_, userId, workspaceId: number): Promise<string[]> => {
        await this.sessions.assertWorkspaceOwned(workspaceId, userId);
        return prisma.toolPermission
          .findMany({
            where: { workspaceId },
            orderBy: { createdAt: "desc" },
            select: { toolName: true },
          })
          .then((rows) => rows.map((row) => row.toolName));
      },
    );
    handleUser(
      "permission:forgetTool",
      async (
        _,
        userId,
        workspaceId: number,
        toolName: string,
      ): Promise<void> => {
        await this.sessions.assertWorkspaceOwned(workspaceId, userId);
        await prisma.toolPermission.deleteMany({
          where: { workspaceId, toolName },
        });
      },
    );
    // SP6 系统授权卡：full 会话总览与一键收回（spec §4.1）。
    // 运行态内存表（主进程单实例），收回属收紧权限无泄露面，维持全局通道
    ipcMain.handle(
      "permission:listFullGrants",
      (): Promise<FullSessionGrant[]> => this.listFullGrants(),
    );
    ipcMain.handle("permission:revokeAllFull", (): number =>
      this.revokeAllFull(),
    );
    // SP6 工具记忆管理（spec §4.2）：撤销后该工具回到逐次审批流
    handleUser(
      "permission:listRemembered",
      (_, userId): Promise<RememberedToolGrant[]> =>
        this.listRemembered(userId),
    );
    handleUser(
      "permission:revokeRemembered",
      (_, userId, id: number): Promise<void> =>
        this.revokeRemembered(id, userId),
    );
    handleUser("permission:revokeAllRemembered", (_, userId): Promise<number> =>
      this.revokeAllRemembered(userId),
    );
    // P1 工作空间目录绑定：目录选择弹窗在主进程（dialog 属 GUI，repo 不引 electron）。
    // 用户取消返回 null，渲染层静默处理；存入前归一化（resolve + 去尾分隔符）
    handleUser(
      "workspace:bindDirectory",
      async (
        _,
        userId,
        workspaceId: number,
      ): Promise<WorkspaceRecord | null> => {
        const result = await dialog.showOpenDialog({
          properties: ["openDirectory"],
        });
        if (result.canceled || !result.filePaths[0]) {
          return null;
        }
        return this.sessions.updateWorkspaceBoundDirectory(
          workspaceId,
          normalizeWorkspacePath(result.filePaths[0]),
          userId,
        );
      },
    );
    // 解绑走同一写通道（null = 解绑），独立于 workspace:update 参数类型
    handleUser(
      "workspace:unbindDirectory",
      async (_, userId, workspaceId: number): Promise<WorkspaceRecord | null> =>
        this.sessions.updateWorkspaceBoundDirectory(workspaceId, null, userId),
    );
    // 新建任务页「打开本地空间」：一次调用 = 目录选择 + 以目录名建空间并
    // 绑定（用户取消返回 null，渲染层静默处理）；归一化同 bindDirectory
    handleUser(
      "workspace:openLocal",
      async (_, userId): Promise<WorkspaceRecord | null> => {
        const result = await dialog.showOpenDialog({
          properties: ["openDirectory"],
        });
        if (result.canceled || !result.filePaths[0]) {
          return null;
        }
        const directoryPath = normalizeWorkspacePath(result.filePaths[0]);
        return this.sessions.createWorkspace(
          {
            name: path.basename(directoryPath),
            directoryPath,
          },
          userId,
        );
      },
    );
    // 技能目录一键打开（P2 skill 无管理界面，文件系统即配置——保证发现性）
    ipcMain.handle("skill:openDir", async (): Promise<string> => {
      const dir = skillsDir();
      await fs.mkdir(dir, { recursive: true });
      // openPath 失败时 resolve 而非 reject（返回错误串）——转 reject 让渲染层 toast
      const openError = await shell.openPath(dir);
      if (openError) {
        throw new Error(openError);
      }
      return dir;
    });
    // P3 文件引用：多选弹窗 + 逐文件读取文本（≤512KB、NUL 视为二进制拒绝）。
    // 单文件失败不影响其余（带 error 返回，渲染层 toast 后丢弃）；取消返回空数组
    ipcMain.handle(
      "file:pickAndRead",
      async (): Promise<
        Array<
          { path: string; content: string } | { path: string; error: string }
        >
      > => {
        const result = await dialog.showOpenDialog({
          properties: ["openFile", "multiSelections"],
        });
        if (result.canceled || result.filePaths.length === 0) {
          return [];
        }
        // 选择器 = 用户显式给出：登记读授权——发送时 @token 经
        // readWorkspaceFile 出界的绝对路径可回退 readExternalFile
        // （预读无沙箱而发送读取有沙箱的口径断裂修复）
        grantExternalPaths(result.filePaths);
        return Promise.all(
          result.filePaths.map(async (filePath) => {
            try {
              const stat = await fs.stat(filePath);
              if (stat.size > 512 * 1024) {
                return { path: filePath, error: "超过 512KB 上限" };
              }
              const buf = await fs.readFile(filePath);
              if (buf.includes(0)) {
                return { path: filePath, error: "二进制文件不支持" };
              }
              return { path: filePath, content: buf.toString("utf8") };
            } catch {
              return { path: filePath, error: "读取失败" };
            }
          }),
        );
      },
    );
    // @ 联想数据源：工作空间内文件清单（相对路径，posix 分隔符）；
    // 排除 node_modules/.git/dist 与隐藏项，上限 2000；未绑定目录返回 null
    handleUser(
      "file:listWorkspaceFiles",
      async (_, userId, workspaceId: number): Promise<string[] | null> => {
        const workspace = await this.sessions.getWorkspace(workspaceId);
        if (!workspace || workspace.userId !== userId) {
          return null;
        }
        const root = workspace.directoryPath?.trim();
        if (!root) {
          return null;
        }
        // FA-T1：清单口径收编 @tianshu/core（无头端/face files 端点同源）
        return listWorkspaceFiles(root);
      },
    );
    // @ 选中后读取工作空间内单个文件；resolveSafePath 校验 + 同 pickAndRead 的
    // 大小/二进制规则
    handleUser(
      "file:readWorkspaceFile",
      async (
        _,
        userId,
        workspaceId: number,
        relPath: string,
      ): Promise<{ content: string } | { error: string }> => {
        const workspace = await this.sessions.getWorkspace(workspaceId);
        if (!workspace || workspace.userId !== userId) {
          return { error: "未绑定工作空间目录" };
        }
        const root = workspace.directoryPath?.trim();
        if (!root) {
          return { error: "未绑定工作空间目录" };
        }
        let absolute: string;
        try {
          absolute = resolveSafePath(root, relPath);
        } catch {
          // 稳定码（前端判据）：出界绝对路径（＋菜单/粘贴等已授权来源）
          // 回退 readExternalFile 授权门读取，其余调用方语义不变
          return { error: "PATH_OUTSIDE_WORKSPACE" };
        }
        // FA-T1：守卫读取（512KB/NUL）收编 @tianshu/core readTextFileGuarded
        const guarded = await readTextFileGuarded(absolute);
        if (!guarded.ok) {
          if (guarded.reason === "too-large") {
            return { error: "超过 512KB 上限" };
          }
          if (guarded.reason === "binary") {
            return { error: "二进制文件不支持" };
          }
          return { error: "读取失败" };
        }
        return { content: guarded.content };
      },
    );
    // @ 新建任务落地页/资料库引用：读取用户显式给出（资料库/选择器/拖拽）
    // 的本地文件绝对路径（路径引用不拷贝），复用 readWorkspaceFile 的
    // 512KB 注入上限与图片 dataUrl 逻辑。external-file-gate 授权门：
    // 未授权路径直接拒绝——防渲染层 XSS 任意读本地文件
    handleUser("file:readExternalFile", (_, _userId, absPath: string) => {
      if (!isExternalReadAllowed(absPath)) {
        throw new Error(
          "未授权的文件路径（仅限资料库或经选择器/拖拽给出的文件）",
        );
      }
      return readWorkspaceFile(path.resolve(absPath));
    });
    // 拖拽路径授权登记：preload 的 getPathForFile 解出真实拖拽路径后经
    // 原生 send 直达本通道。刻意不进 preload 白名单——渲染层无法伪造
    // 授权（XSS 合成的 File 经 webUtils 解出空串）
    ipcMain.on("file:grant-external-path", (_e, absPath: unknown) => {
      if (typeof absPath === "string") {
        grantExternalPaths([absPath]);
      }
    });
    // 新建任务落地页附件：本地文件选择器（多选）；仅取绝对路径——内容经
    // file:readExternalFile 按需读取校验（区别于 pickAndRead 的选读一体），
    // 取消/空选返回 null；返回即登记读授权（选择器 = 用户显式给出）
    handleUser("file:pickLocalFiles", async (): Promise<string[] | null> => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", "multiSelections"],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      grantExternalPaths(result.filePaths);
      return result.filePaths;
    });
    // 资料库「上传文件夹」：目录选择器（单选）；路径由主进程
    // library:importFolder 直接消费（不经 readExternalFile 授权链），
    // 取消返回 null
    handleUser("file:pickLocalFolder", async (): Promise<string | null> => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      return result.filePaths[0] ?? null;
    });
    // 粘贴截图落盘：渲染层钉字节转 base64 直传 → attachments/（10MB 上限
    // 与扩展白名单见 pasted-image-store）；落盘即登记读授权（用户显式粘贴
    // = 显式给出），返回绝对路径挂 pill，发送时经 readExternalFile 读取
    handleUser(
      "file:savePastedImage",
      async (_, _userId, name: string, base64: string): Promise<string> => {
        const abs = await savePastedImage({
          base64,
          ext: path.extname(name).slice(1),
          rootDir: this.attachmentsRoot(),
        });
        grantExternalPaths([abs]);
        return abs;
      },
    );
    // 消息图片块展示：imagePath（相对数据根）→ dataUrl；readImageAsDataUrl
    // 内部防 ../ 越根穿越 + 10MB 上限 + 收录格式校验，读不到返回 null
    // （渲染层降级「图片已失效」占位）。无需授权门——只放行数据根内文件
    handleUser(
      "file:readMessageImage",
      async (_, _userId, imagePath: string): Promise<string | null> => {
        if (typeof imagePath !== "string" || imagePath === "") {
          return null;
        }
        return readImageAsDataUrl(appDataHome(), imagePath);
      },
    );
    // macOS size-0 截图兜底（WorkBuddy 同款坑）：剪贴板 image File 的
    // getAsFile 拿不到字节时，主进程直接读剪贴板位图（PNG）落盘同上；
    // Electron 44 剪贴板为 W3C 异步风格（read → ClipboardItem.getType），
    // 无图返回 null
    handleUser("file:readClipboardImage", async (): Promise<string | null> => {
      const items = await clipboard.read();
      for (const item of items) {
        const imageType =
          item.types.find((type) => type.startsWith("image/")) ?? "";
        if (imageType === "") {
          continue;
        }
        const payload = await item.getType(imageType);
        // image/* 必为 Blob（getType 仅 bookmark 类型返回 ClipboardBookmark）
        if (!(payload instanceof Blob)) {
          continue;
        }
        const buffer = Buffer.from(await payload.arrayBuffer());
        if (buffer.length === 0) {
          continue;
        }
        const abs = await savePastedImage({
          base64: buffer.toString("base64"),
          ext: imageType.split("/")[1] ?? "png",
          rootDir: this.attachmentsRoot(),
        });
        grantExternalPaths([abs]);
        return abs;
      }
      return null;
    });
    // 聊天输出便捷导出批：dataUrl 图片另存为——消息图片 lightbox / mermaid
    // 导出 / widget 图表截图下载共用；校验与写盘纯函数见 media-export
    // （mime 白名单 + 10MB 上限 + 默认名清洗），用户取消返回 null
    handleUser(
      "file:saveDataUrl",
      async (
        _,
        _userId,
        dataUrl: unknown,
        defaultName: unknown,
      ): Promise<string | null> => {
        if (typeof dataUrl !== "string" || typeof defaultName !== "string") {
          throw new Error("IMAGE_DATAURL_INVALID");
        }
        const parsed = parseImageDataUrl(dataUrl);
        const result = await dialog.showSaveDialog({
          defaultPath: sanitizeSaveName(defaultName, parsed.ext),
        });
        if (result.canceled || !result.filePath) {
          return null;
        }
        return saveImageDataUrl(dataUrl, result.filePath);
      },
    );
    // widget 图表区域截图：rect 为渲染层 iframe getBoundingClientRect（DIP，
    // 与 capturePage 同单位），event.sender 绑定调用窗无跨窗风险；iframe
    // 内部滚动时仅截可视区（协议限制，见组件注释）
    handleUser(
      "widget:capture",
      async (event, _userId, rect: unknown): Promise<string> => {
        const { x, y, width, height } = (rect ?? {}) as Record<string, unknown>;
        const valid =
          [x, y, width, height].every(
            (v) => typeof v === "number" && Number.isFinite(v),
          ) &&
          (width as number) > 0 &&
          (height as number) > 0;
        if (!valid) throw new Error("WIDGET_CAPTURE_RECT_INVALID");
        const image = await event.sender.capturePage({
          x: x as number,
          y: y as number,
          width: Math.round(width as number),
          height: Math.round(height as number),
        });
        return image.toDataURL();
      },
    );
  }

  /** 粘贴截图落盘根（与资料库 library/ 平级的数据根子目录） */
  private attachmentsRoot(): string {
    return attachmentsDir();
  }

  /**
   * workspace 图片附件收编（T11 文件窗图片 tab）：落在会话工作空间绑定
   * 目录内的附件先复制进 attachments 根（stageImageIntoAttachments），
   * 让 ImageBlock 走数据根相对路径（展示/回喂读回通道全兼容）；收编
   * 失败保留原路径（imageAttachmentBlocks 降级占位，发送不中断）。
   * 非空间内路径/未绑定目录原样透传——白名单安全语义不变
   */
  private async stageWorkspaceImages<T extends { absPath: string }>(
    session: { workspaceId?: number | null },
    images: T[],
  ): Promise<T[]> {
    if (images.length === 0 || !session.workspaceId) return images;
    const workspace = await this.sessions.getWorkspace(session.workspaceId);
    const bound = workspace?.directoryPath?.trim();
    if (!bound) return images;
    const dir = normalizeWorkspacePath(bound);
    const staged: T[] = [];
    for (const image of images) {
      const abs = path.resolve(image.absPath);
      const inWorkspace = abs === dir || abs.startsWith(dir + path.sep);
      const stagedPath = inWorkspace
        ? await stageImageIntoAttachments(attachmentsDir(), abs)
        : null;
      staged.push(
        stagedPath ? ({ ...image, absPath: stagedPath } as T) : image,
      );
    }
    return staged;
  }

  /** full 会话总览（SP6 spec §4.1）：标题查询失败行回落「会话 #id」不整表失败（spec §8）；A10 批提 public——server-face permission 面桥消费（全局运行态，与 IPC 同口径） */
  async listFullGrants(): Promise<FullSessionGrant[]> {
    return Promise.all(
      this.permissions.listFull().map(async (sessionId) => ({
        sessionId,
        title: (await this.sessionTitleOf(sessionId)) ?? `会话 #${sessionId}`,
      })),
    );
  }

  /** 一键收回 full 会话（SP6 spec §4.1）：空集 no-op 不审计（spec §8）；
   *  A10 批返回收回条数——IPC 面忽略返回值，server-face permission 面回
   *  {revoked}（被控面增强，spec §1.1） */
  revokeAllFull(): number {
    const ids = this.permissions.listFull();
    for (const id of ids) {
      this.permissions.set(id, "default");
    }
    if (ids.length === 0) {
      return 0;
    }
    this.auditSink?.({
      eventType: "permission.full-revoked",
      decision: "info",
      detail: { count: ids.length },
    });
    return ids.length;
  }

  /** 工具记忆列表（SP6 spec §4.2）：空间名 join 失败行回落 #workspaceId（spec §8）；v12 限定本人空间；A10 批提 public——server-face permission 面桥消费 */
  async listRemembered(userId: number): Promise<RememberedToolGrant[]> {
    const ownedWorkspaceIds = await this.ownedWorkspaceIds(userId);
    const rows = await prisma.toolPermission.findMany({
      where: { workspaceId: { in: ownedWorkspaceIds } },
      orderBy: { createdAt: "desc" },
    });
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        workspaceName:
          (await this.workspaceNameOf(row.workspaceId)) ??
          `#${row.workspaceId}`,
        toolName: row.toolName,
        createdAt: row.createdAt.toISOString(),
      })),
    );
  }

  /** 撤销单条工具记忆（SP6 spec §4.2）：不存在/非本人空间幂等 no-op 不审计（spec §8）；A10 批提 public——server-face permission 面桥消费 */
  async revokeRemembered(id: number, userId: number): Promise<void> {
    const ownedWorkspaceIds = await this.ownedWorkspaceIds(userId);
    const row = await prisma.toolPermission.findFirst({
      where: { id, workspaceId: { in: ownedWorkspaceIds } },
    });
    if (!row) {
      return;
    }
    await prisma.toolPermission.delete({ where: { id } });
    this.auditSink?.({
      eventType: "permission.remembered-revoked",
      decision: "info",
      detail: {
        tool: row.toolName,
        workspace:
          (await this.workspaceNameOf(row.workspaceId)) ??
          `#${row.workspaceId}`,
      },
    });
  }

  /** 全部撤销工具记忆（SP6 spec §4.2）：空集 no-op 不审计（spec §8）；v12 限定本人空间；A10 批提 public 且返回撤销条数——IPC 面忽略返回值，server-face permission 面回 {revoked}（被控面增强，spec §1.1） */
  async revokeAllRemembered(userId: number): Promise<number> {
    const ownedWorkspaceIds = await this.ownedWorkspaceIds(userId);
    const { count } = await prisma.toolPermission.deleteMany({
      where: { workspaceId: { in: ownedWorkspaceIds } },
    });
    if (count === 0) {
      return 0;
    }
    this.auditSink?.({
      eventType: "permission.remembered-revoked-all",
      decision: "info",
      detail: { count },
    });
    return count;
  }

  /** 会话标题查询：失败/缺行返回 null（调用方走回落文案），不冒泡整表失败 */
  private async sessionTitleOf(sessionId: number): Promise<string | null> {
    try {
      return (await this.sessions.getSession(sessionId))?.title ?? null;
    } catch {
      return null;
    }
  }

  /** 本人全部工作空间 id（工具记忆按空间过滤数据源；toolPermission 为裸列无 relation） */
  private async ownedWorkspaceIds(userId: number): Promise<number[]> {
    return (
      await prisma.workspace.findMany({
        where: { userId },
        select: { id: true },
      })
    ).map((row) => row.id);
  }

  /** 工作空间名查询：失败/缺行返回 null（调用方走 #id 回落文案） */
  private async workspaceNameOf(workspaceId: number): Promise<string | null> {
    try {
      return (await this.sessions.getWorkspace(workspaceId))?.name ?? null;
    } catch {
      return null;
    }
  }

  private emit(
    sender: WebContents | undefined,
    sessionId: number,
    chunk: ChatStreamChunk,
  ) {
    // server-face tap 点（T10）：无论渲染层 sender 在场与否都先广播，
    // 供被控面（SSE/relay）订阅；渲染层推送行为不变
    emitChatChunk(sessionId, chunk);
    // 渲染层窗口可能已销毁：跳过推送，避免异常冒泡中断持久化与终止 chunk
    if (!sender || sender.isDestroyed()) {
      return;
    }
    sender.send(`chat:stream:${sessionId}`, chunk);
  }

  /**
   * 面板联动装配（web 工具 open_browser）：组装后字段注入而非
   * resolveAgentOptions 传参——assembleContext 与用量拆解（chat:usage，
   * 无 sender 也不执行工具）共用，sender 仅会话流可得；agent 每请求新建
   * 对象，就地补字段不外溢。sender 销毁安全（与 emit 同守卫）；sessionId
   * 由闭包补进 payload
   */
  private bindEmitPanel(
    agent: AgentStreamOptions,
    sessionId: number,
    sender?: WebContents,
  ): void {
    agent.emitPanel = sender
      ? (event, payload) => {
          if (event !== "detailPanel:openBrowser") return;
          if (!sender.isDestroyed()) {
            sender.send(event, { sessionId, url: payload.url });
          }
        }
      : undefined;
  }

  /**
   * /compact 会话压缩(/compact 命令实现)：清压缩态(保证压缩基于全量
   * 历史)→ 摘要指令走一次普通发送轮(流式可见)→ 取最后一条 assistant 文本
   * 落 session.summary/compactedUpToId;后续 send 上下文 = 摘要 + 压缩点后消息。
   * trigger=auto（send 预算检测触发）时指令带「[自动压缩]」前缀落库
   */
  async compact(
    sessionId: number,
    userId: number,
    sender?: WebContents,
    trigger: "manual" | "auto" = "manual",
  ): Promise<void> {
    const session = await this.sessions.getSession(sessionId);
    if (!session || session.userId !== userId) {
      throw new Error("SESSION_NOT_FOUND");
    }
    // 并发检查前置：旧实现经内部 send 的守卫触发，但摘要态清空已先行
    // （并发时白丢摘要）；此处先挡再清，语义更稳
    if (this.aborts.has(sessionId)) {
      throw new Error("CONCURRENT_REQUEST");
    }
    const abort = new AbortController();
    this.aborts.set(sessionId, abort);
    try {
      await this.compactRound(sessionId, userId, sender, abort, trigger);
    } finally {
      this.aborts.delete(sessionId);
    }
  }

  /**
   * 压缩执行体（手动 /compact 与 send 自动压缩共用；调用方已注册 abort
   * 并完成会话校验）：清压缩态 → 摘要指令轮（流式可见）→ 末条 assistant
   * 文本回填 summary/compactedUpToId。中止时不回填（摘要轮可能是残文）
   */
  private async compactRound(
    sessionId: number,
    userId: number,
    sender: WebContents | undefined,
    abort: AbortController,
    trigger: "manual" | "auto",
  ): Promise<void> {
    await this.sessions.updateSummary(sessionId, null, null);
    await this.sendRound(
      {
        sessionId,
        content:
          trigger === "auto" ? AUTO_COMPACT_DIRECTIVE : COMPACT_DIRECTIVE,
      },
      userId,
      sender,
      abort,
    );
    if (abort.signal.aborted) {
      return;
    }
    // 摘要轮的 streamAndPersist finally 已清注册：恢复之，摘要回填写期间
    // 注册不悬空（stop/并发语义连续）；最终清理归调用方
    this.aborts.set(sessionId, abort);
    const rows = await prisma.message.findMany({
      where: { sessionId, role: "assistant" },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    const last = rows[0];
    if (!last) {
      return;
    }
    const summaryText = extractAssistantText(last.blocks);
    if (summaryText.trim() === "") {
      return;
    }
    await this.sessions.updateSummary(sessionId, summaryText, last.id);
  }

  async send(
    params: ChatSendParams,
    userId: number,
    sender?: WebContents,
  ): Promise<void> {
    // 并发检查必须是首条语句；AbortController 在首个 await 前注册，消除 TOCTOU 窗口
    // 业务错误 message 只传错误码（Electron invoke 拒绝时仅保留 message），渲染端映射 i18n
    if (this.aborts.has(params.sessionId)) {
      throw new Error("CONCURRENT_REQUEST");
    }
    const abort = new AbortController();
    this.aborts.set(params.sessionId, abort);
    try {
      // 自动压缩（spec §18 项 2）：在用户消息落库前——压缩完成后组装的
      // 历史已是「摘要+新尾部」，预算大幅释放；复用本次注册的 abort，
      // 压缩轮与原消息同生共死；失败静默放行（硬截兜底在包内
      // runChatStream 的 truncateHistory 环节）
      await this.autoCompactIfBudgeted(params, userId, sender, abort);
      await this.sendRound(params, userId, sender, abort);
    } catch (error) {
      // 早期失败（会话不存在/未选模型等）也要清理注册，避免映射表泄漏；
      // streamAndPersist 的 finally 已清理时此处为幂等空操作
      this.aborts.delete(params.sessionId);
      throw error;
    }
  }

  /**
   * 单轮发送体（send 与压缩摘要轮共用，调用方已注册 abort）：会话校验 →
   * 请求级模型选择 → 用户消息落库 → 流式执行与持久化
   */
  private async sendRound(
    params: ChatSendParams,
    userId: number,
    sender: WebContents | undefined,
    abort: AbortController,
  ): Promise<void> {
    const session = await this.sessions.getSession(params.sessionId);
    if (!session || session.userId !== userId) {
      throw new Error("SESSION_NOT_FOUND");
    }
    // 归档会话只读（前端已禁入口，此处防手改直发）
    if (session.archivedAt) {
      throw new Error("ARCHIVED_SESSION");
    }

    // 请求级模型选择写入会话当前值（会话记住上次选择，spec §4.2）
    if (params.modelId) {
      await this.sessions.setSessionModel(
        params.sessionId,
        params.modelId,
        userId,
      );
    }

    // 用户消息立即落库 + 首条消息自动起标题；图片附件（多模态输入）
    // 一并写入 blocks（ImageBlock 存相对数据根路径，回喂时读盘转
    // image part；读不到的单图降级占位，不阻断整条消息）。workspace
    // 图片先收编进 attachments（T11 文件窗图片 tab：空间目录在数据根
    // 外，不收编会被白名单+防越根校验降级成「无法读取」占位）
    const imageBlocks = await imageAttachmentBlocks(
      appDataHome(),
      [attachmentsDir(), libraryDir()],
      await this.stageWorkspaceImages(session, params.images ?? []),
    );
    await this.sessions.appendMessage({
      sessionId: params.sessionId,
      role: "user",
      blocks: serializeBlocks([
        { type: "text", text: params.content },
        ...imageBlocks,
      ]),
      assistantId: session.assistantId ?? undefined,
    } satisfies AppendMessageParams);
    await this.sessions.autotitleIfDefault(
      params.sessionId,
      params.content,
      userId,
    );

    await this.streamAndPersist(
      params.sessionId,
      userId,
      abort,
      sender,
      params.overrides,
    );
  }

  /**
   * 自动压缩编排（spec §18 项 2，send 落库用户消息前调用）：预算探测
   * 达阈值且冷却带放行 → 先走压缩轮；压缩后基线 = 即时预算成本快照
   * （会话粒度内存 Map），再压需成本再涨 20%。任何失败只记日志静默
   * 放行原发送（硬截兜底在包内 runChatStream 的 truncateHistory 环节）
   */
  private async autoCompactIfBudgeted(
    params: ChatSendParams,
    userId: number,
    sender: WebContents | undefined,
    abort: AbortController,
  ): Promise<void> {
    // 摘要指令轮豁免（防递归）；归档/未配模型等探测失败同样不挡原发送
    if (isCompactDirective(params.content)) {
      return;
    }
    const probe = await this.probeSendCost(params, userId);
    if (
      !probe ||
      probe.cost < probe.contextWindow * AUTO_COMPACT_TRIGGER_RATIO
    ) {
      return;
    }
    const baseline = this.autoCompactBaselines.get(params.sessionId);
    if (
      baseline !== undefined &&
      probe.cost < baseline * AUTO_COMPACT_COOLDOWN_GROWTH
    ) {
      return;
    }
    try {
      await this.compactRound(params.sessionId, userId, sender, abort, "auto");
    } catch (e) {
      // 压缩轮内摘要 assistant 落库等抛错时，streamAndPersist 的 finally
      // 已清注册：不在则重注册（send 原消息轮继续用它），堵后续原发送
      // 期间 stop/并发守卫失效的极窄双流窗口（spec §19 项 2）
      if (!this.aborts.has(params.sessionId)) {
        this.aborts.set(params.sessionId, abort);
      }
      Log.warn(
        "自动压缩失败,静默放行继续原发送",
        e instanceof Error ? e.message : e,
      );
      return;
    }
    // 中止（压缩轮未回填）或压缩失败不写基线：下次超限仍会再试
    if (abort.signal.aborted) {
      return;
    }
    const after = await this.probeSendCost(params, userId);
    if (after) {
      this.autoCompactBaselines.set(params.sessionId, after.cost);
    } else {
      this.autoCompactBaselines.delete(params.sessionId);
    }
  }

  /**
   * 预算探测（与 runChatStream 回喂同口径）：trimHistoryToolOutputs 瘦身
   * 后历史 estimateMessageTokens 求和 + 本条 content + estimateReserveTokens
   * 预留（maxTokens/system/工具定义）；contextWindow 未配置、归档会话或
   * 组装失败（NO_MODEL 等）返回 null——不检测不压缩，错误由原发送流程
   * 以同因正式报出
   */
  private async probeSendCost(
    params: ChatSendParams,
    userId: number,
  ): Promise<{ cost: number; contextWindow: number } | null> {
    try {
      const ctx = await this.assembleContext(
        params.sessionId,
        userId,
        params.overrides,
      );
      if (ctx.session.archivedAt) {
        return null;
      }
      const contextWindow = ctx.modelRow.contextWindow ?? 0;
      if (!contextWindow) {
        return null;
      }
      const toolDefinitions =
        ctx.mode === "ask"
          ? []
          : this.collectToolDefinitions(
              ctx.agent,
              ctx.allSkills,
              ctx.isProjectSession,
              // 估算口径与下次请求同集（getUsageBreakdown 同款：无流无中止信号）
              ctx.team,
              ctx.toolGate,
            );
      const historyCost = trimHistoryToolOutputs(ctx.history).reduce(
        (sum, m) => sum + estimateMessageTokens(m.blocks),
        0,
      );
      return {
        cost:
          historyCost +
          estimateTokens(params.content) +
          estimateReserveTokens(
            ctx.merged.maxTokens,
            ctx.systemWithSummary,
            toolDefinitions,
          ),
        contextWindow,
      };
    } catch {
      return null;
    }
  }

  /**
   * 重新生成(任意位置):目标 assistant 消息(缺省最后一条)→ 定位其前
   * 最后一条 user,删除该 user 之后全部(目标及其后内容被覆盖)→ 重跑流
   */
  async regenerate(
    sessionId: number,
    userId: number,
    messageId?: number,
    sender?: WebContents,
  ): Promise<void> {
    if (this.aborts.has(sessionId)) {
      throw new Error("CONCURRENT_REQUEST");
    }
    const abort = new AbortController();
    this.aborts.set(sessionId, abort);
    try {
      const session = await this.sessions.getSession(sessionId);
      if (!session || session.userId !== userId) {
        throw new Error("SESSION_NOT_FOUND");
      }
      // 归档会话只读（前端已禁入口，此处防手改直发）
      if (session.archivedAt) {
        throw new Error("ARCHIVED_SESSION");
      }
      const rows = await prisma.message.findMany({
        where: { sessionId },
        orderBy: { createdAt: "asc" },
      });
      let targetIdx = -1;
      if (messageId !== undefined) {
        targetIdx = rows.findIndex(
          (row) => row.id === messageId && row.role === "assistant",
        );
        if (targetIdx === -1) {
          throw new Error("MESSAGE_NOT_FOUND");
        }
      } else {
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].role === "assistant") {
            targetIdx = i;
            break;
          }
        }
      }
      if (targetIdx === -1) {
        throw new Error("NOTHING_TO_REGENERATE");
      }
      let lastUserIdx = -1;
      for (let i = targetIdx - 1; i >= 0; i--) {
        if (rows[i].role === "user") {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx === -1) {
        throw new Error("NOTHING_TO_REGENERATE");
      }
      await this.truncateAfterAndStream(
        sessionId,
        userId,
        rows,
        lastUserIdx,
        session.compactedUpToId,
        abort,
        sender,
      );
    } catch (error) {
      this.aborts.delete(sessionId);
      throw error;
    }
  }

  /**
   * 编辑重发:目标 user 消息就地改写为新内容(保留原时间戳)→ 删除其后全部
   * (原回答等内容被覆盖)→ 重跑流
   */
  async editAndResend(
    sessionId: number,
    userId: number,
    messageId: number,
    content: string,
    sender?: WebContents,
  ): Promise<void> {
    // 并发检查必须是首条语句；AbortController 在首个 await 前注册，消除 TOCTOU 窗口
    if (this.aborts.has(sessionId)) {
      throw new Error("CONCURRENT_REQUEST");
    }
    const abort = new AbortController();
    this.aborts.set(sessionId, abort);
    try {
      const session = await this.sessions.getSession(sessionId);
      if (!session || session.userId !== userId) {
        throw new Error("SESSION_NOT_FOUND");
      }
      // 归档会话只读（前端已禁入口，此处防手改直发）
      if (session.archivedAt) {
        throw new Error("ARCHIVED_SESSION");
      }
      const rows = await prisma.message.findMany({
        where: { sessionId },
        orderBy: { createdAt: "asc" },
      });
      const targetIdx = rows.findIndex(
        (row) => row.id === messageId && row.role === "user",
      );
      if (targetIdx === -1) {
        throw new Error("MESSAGE_NOT_FOUND");
      }
      // 编辑只改文本：原 image 块（多模态输入）随行保留，与 send 落库
      // 结构 [text, ...images] 对齐；thinking/usage 等畸形块随重写丢弃
      const keptImages = parseBlocks(rows[targetIdx].blocks).filter(
        (block): block is ImageBlock => block.type === "image",
      );
      await prisma.message.update({
        where: { id: messageId },
        data: {
          blocks: serializeBlocks([
            { type: "text", text: content },
            ...keptImages,
          ]),
        },
      });
      await this.truncateAfterAndStream(
        sessionId,
        userId,
        rows,
        targetIdx,
        session.compactedUpToId,
        abort,
        sender,
      );
    } catch (error) {
      // 早期失败同样清理注册(与 send 一致)；streamAndPersist 的 finally
      // 已清理时此处为幂等空操作
      this.aborts.delete(sessionId);
      throw error;
    }
  }

  /**
   * 截断重跑(regenerate 与 editAndResend 共用):删除保留边界(含)之后全部
   * 消息 → 压缩点失效清理 → 重启流(AbortController 由调用方在首个 await
   * 前注册并传入)
   */
  private async truncateAfterAndStream(
    sessionId: number,
    userId: number,
    rows: ChatMessageRow[],
    keepUpToIndex: number,
    compactedUpToId: number | null,
    abort: AbortController,
    sender?: WebContents,
  ): Promise<void> {
    const tailIds = rows.slice(keepUpToIndex + 1).map((row) => row.id);
    if (tailIds.length > 0) {
      await prisma.message.deleteMany({ where: { id: { in: tailIds } } });
    }
    // 压缩点消息被删(压缩点位于被删尾部)→ 摘要随之失效:
    // 不清会让 history 过滤掉压缩点之前的全部消息 → 空上下文
    if (compactedUpToId != null && tailIds.includes(compactedUpToId)) {
      await this.sessions.updateSummary(sessionId, null, null);
    }
    await this.streamAndPersist(sessionId, userId, abort, sender);
  }

  /**
   * agent 上下文装配（P2）：所有会话都具备——read_skill 与 mcp__ 工具不依赖
   * 工作空间（spec 决策 #3 常驻注入），mcp__ 写类审批也始终可用（决策 #1）。
   * workspacePath 仅在绑定目录后有值；fullAccess 实时查 PermissionStore
   * （P3 两级审批：workspace.writeApprovedAt 读取路径已废弃，spec R2）。
   * P4 反馈 2：isToolAllowed 查 toolPermission 表（工作空间级 allowed-tools）
   * SP1 安全中心：onSecurityEvent/onApprovalResolved 桥接 auditSink 审计出口
   */
  private async resolveAgentOptions(
    session: {
      workspaceId: number;
      projectId?: number | null;
      /** 监控埋点（token/工具监控）：事件归属列（session 行自带） */
      userId?: number | null;
    },
    sessionId: number,
    /** 会话当前模型 id（assembleContext 已解出，NO_MODEL 已挡）：
     *  create_automation_task 任务执行模型依据 */
    modelId: number,
  ): Promise<AgentStreamOptions> {
    const workspace = session.workspaceId
      ? await this.sessions.getWorkspace(session.workspaceId)
      : null;
    const directoryPath = workspace?.directoryPath?.trim() || null;
    const workspaceId = workspace?.id ?? null;
    const workspaceDir = directoryPath
      ? normalizeWorkspacePath(directoryPath)
      : null;
    // 懒加载预热（fire-and-forget，失败不阻塞流）：重启后旧会话授权从
    // option 表恢复进内存缓存，下方闭包与 gate 随后即可同步读到；
    // userId 分桶（T28 多用户隔离 spec §16 项 2）
    void grantedPathsOf(sessionId, session.userId ?? null);
    return {
      sessionId,
      userId: session.userId ?? undefined,
      // create_automation_task 落库依据（防模型幻觉填参）
      workspaceId: workspaceId ?? undefined,
      modelId,
      workspacePath: workspaceDir ?? undefined,
      projectId: session.projectId ?? null,
      fullAccess: () => this.permissions.get(sessionId) === "full",
      isToolAllowed: async (toolName: string) => {
        if (workspaceId === null) {
          return false;
        }
        const row = await prisma.toolPermission.findUnique({
          where: { workspaceId_toolName: { workspaceId, toolName } },
          select: { id: true },
        });
        return row !== null;
      },
      requestApproval: (toolCallId, argSummary) =>
        this.approvals.request(toolCallId, argSummary),
      // 监控埋点（spec §4.1 #3）：终态工具事件 → fire-and-forget 落库
      // （recordToolCall 自吞错，失败不影响主流程）；userId 取 session 行
      toolStats: (e) =>
        void recordToolCall(prisma, {
          ...e,
          scene: "chat",
          userId: session.userId ?? null,
          sessionId,
        }),
      // SP4 数据安全：闭包实时读配置（运行中改配置即生效）
      deleteProtection: this.dataSafety?.deleteProtection() ?? true,
      bulkDeleteThreshold:
        this.dataSafety?.bulkDeleteThreshold() ?? BULK_DELETE_THRESHOLD_DEFAULT,
      onBackupFile: this.dataSafety
        ? (absPath, sid) => this.dataSafety!.backupFile(absPath, sid)
        : undefined,
      // 文件窗口联动（spec §5.2/§6.4）：AI write_file 写盘后——库路径
      // （libraryDir() 下）bump 条目 updatedAt + 广播 libraryChanged
      // （T14 修复轮：library tab 基线/重载感知，挂载恒定不随空间绑定，
      // 库路径不回落空间维度——反解出跨界 relPath 无 tab 可匹配）；其余
      // 路径反解 relPath 广播 fileChanged（未绑定目录无此语义）
      onFileWritten: (absPath) => {
        void notifyLibraryFileWritten(absPath).then((libraryHandled) => {
          if (libraryHandled) return;
          if (workspaceId != null && workspaceDir != null) {
            broadcastFileChangedFor(workspaceId, workspaceDir)(absPath);
          }
        });
      },
      // 会话级路径授权清单（spec §6.4）：闭包惰性取——grant/revoke 经 IPC
      // 原地更新内存缓存，每工具调用实时读（避免组装期快照陈旧）；
      // userId 分桶（T28 多用户隔离）
      grantedPaths: () => grantedSyncOf(sessionId, session.userId ?? null),
      // SP2 命令判定门：与 automation 共享模块单例（会话流不设 unattended）
      decideCommand: commandGate,
      // SP3 文件判定门：同命令门共享模块单例
      decideFileAccess: fileGate,
      onSecurityEvent: (event) => this.auditSink?.(event),
      onApprovalResolved: (toolName, decision, argSummary) => {
        // 决议词汇对齐审计侧：内部 denied 记 rejected（AuditDecision 与 UI i18n 词汇）
        const audited = decision === "approved" ? "approved" : "rejected";
        const category =
          toolName === "run_command" ? "command-safety" : "file-safety";
        this.auditSink?.({
          eventType: `${category}.${audited}`,
          decision: audited,
          detail: { tool: toolName, summary: argSummary },
          sessionId,
        });
      },
    };
  }

  /**
   * 注入工具集（P2 spec 决策 #3）：read_skill 常驻（未绑定目录也注入，与
   * system prompt 消费同一次 skills 扫描——项目会话传全量启用集，预设外
   * 技能会话中按需可读）；mcp__* 经 registry 透传——项目会话不做挂载
   * 硬过滤（二期 §3.7 修正：挂载集是预设软约束，见 project-prompt），
   * plan_* 为项目专属工具，仅项目会话注入（全局会话无计划上下文）；
   * create_skill 落盘到用户技能目录、不依赖工作空间，未绑定目录也放行（P-D）；
   * create/update_expert 落库不依赖工作空间（专家 2.0），未绑定目录也放行
   * recommend_experts 纯渲染消费 args、无工作空间依赖（专家 2.0），同样放行
   * dispatch_member 为专家团会话专属（二期 T3）：team 助手注入主理人调度
   * 工具（成员子 agent 非流式单轮补全），非 team/成员空不构造；ask 模式
   * 调用方本就传空工具集，无需特判
   * 文件四件依赖工作空间路径，仅绑定目录后注入；run_command 例外——
   * 未绑定目录也注入（默认态锚点落家目录、钳制语义不变，见 command-tool
   * resolveCwd；默认权限仍逐条审批）
   * 工具分组场景门控（spec §20 项 B，WorkBuddy 窄常驻+按需挂载）：工作流
   * 六件套仅 automation/coding 场景或 workflow-creator 技能启用会话注入，
   * create/update_expert 仅专家绑定（或 experts 预留场景）会话注入——
   * filterToolsBySession 作 filterDisabledTools 之内层（场景门控先、用户
   * 禁用后两层叠加，独立于用户禁用配置）；其余工具（mcp 前缀/技能挂载/
   * 面板类等）不属门控组照旧放行
   */
  private collectToolDefinitions(
    agent: AgentStreamOptions,
    skills: SkillInfo[],
    isProjectSession: boolean,
    team: DispatchMemberDeps | null,
    gate: ToolGroupGate,
  ): ToolDefinition[] {
    const registered = registry.getDefinitions();
    const workspaceScoped = agent.workspacePath
      ? registered
      : registered.filter(
          (def) =>
            def.name.startsWith("mcp__") ||
            def.name === "run_command" ||
            def.name === "create_skill" ||
            def.name === WIDGET_TOOL_NAME ||
            def.name === CREATE_EXPERT_TOOL_NAME ||
            def.name === UPDATE_EXPERT_TOOL_NAME ||
            def.name === RECOMMEND_TOOL_NAME,
        );
    const injected = isProjectSession
      ? workspaceScoped
      : workspaceScoped.filter((def) => !def.name.startsWith("plan_"));
    // dispatch_member 禁用即跳过构造（二期 T3，与 system 侧 withDispatch 同
    // 口径）——工具每请求构造：deps 持当次成员/中止信号/modelText 闭包
    const dispatchMember =
      team &&
      team.members.length > 0 &&
      !(this.runtimeFilter?.() ?? []).includes(DISPATCH_MEMBER_TOOL_NAME)
        ? makeDispatchMemberTool(team)
        : null;
    // 注入层过滤（SP6 裁定 2）：禁用=对模型不存在；闭包实时读配置，
    // runtimeFilter 缺席（测试）不滤；两层叠加（spec §20 项 B）——场景
    // 门控在内层先剔（产品语义），用户禁用在外层后剔（安全配置语义）
    return filterDisabledTools(
      filterToolsBySession(
        [
          makeReadSkillTool(skills, (ctx, skill) => {
            if (skill.name !== WORKFLOW_CREATOR_SKILL_NAME) return;
            // 图执行无会话（sessionId null，去会话化）无会话意图集可挂——
            // 工作流意图尾注照发（指引文本），不落集
            if (ctx.sessionId !== null) {
              this.workflowIntentSessions.add(ctx.sessionId);
            }
            return WORKFLOW_INTENT_NOTE;
          }),
          ...(dispatchMember ? [dispatchMember] : []),
          ...injected,
        ],
        gate,
      ),
      this.runtimeFilter?.() ?? [],
    );
  }

  /**
   * 成员单轮补全装配（专家团二期 T3）：dispatch_member 的 modelText 生产
   * 实现，handover-summary defaultModelText 同构（createChatModel +
   * LangChain invoke 非流式补全、超时熔断）；120s——成员单轮任务重于交接
   * 摘要（30s），子 agent 独立分析可深推理。deps 透传的会话中止信号与
   * 超时兜底组合（先到先断：用户停止即断，无外部信号时仅 120s 熔断）
   */
  private memberModelText(
    modelRow: { modelId: string },
    providerRow: {
      type: string;
      baseUrl: string;
      apiKey?: string | null;
      extraHeaders?: string | null;
    },
  ): DispatchMemberModelTextFn {
    return async ({ system, prompt, abortSignal }) => {
      const chat = createChatModel(
        {
          type: providerRow.type,
          baseUrl: providerRow.baseUrl,
          apiKey: providerRow.apiKey ?? undefined,
          extraHeaders: providerRow.extraHeaders,
        },
        modelRow.modelId,
      );
      const aiMessage = await chat.invoke(
        [new SystemMessage(system), new HumanMessage(prompt)],
        {
          signal: abortSignal
            ? AbortSignal.any([abortSignal, AbortSignal.timeout(120_000)])
            : AbortSignal.timeout(120_000),
        },
      );
      return aiMessageContentToText(aiMessage.content);
    };
  }

  /**
   * 技能清单即时扫描（设计 spec §2）：每次 send 现算、无缓存——增删技能免重启生效；
   * 用户级目录始终加载，工作空间级仅在绑定目录时追加（数组序即优先级，同名用户级胜）
   */
  private collectSkills(workspaceDir?: string) {
    const dirs: Array<{ dir: string; source: "user" | "workspace" }> = [
      { dir: skillsDir(), source: "user" },
    ];
    if (workspaceDir) {
      dirs.push({
        dir: path.join(workspaceDir, ".tianshu", "skills"),
        source: "workspace",
      });
    }
    return loadSkills(dirs);
  }

  /**
   * 禁用即时生效（P-A spec §4.2）：user 级按 DB 启用态过滤（禁用对模型=
   * 不存在）；repo 缺席（测试）时不过滤，行为与 P2 一致
   */
  private async collectEnabledSkills(workspaceDir?: string) {
    const all = this.collectSkills(workspaceDir);
    if (!this.skillRepo) {
      return all;
    }
    const disabled = await this.skillRepo.getDisabledNames();
    return filterDisabledSkills(all, disabled);
  }

  /**
   * 工作流组挂载依据（spec §20 项 B，三信号取或）：① 会话内 read_skill
   * 读过 workflow-creator（使用即意图——f49349d7 自愈纠 source 后技能
   * 永为 builtin，② 对普通用户永假，本信号恢复可达性）；② 技能**用户侧
   * 安装**且启用——source!=="builtin"（内置技能启动自愈安装且 enabled
   * 默认 true，若只看启用态则 daily/design 会话恒开门、门控失效，F1
   * 裁定）；③ 场景信号（automation/coding，filterToolsBySession 内判）。
   * 单查询（listGateStatus 三列清单）完成判定；repo/方法缺席（测试窄
   * stub）视为未启用（查不到=不挂载——场景门控是产品语义非安全语义）
   */
  private async resolveWorkflowCreatorEnabled(
    sessionId: number,
  ): Promise<boolean> {
    if (this.workflowIntentSessions.has(sessionId)) {
      return true;
    }
    const { skillRepo } = this;
    if (!skillRepo?.listGateStatus) {
      return false;
    }
    const row = (await skillRepo.listGateStatus()).find(
      (r) => r.name === WORKFLOW_CREATOR_SKILL_NAME,
    );
    return !!row && row.enabled && row.source !== "builtin";
  }

  /**
   * 通用编排：解析模型/助手 → 合并参数 → 截断历史 → agent 流式执行 → 持久化
   * （AbortController 由调用方在首个 await 前注册并传入，此处负责 finally 清理）
   */
  private async streamAndPersist(
    sessionId: number,
    userId: number,
    abort: AbortController,
    sender?: WebContents,
    overrides?: ChatModelParams,
    maxSteps: number = DEFAULT_MAX_STEPS,
  ): Promise<void> {
    const startedAt = Date.now();
    const ctx = await this.assembleContext(sessionId, userId, overrides);
    // 面板联动（web 工具 open_browser）：会话 sender 绑定进 agent 闭包
    this.bindEmitPanel(ctx.agent, sessionId, sender);
    try {
      // AR-T1 接缝消费：编排层经 agentRunner（AgentRunner 契约——chunks
      // 流 + result 终值）驱动引擎；桥接层聚合 chunk 出口（onChunk 不直传）
      const run = this.agentRunner.run({
        // 模型构造收口 createChatModel（T3-3 R1）：采样/限额参数随构造
        // 下发，四家字段分派在工厂内（温度之外旧栈经 streamText 的
        // topP/maxOutputTokens 全量恢复）
        model: createChatModel(
          {
            type: ctx.providerRow.type,
            baseUrl: ctx.providerRow.baseUrl,
            apiKey: ctx.providerRow.apiKey ?? undefined,
            extraHeaders: ctx.providerRow.extraHeaders,
          },
          ctx.modelRow.modelId,
          {
            temperature: ctx.merged.temperature,
            topP: ctx.merged.topP,
            maxTokens: ctx.merged.maxTokens,
          },
        ),
        system: ctx.systemWithSummary,
        history: ctx.history,
        contextWindow: ctx.modelRow.contextWindow ?? undefined,
        params: ctx.merged,
        abortSignal: abort.signal,
        toolDefinitions:
          ctx.mode === "ask"
            ? []
            : this.collectToolDefinitions(
                ctx.agent,
                ctx.allSkills,
                ctx.isProjectSession,
                // 二期 T3：team 会话注入 dispatch_member；abort.signal 随
                // 当次流透传（成员子 agent 与主对话同生共死）
                ctx.team ? { ...ctx.team, abortSignal: abort.signal } : null,
                ctx.toolGate,
              ),
        agent: ctx.agent,
        maxSteps,
        // 历史图片块回喂：按数据根读盘转 dataUrl（读不到由转换层降级占位）
        loadImage: (imagePath) => readImageAsDataUrl(appDataHome(), imagePath),
      });
      // 引擎 chunk：先累积主进程快照（供切回会话恢复），再照常推送渲染层；
      // 流收尾（finally 清理后）到达的迟到工具事件只转发不落快照
      for await (const chunk of run.chunks) {
        if (this.aborts.has(sessionId)) {
          this.accumulateSnapshot(sessionId, chunk);
        }
        this.emit(sender, sessionId, chunk);
      }
      const result = await run.result;

      // 持久化 assistant 消息（中断也保留已生成部分）
      if (result.blocks.length > 0 || result.errorCode) {
        await this.sessions.appendMessage({
          sessionId,
          role: "assistant",
          blocks: serializeBlocks(result.blocks),
          modelId: ctx.modelId,
          assistantId: ctx.session.assistantId ?? undefined,
          error: result.errorMessage,
          durationMs: Date.now() - startedAt,
        } satisfies AppendMessageParams);
      }
      // 监控埋点（spec §4.1 #1）：落库时提取 usage（H7a 同款「落库时提取」；
      // 错误轮次/中止无 usage 块不写）
      const usage = usageFromBlocks(result.blocks);
      if (usage) {
        void recordLlmCall(prisma, {
          userId,
          scene: "chat",
          modelId: ctx.modelId,
          sessionId,
          inputTokens: usage.input,
          outputTokens: usage.output,
          durationMs: Date.now() - startedAt,
        });
      }
      if (result.errorCode) {
        this.emit(sender, sessionId, {
          type: "error",
          errorCode: result.errorCode,
          message: result.errorMessage ?? "",
        });
      } else {
        this.emit(sender, sessionId, { type: "finish" });
        // 首轮问答完成 → AI 起标题（不阻塞、失败静默，spec §6）
        void this.generateTitleIfFirstExchange(sessionId, userId, sender, {
          type: ctx.providerRow.type,
          baseUrl: ctx.providerRow.baseUrl,
          apiKey: ctx.providerRow.apiKey ?? undefined,
          extraHeaders: ctx.providerRow.extraHeaders,
          modelId: ctx.modelRow.modelId,
        });
      }
    } finally {
      this.aborts.delete(sessionId);
      this.snapshots.delete(sessionId);
      // 中断/收尾：作废全部未决审批（resolve false），释放挂起的 execute（spec 决策 #5）
      this.approvals.voidAll();
    }
  }

  /**
   * 上下文组装（send 与用量拆解共用）：会话/模型/助手 → 参数合并 →
   * 压缩态过滤历史 → agent/模式/技能 → system（含压缩摘要）
   */
  private async assembleContext(
    sessionId: number,
    userId: number,
    overrides?: ChatModelParams,
  ) {
    const session = await this.sessions.getSession(sessionId);
    if (!session || session.userId !== userId) {
      throw new Error("SESSION_NOT_FOUND");
    }
    const modelId = await this.sessions.getEffectiveModelId(sessionId);
    if (!modelId) {
      throw new Error("NO_MODEL");
    }
    const modelRow = await prisma.model.findUnique({ where: { id: modelId } });
    const providerRow = modelRow
      ? await prisma.provider.findUnique({
          where: { id: modelRow.providerId },
        })
      : null;
    if (!modelRow || !providerRow) {
      throw new Error("MODEL_OR_PROVIDER_MISSING");
    }
    const assistantRow: AssistantRow | null = session.assistantId
      ? await prisma.assistant.findUnique({
          where: { id: session.assistantId },
        })
      : null;

    const merged = mergeParams([
      {
        temperature: modelRow.temperature ?? undefined,
        topP: modelRow.topP ?? undefined,
        maxTokens: modelRow.maxTokens ?? undefined,
      },
      {
        temperature: assistantRow?.temperature ?? undefined,
        topP: assistantRow?.topP ?? undefined,
        maxTokens: assistantRow?.maxTokens ?? undefined,
      },
      overrides,
    ]);

    // /compact 压缩态:历史只取压缩点之后(摘要经 system 注入替代旧消息)
    // 宽松判空:旧会话/测试 stub 字段可能为 undefined,均视为未压缩
    const compacted =
      session.compactedUpToId != null && session.summary != null;
    // 压缩点下推到 SQL(id gt),已压缩的旧消息不再读回大 blocks 字段
    const history = (
      await prisma.message.findMany({
        where: {
          sessionId,
          ...(compacted ? { id: { gt: session.compactedUpToId ?? 0 } } : {}),
        },
        orderBy: { createdAt: "asc" },
        select: { role: true, blocks: true, error: true, createdAt: true },
      })
    )
      .filter((row) => row.role !== "system" && !row.error)
      .map((row) => ({
        role: row.role as "user" | "assistant",
        blocks: row.blocks,
      }));
    // 时间行注入（time-context）：最后一条 user 消息 blocks 头部——每次
    // 请求重拼随请求刷新（计划工具 dueDate 的「今天」基准）；放这里而非
    // system 是为前缀缓存（见 time-context 头注释），system 与历史保持
    // 逐字节稳定。倒序找（findLastIndex 为 ES2023，lib 只到 ES2022）
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === "user") {
        history[i] = {
          ...history[i],
          blocks: withTimeBlock(history[i].blocks, new Date()),
        };
        break;
      }
    }

    const agent = await this.resolveAgentOptions(session, sessionId, modelId);
    // P3 模式组装（spec R5）：DB null/未识别值归一 agent；ask 零工具零技能
    // （扫描整个跳过：技能清单与 read_skill 均不注入），plan 仅追加指令段
    const mode: "agent" | "ask" | "plan" =
      session.mode === "ask" || session.mode === "plan"
        ? session.mode
        : "agent";
    // 工具分组场景门控判定输入（spec §20 项 B）：collectToolDefinitions
    // 收口消费（ask 模式零工具，toolGate 仅随 ctx 携带不生效）
    const toolGate: ToolGroupGate = {
      scenario: session.scenario,
      assistantBound: session.assistantId != null,
      workflowCreatorEnabled:
        await this.resolveWorkflowCreatorEnabled(sessionId),
    };
    const skills =
      mode === "ask"
        ? []
        : await this.collectEnabledSkills(agent.workspacePath);
    // 扫描全集（专家附带技能补入来源，专家 2.0）：ask 零技能本就空集不扫；
    // 同步直调（与上行启用集各扫一次，技能目录小扫描快——skill-loader §2）
    const allScanned =
      mode === "ask" ? [] : this.collectSkills(agent.workspacePath);
    // 压缩态摘要段:拼在模式 system 之后(无 base 时单独成段)
    // 个性化段注入（spec §4.5）：persona 前置 + 行为段后置，全默认时逐字节还原
    // 项目会话（项目模块一期 spec §5）：base = 项目指令 + 挂载专家（预设）+
    // 会话所选助手 prompt + 预设能力声明；非项目会话为原助手 prompt。
    // 能力预设（二期 §3.7 修正）：技能清单按挂载集收窄（system 预设聚焦），
    // 工具集不硬过滤——read_skill/mcp 全量可用，会话中可按需用预设外能力
    const projectCtx = session.projectId
      ? await this.projectRepo?.getPromptContext(session.projectId)
      : null;
    const isolation =
      projectCtx && mode !== "ask"
        ? isolateProjectTools(skills, projectCtx)
        : null;
    // 专家附带技能并入（专家 2.0）：绑定专家的会话把 skillNames 中已安装
    // 技能并入清单（未启用可补入、已卸载静略，expert-catalog 纯函数）；
    // 项目会话挂载集收窄优先，不并入
    const sessionSkills = isolation
      ? isolation.skills
      : mergeExpertSkills(
          skills,
          parseJsonStringArray(assistantRow?.skillNames ?? null),
          allScanned,
        );
    const baseProjectCtx = isolation ? isolation.declaredCtx : projectCtx;
    // 专家团会话（二期 spec）：team 助手且解析出合法成员时 base 换主理人
    // 组装（成员清单+协作铁律）。members 为 prisma 原始 JSON 字符串列，
    // 需自行 parseTeamMembers（toRecord 恒数组的语义不适用于原始行）；
    // 以 expertType==="team" 判别而非 members 非空（agent 行也有该列）。
    // dispatch_member 被安全中心禁用或 ask 模式（零工具——铁律段指示的
    // 调度在 ask 下无从发生，与技能清单同缺席语义）时不组装铁律段与
    // 工具说明——system 与工具集同缺席（T3 collectToolDefinitions 同
    // 口径），对齐目录段 G1 门控的 runtimeFilter 读法（缺席不滤）；
    // plan 模式工具集仍在 → dispatch_member 同注入，铁律保留；空成员
    // teamLeadSystem 为 null 回退裸 prompt
    const teamMembers =
      assistantRow?.expertType === "team"
        ? parseTeamMembers(assistantRow.members)
        : [];
    const teamLeadSystem =
      teamMembers.length > 0
        ? buildTeamLeadSystem({
            leadPrompt: assistantRow?.systemPrompt ?? "",
            members: teamMembers,
            withDispatch:
              mode === "ask"
                ? false
                : !(this.runtimeFilter?.() ?? []).includes(
                    DISPATCH_MEMBER_TOOL_NAME,
                  ),
          })
        : null;
    // 嵌入而非替换：主理人组装进助手 prompt 槽位（项目会话项目指令段与
    // 挂载专家声明段保留，buildProjectSystemBase 段序在前）
    const base = baseProjectCtx
      ? buildProjectSystemBase(
          baseProjectCtx,
          teamLeadSystem ?? assistantRow?.systemPrompt,
        )
      : (teamLeadSystem ?? assistantRow?.systemPrompt);
    const personalization = await loadPersonalization();
    const personalized = buildPersonalizedSystem(
      personalization,
      buildModeSystem(mode, base, sessionSkills),
    );
    // 专家目录推荐指令段（专家 2.0 spec §6）：未绑专家且 agent 模式注入
    // （个性化段之后、场景段之前）；已绑专家/ask/plan 零成本不注入；
    // 终审 G1 门控：recommend_experts 被安全中心禁用时同步不注入——目录段
    // 指示模型调用该工具，而注入层 filterDisabledTools 已对模型隐藏它
    // （collectToolDefinitions 同一 runtimeFilter 来源、闭包实时读配置，
    // 缺席（测试）不滤，与 SP6 注入层同语义）；personalized 为空时目录段
    // 单独成段（沿用摘要段的空基拼接模式）
    const catalogAllowed = !(this.runtimeFilter?.() ?? []).includes(
      RECOMMEND_TOOL_NAME,
    );
    const withCatalog =
      !assistantRow && mode === "agent" && catalogAllowed
        ? `${personalized ? `${personalized}\n\n` : ""}${buildExpertCatalogPrompt(MARKET_EXPERTS)}`
        : personalized;
    // 场景提示段注入（新建任务 spec §4.2）：session.scenario 非空且已知时
    // 追加到 system 末尾；未知值/null 原样返回 base
    const scenarioSystem = buildScenarioSystem(
      session.scenario as string | null | undefined,
      withCatalog,
    );
    // 工作流挂载元说明（条件见 WORKFLOW_MOUNT_NOTE 注释）：未挂载会话
    // 在场景段之后追加，模型由此知道解锁路径而非"猜生效时机"
    const workflowNoteOn =
      mode === "agent" &&
      !isWorkflowGroupAllowed(toolGate) &&
      sessionSkills.some((s) => s.name === WORKFLOW_CREATOR_SKILL_NAME) &&
      !(this.runtimeFilter?.() ?? []).includes("read_skill");
    const baseSystem = workflowNoteOn
      ? `${scenarioSystem ? `${scenarioSystem}\n\n` : ""}${WORKFLOW_MOUNT_NOTE}`
      : scenarioSystem;
    const systemWithSummary =
      compacted && session.summary
        ? `${baseSystem ? `${baseSystem}\n\n` : ""}【此前对话摘要】\n${session.summary}`
        : baseSystem;
    return {
      session,
      modelId,
      modelRow,
      providerRow,
      assistantRow,
      merged,
      compacted,
      history,
      agent,
      mode,
      skills: sessionSkills,
      /** read_skill 消费集：非项目会话与 system 清单同源（专家附带技能
       *  展示即可读——绑定专家即显式激活）；项目会话维持挂载收窄前的
       *  全量启用扫描集（预设≠围墙，二期 §3.7，专家附带不并入） */
      allSkills: isolation ? skills : sessionSkills,
      /** 项目会话标记（plan_* 项目专属工具注入判定） */
      isProjectSession: isolation !== null,
      /** 工具分组场景门控判定输入（spec §20 项 B）：collectToolDefinitions
       *  收口与 getUsageBreakdown/probeSendCost 估算同一来源（口径一致） */
      toolGate,
      /** 专家团调度注入面（二期 T3）：team 助手且成员非空时
       *  dispatch_member 的 deps（成员集 + memberModelText 装配）；
       *  abortSignal 由 streamAndPersist 调用点随当次流补入 */
      team:
        teamMembers.length > 0
          ? {
              members: teamMembers,
              modelText: this.memberModelText(modelRow, providerRow),
            }
          : null,
      baseSystem,
      systemWithSummary,
    };
  }

  /**
   * 上下文用量拆解（chat:usage）：与下次请求同口径组装并按五类估算
   * token 占比；会话缺失/未配模型返回 null（前端灰态）
   */
  async getUsageBreakdown(
    sessionId: number,
    userId: number,
  ): Promise<ContextUsageBreakdown | null> {
    try {
      const ctx = await this.assembleContext(sessionId, userId);
      const toolDefinitions =
        ctx.mode === "ask"
          ? []
          : this.collectToolDefinitions(
              ctx.agent,
              ctx.allSkills,
              ctx.isProjectSession,
              // 二期 T3：估算口径与下次请求同集；无中止信号（未发起流）
              ctx.team,
              ctx.toolGate,
            );
      return computeUsageBreakdown({
        systemWithSummary: ctx.systemWithSummary,
        skills: ctx.skills,
        toolDefinitions,
        history: ctx.history,
        contextWindow: ctx.modelRow.contextWindow ?? null,
        params: ctx.merged,
      });
    } catch {
      return null;
    }
  }

  /** chunk 累积进主进程快照（text/thinking 追加，工具事件保序合入） */
  private accumulateSnapshot(sessionId: number, chunk: ChatStreamChunk): void {
    const snap = this.snapshots.get(sessionId) ?? emptySnapshot();
    if (chunk.type === "text-delta") {
      snap.text += chunk.text;
    } else if (chunk.type === "reasoning-delta") {
      snap.thinking += chunk.text;
    } else if (
      chunk.type === "tool-update" ||
      chunk.type === "approval-request"
    ) {
      this.applyToolChunk(snap, chunk);
    }
    this.snapshots.set(sessionId, snap);
  }

  /** 工具 chunk 合入快照：新 toolCallId 追加 order，浅合并状态字段 */
  private applyToolChunk(snap: StreamSnapshot, chunk: ToolStreamChunk): void {
    const existing = snap.tools.map[chunk.toolCallId];
    if (!existing) {
      snap.tools.order.push(chunk.toolCallId);
    }
    const state = existing ?? { toolName: chunk.toolName, state: "" };
    state.toolName = chunk.toolName;
    if (chunk.type === "tool-update") {
      state.state = chunk.state;
      if (chunk.args !== undefined) {
        state.args = chunk.args;
      }
      if (chunk.output !== undefined) {
        state.output = chunk.output;
      }
    } else {
      state.argSummary = chunk.argSummary;
    }
    snap.tools.map[chunk.toolCallId] = state;
  }

  /**
   * 查询会话流状态（切回会话时恢复 UI 用，spec §4；P1 增含 tools 态，
   * P3 增含 accessMode 供权限胶囊恢复）
   */
  status(sessionId: number): ChatStatusResult {
    const snap = this.snapshots.get(sessionId);
    return {
      streaming: this.aborts.has(sessionId),
      accessMode: this.permissions.get(sessionId),
      text: snap?.text ?? "",
      thinking: snap?.thinking ?? "",
      tools: snap?.tools ?? { order: [], map: {} },
    };
  }

  /**
   * 标题模型调用（独立可注入点，测试覆写；默认真实调用当前会话模型）
   */
  async titleModelText(ctx: {
    type: string;
    baseUrl: string;
    apiKey?: string;
    extraHeaders?: string | null;
    modelId: string;
    userText: string;
    assistantText: string;
  }): Promise<string> {
    const chat = createChatModel(ctx, ctx.modelId);
    const aiMessage = await chat.invoke(
      [
        new SystemMessage(
          "你是对话标题生成器。为以下对话生成一个不超过 12 字的中文标题，只输出标题本身。",
        ),
        new HumanMessage(`用户：${ctx.userText}\n助手：${ctx.assistantText}`),
      ],
      // M7：非流式补全必须带超时（标题失败可静默降级，不得永久挂起）
      { signal: AbortSignal.timeout(30_000) },
    );
    return aiMessageContentToText(aiMessage.content);
  }

  /**
   * 首轮问答完成后 AI 起标题（fire-and-forget；失败静默降级仅记日志，spec §6）
   */
  private async generateTitleIfFirstExchange(
    sessionId: number,
    userId: number,
    sender: WebContents | undefined,
    ctx: {
      type: string;
      baseUrl: string;
      apiKey?: string;
      extraHeaders?: string | null;
      modelId: string;
    },
  ): Promise<void> {
    try {
      // 首轮判定下推 SQL：过滤 system/error 行并限量（take 3 中第 3 条仅
      // 用于区分"恰好 2"与"≥3"），select 限定 blocks——该守卫每次发送都
      // 触发，整会话全量读回 blocks 对长会话是纯浪费
      const visible = (await prisma.message.findMany({
        where: { sessionId, role: { not: "system" }, error: null },
        orderBy: { createdAt: "asc" },
        take: 3,
        select: { blocks: true },
      })) as Array<{ blocks: string }>;
      if (visible.length !== 2) {
        return;
      }
      const session = await this.sessions.getSession(sessionId);
      if (!session || session.userId !== userId) {
        return;
      }
      const truncate = (blocksJson: string) => {
        const text = parseBlocks(blocksJson)
          .filter((block) => block.type === "text")
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("\n");
        return text.slice(0, 200);
      };
      // P0 的 autotitleIfDefault 在流式开始前已把默认标题改写为首条消息前 20 字，
      // 故两个哨兵态（默认标题 / autotitle 截断态）都视为未命名；手动改名两者皆不匹配 → 保护
      const firstUserTitle = truncate(visible[0].blocks).slice(0, 20);
      if (session.title !== "新会话" && session.title !== firstUserTitle) {
        return;
      }
      const title = (
        await this.titleModelText({
          ...ctx,
          userText: truncate(visible[0].blocks),
          assistantText: truncate(visible[1].blocks),
        })
      )
        .trim()
        .slice(0, 20);
      if (!title) {
        return;
      }
      await this.sessions.renameSession(sessionId, title, userId);
      this.emit(sender, sessionId, { type: "title-updated", title });
    } catch (e) {
      // 标题失败静默降级（对用户无感知）：仅记录日志保留可观测性
      Log.warn("AI 标题生成失败", e instanceof Error ? e.message : e);
    }
  }

  /**
   * 落地页润色：一次性非流式补全，不落库不建 session（新建任务 spec §4.3）。
   * 模型解析与 assembleContext 同口径：workspace.defaultModelId 优先，
   * 回退任意启用 provider 首个启用模型（model 与 provider 无 Prisma
   * relation，启用集需先取 provider id 再筛模型）
   */
  private async polishText(
    p: {
      workspaceId: number;
      text: string;
      style: PolishStyle;
    },
    userId: number,
  ): Promise<{ text: string }> {
    const workspace = await this.sessions.getWorkspace(p.workspaceId);
    if (!workspace || workspace.userId !== userId) {
      throw new Error("WORKSPACE_NOT_FOUND");
    }
    const enabledProviderIds = (
      await prisma.provider.findMany({
        where: { enabled: true, userId },
        select: { id: true },
      })
    ).map((row) => row.id);
    const modelRow = workspace?.defaultModelId
      ? await prisma.model.findUnique({
          where: { id: workspace.defaultModelId },
        })
      : await prisma.model.findFirst({
          where: {
            enabled: true,
            providerId: { in: enabledProviderIds },
          },
          orderBy: { id: "asc" },
        });
    const providerRow = modelRow
      ? await prisma.provider.findUnique({
          where: { id: modelRow.providerId },
        })
      : null;
    if (!modelRow || !providerRow) {
      throw new Error("未配置可用模型，请先在服务商设置中配置");
    }
    // 一次性补全（titleModelText 同款 LangChain invoke 先例，system 承载
    // 改写指令、prompt 为原文；润色无标题类 token 上限约束）
    const chat = createChatModel(
      {
        type: providerRow.type,
        baseUrl: providerRow.baseUrl,
        apiKey: providerRow.apiKey ?? undefined,
        extraHeaders: providerRow.extraHeaders,
      },
      modelRow.modelId,
    );
    const aiMessage = await chat.invoke(
      [
        new SystemMessage(STYLE_PROMPTS[p.style] ?? STYLE_PROMPTS.professional),
        new HumanMessage(p.text),
      ],
      // M7：非流式补全必须带超时——半开连接时 IPC 永久挂起
      { signal: AbortSignal.timeout(30_000) },
    );
    return { text: aiMessageContentToText(aiMessage.content) };
  }

  /**
   * 被控面桥（A9 批）：公开包装 polishText——server-face routes 经
   * ServerFaceChat 结构子集调用（polishText 保持私有，IPC chat:polish
   * 接线不变）
   */
  async polish(
    p: { workspaceId: number; text: string; style: PolishStyle },
    userId: number,
  ): Promise<{ text: string }> {
    return this.polishText(p, userId);
  }

  /**
   * 会话转办交接摘要（批 12）：归属校验 → 读会话消息生成五段式 markdown
   * （模型=会话当前模型，回落默认候选序，见 handover-summary.ts）。
   * 公开方法（与 send/status 同口径）：无消息/无模型/调用失败抛中文错误，
   * 前端 toast 直显
   */
  async handoverSummary(sessionId: number, userId: number): Promise<string> {
    await this.sessions.assertSessionOwned(sessionId, userId);
    const session = await this.sessions.getSession(sessionId);
    if (!session) {
      throw new Error("SESSION_NOT_FOUND");
    }
    return runHandoverSummary({
      prismaLike: prisma,
      sessionId,
      currentModelId: session.currentModelId,
      modelText: this.handoverModelText,
    });
  }

  stop(sessionId: number): void {
    this.aborts.get(sessionId)?.abort();
  }

  /** 远控审批应答（server-face session/approve 转发；不匹配 pending 返 false） */
  respondApproval(toolCallId: string, approved: boolean): boolean {
    return this.approvals.respond(toolCallId, approved);
  }

  /** 工作空间级工具记忆写（P4 语义上提——IPC 与远控 remember 共用）：
   *  归属校验 + upsert + remembered 审计（幂等：已存在时 update 空） */
  async rememberTool(
    workspaceId: number,
    toolName: string,
    userId: number,
  ): Promise<void> {
    await this.sessions.assertWorkspaceOwned(workspaceId, userId);
    await prisma.toolPermission.upsert({
      where: { workspaceId_toolName: { workspaceId, toolName } },
      update: {},
      create: { workspaceId, toolName },
    });
    // remembered 审计（SP1 终审归档补齐项，SP2 接入）
    this.auditSink?.({
      eventType: `${
        toolName === "run_command" ? "command-safety" : "file-safety"
      }.remembered`,
      decision: "info",
      detail: { tool: toolName, workspaceId },
    });
  }

  /** 远控审批应答（可选记住——审批记住批）：approve+remember 且控制端
   *  上送 toolName 时，先落工作空间工具记忆（会话归属校验同 IPC 口径；
   *  记忆先落防竞速——本次放行后同工具再触发即命中直执行），后 respond；
   *  toolName 未上送 / 会话无工作空间时 remembered=false 只应答 */
  async respondApprovalRemember(
    sessionId: number,
    toolCallId: string,
    approved: boolean,
    userId: number,
    remember: boolean,
    toolName: string | null,
  ): Promise<{ hit: boolean; remembered: boolean }> {
    let remembered = false;
    if (remember && approved && toolName != null && toolName !== "") {
      await this.sessions.assertSessionOwned(sessionId, userId);
      const session = await this.sessions.getSession(sessionId);
      if (session?.workspaceId != null) {
        await this.rememberTool(session.workspaceId, toolName, userId);
        remembered = true;
      }
    }
    const hit = this.approvals.respond(toolCallId, approved);
    return { hit, remembered };
  }
}
