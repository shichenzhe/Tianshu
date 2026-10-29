/**
 * 会话编排服务（自 mirror electron/domains/ai/chat/chat.service.ts 的
 * send/sendRound/streamAndPersist/assembleContext/resolveAgentOptions/
 * collectToolDefinitions 链路移植为无头版，DB 读写走本仓 Prisma
 * SessionRecord/MessageRecord）。
 * RC-T5：chat 纯逻辑（blocks/截断/参数合并/错误分类/时间行/场景 prompt/
 * runChatStream/consumeAgentStream）改经 @tianshu/core 包消费，本地副本已删
 * （context-usage/expert-catalog/skill-prompt 保留，见同目录）；本文件迁自
 * src/core/chat/ 并持有 runChatStream 薄包装（固定注入 toLangChainTools）。
 *
 * 无头端裁剪（详见 README 来源表）：
 * - 自动压缩（T32 autoCompact/compactRound/handover-summary）不移植——
 *   超窗兜底仍由 truncateHistory 硬截；压缩态**读取**（compactedUpToId/
 *   summary 过滤 + system 摘要段注入）保留，桌面端写入的压缩态可正确消费
 * - 标题自动生成 / 图片附件（多模态输入落盘与回喂）/
 *   专家目录与专家团（recommend_expert/dispatch）/ 项目上下文
 *   prompt（project-prompt）/ 监控埋点（recordLlmCall/recordToolCall）不移植
 * - 个性化 prompt 注入 PL-1 起移植：读侧 src/core/personalization.ts（option
 *   现查+异常回退默认），system 组装经 buildPersonalizedSystem 包裹
 *   modeSystem（persona 前置+行为段后置）；无头端 Profile 初始为空 =
 *   mirror 未配置时行为一致
 * - toolPermission 工作空间工具记忆表已移植（审批记忆批）：approve
 *   remember 写入 + isToolAllowed 查表免审；记忆查看/撤销端点不透出
 *   （远端记忆管理留桌面安全中心）
 * - 审批裁定（T7 起）：default 模式需审批操作经 tool-gate
 *   autoDenyApprovals 门自动拒绝（denied chunk + config 放行文案，不挂起）；
 *   auto-approve 模式等价 mirror full 模式静默放行；manual 模式挂起等
 *   session/approve 端点的远程应答（超时自动 deny，移动端 spec §4.3）
 */
import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
// 值导入（非 import type）：Nest DI 按 emitDecoratorMetadata 解析构造参数，
// type-only 导入会退化为 Function 导致 ChatCoreModule 装配失败
import { PrismaService } from 'src/commons/database/prisma.service';
import { COMPANION_USER_ID } from 'src/commons/config/tianshu-config.entity';
// 纯逻辑实现自 @tianshu/core 包消费（RC-T5 接入，mirror 为准——原
// src/core/chat/ 本地副本已删）；块类型契约在 @tianshu/protocol
import {
  buildPersonalizedSystem,
  buildScenarioSystem,
  estimateMessageTokens,
  estimateTokens,
  mergeParams,
  runChatStream as runChatStreamCore,
  serializeBlocks,
  type ChatStreamOptions as ChatStreamOptionsCore,
  type ChatStreamResult,
  withTimeBlock,
  recordLlmCall,
  recordToolCall,
  usageFromBlocks,
} from '@tianshu/core';
import type { ChatStreamChunk, MessageBlock } from '@tianshu/protocol';
import { BusinessException } from 'src/commons/exception/bussiness-exception';
import { buildSystemPrompt, type SkillSummary } from './skill-prompt';
import {
  createChatModel,
  type ModelCallOptions,
  type ProviderRuntimeInfo,
} from './provider/model-factory';
import { loadSkills, type SkillInfo } from './tools/skill-loader';
import { makeReadSkillTool } from './tools/read-skill';
import { makeCreateSkillTool } from './tools/create-skill';
import { makePlanTools, PLAN_TOOL_NAMES } from './tools/plan-tools';
import { makeWebTools } from './tools/web-tools';
import { makeRunCommandTool } from './tools/command-tool';
import { FILE_TOOLS } from './tools/file-tools';
import { BROWSER_BRIDGE_TOOLS } from './tools/bridge/browser-bridge-tools';
import { makeLibrarySearchTool } from './library/library-tools';
import { normalizeWorkspacePath } from './tools/workspace-path';
import type { ToolDefinition } from './tools/tool-definition';
import type { AgentStreamOptions } from './tools/tool-gate';
import { toLangChainTools } from './tools/langchain-tool-adapter';
import { ApprovalCoordinator } from './tools/approval';
import { PermissionStore, type AccessMode } from './tools/permission-mode';
import { loadPersonalization } from './personalization';
import type { ChatAccessMode } from '../commons/config/tianshu-config.entity';

/** run 入参（T7 send 端点调用面） */
export interface ChatRunnerRunOptions {
  sessionId: number;
  content: string;
  /** 图片附件（FA-T1）：被控端数据根相对路径（files/uploadImage 返回值，
   *  须 attachments/ 前缀——越界拒 FILES_IMAGE_PATH_INVALID）；落
   *  ImageBlock，引擎回喂走现有 loadImage 数据根读盘链 */
  images?: string[];
  /** 请求级助手覆盖（写进会话当前值，会话记住上次选择） */
  assistantId?: number;
  /** 请求级模型覆盖（写进会话当前值，会话记住上次选择——mirror setSessionModel 同语义） */
  modelId?: number;
  /** 伴生用户缺省 COMPANION_USER_ID */
  userId?: number;
  /** 流式 chunk 出口（relay message.chunk 载荷） */
  onChunk?: (chunk: ChatStreamChunk) => void;
}

/** ImageBlock mime 按扩展名（mirror workspace-files IMAGE_MIME 同口径） */
const IMAGE_MIME_OF: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/** images → ImageBlock 数组（FA-T1）：attachments/ 前缀校验 + mime 派生 */
function imageBlocksOf(images: string[]): MessageBlock[] {
  return images.map((imagePath) => {
    if (!imagePath.startsWith('attachments/')) {
      throw new BusinessException(
        '图片路径须为 attachments/ 相对路径',
        'FILES_IMAGE_PATH_INVALID',
      );
    }
    const ext = imagePath.slice(imagePath.lastIndexOf('.')).toLowerCase();
    const name = imagePath.slice(imagePath.lastIndexOf('/') + 1);
    return {
      type: 'image',
      imagePath,
      mime: IMAGE_MIME_OF[ext] ?? 'application/octet-stream',
      name,
    } satisfies MessageBlock;
  });
}

/** 运行配置（config.yml tianshu 段的最小消费集） */
export interface ChatRunnerConfig {
  dataRoot: string;
  allowDangerousTools: boolean;
  /** 删除保护（T6 复审 M3）：true=rm 移入回收目录；缺省 true */
  deleteProtection: boolean;
  /** 工具审批模式：default=自动拒绝；auto-approve=静默放行；manual=挂起
   *  等远程应答（session/approve 决议，超时自动 deny） */
  accessMode: ChatAccessMode;
  /** 审批挂起上限（manual 模式，毫秒）：缺省 300_000（5 分钟） */
  approvalTimeoutMs?: number;
}

/** 可注入依赖（测试替身注入面；生产走 chat-core.module 工厂装配） */
export interface ChatRunnerDeps {
  /** 模型工厂（缺省 createChatModel；测试注 scripted 假模型） */
  modelFactory?: (
    provider: ProviderRuntimeInfo,
    modelId: string,
    options?: ModelCallOptions,
  ) => BaseChatModel;
  /** 配置读取（缺省 TIANSHU_DATA_ROOT > ~/.tianshu-server，危险工具关） */
  config?: () => ChatRunnerConfig;
}

/** Nest 注入 token（缺席时构造缺省依赖，直连单测无需装配） */
export const CHAT_RUNNER_DEPS = Symbol('CHAT_RUNNER_DEPS');

/**
 * 流式执行入参/出参契约：定义在 @tianshu/core（RC-T4 剥出入包、RC-T5
 * server 接入）；此处按 server 域真身收窄泛型（toolDefinitions=ToolDefinition、
 * agent=AgentStreamOptions）并隐藏 toTools 注入点——适配器由下方包装层固定
 * 注入，既有调用方（streamAndPersist/run-chat-stream.spec 假模型直测）签名
 * 不变（mirror chat.service 同构先例）
 */
export type ChatStreamOptions = Omit<
  ChatStreamOptionsCore<ToolDefinition, AgentStreamOptions>,
  'toTools'
>;

export type { ChatStreamResult };

/**
 * 流式执行核心薄包装（实现已入 @tianshu/core）：固定注入 toLangChainTools
 * ——工具适配依赖 tool-gate 的 runToolCall 安全门/审批/审计链与 zod（server
 * 域闭包不入包，经参数注入）；行为与接入前本地副本逐行等价
 */
export async function runChatStream(
  options: ChatStreamOptions,
): Promise<ChatStreamResult> {
  return runChatStreamCore({
    ...options,
    toTools: toLangChainTools,
  });
}

/** P3 计划模式指令段（设计 spec §4 逐字；原 run-chat-stream.ts 副本迁入） */
const PLAN_MODE_INSTRUCTION =
  '当前处于计划模式：请先分析任务并输出完整可执行的计划（步骤/涉及文件/命令），在我明确确认之前不要调用任何工具执行操作。';

/**
 * /compact 摘要指令（A9 批自 mirror chat.service.ts COMPACT_DIRECTIVE 移植，
 * 逐字对齐——两仓模型可见指令同源；压缩轮即以该指令走一次普通 send
 * 轮，末条 assistant 文本回填 summary/compactedUpToId）
 */
const COMPACT_DIRECTIVE =
  '请把以上对话压缩为一份简洁的上下文摘要,供后续对话直接引用:保留关键事实、已做的决定、未决事项、重要的文件路径/引用与代码要点,舍弃寒暄与过程细节。直接输出摘要正文,不要任何前言。';

/** 润色补全指令（A9 批自 mirror chat.service.ts STYLE_PROMPTS 移植；给模型
 *  看，不进 i18n；未知 style 回退 professional 与桌面缺省口径一致） */
const STYLE_PROMPTS: Record<string, string> = {
  professional:
    '请将以下文本改写得更专业、正式，保留原意与结构，直接输出改写结果：',
  concise: '请将以下文本精简压缩，保留关键信息，直接输出精简结果：',
  'translate-en': '请将以下中文文本翻译成英文，直接输出译文：',
};

/** assistant blocks JSON → 纯文本（text 块拼接；解析失败返回空串——
 *  mirror chat.service extractAssistantText 无头版，compact 摘要回填用） */
function extractAssistantText(blocksJson: string): string {
  try {
    const blocks = JSON.parse(blocksJson) as Array<{
      type: string;
      text?: string;
    }>;
    return blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n');
  } catch {
    return '';
  }
}

/** LangChain AIMessage.content → 纯文本（string 直取；content block 数组拼
 *  text 块——mirror ai-content.ts aiMessageContentToText 无头版，polish 用） */
function aiMessageContentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text'
          ? String((part as { text?: unknown }).text ?? '')
          : '',
      )
      .join('');
  }
  return String(content ?? '');
}

/**
 * 按会话模式组装 system（P3 spec R5）：ask 仅助手原文（技能清单不注入）；
 * plan 在技能组装结果之后以空行追加计划指令段；agent 现状
 */
function buildModeSystem(
  mode: 'agent' | 'ask' | 'plan',
  base: string | undefined,
  skills: SkillSummary[],
): string | undefined {
  if (mode === 'ask') {
    return base;
  }
  const withSkills = buildSystemPrompt(base, skills);
  if (mode !== 'plan') {
    return withSkills;
  }
  return withSkills
    ? `${withSkills}\n\n${PLAN_MODE_INSTRUCTION}`
    : PLAN_MODE_INSTRUCTION;
}

/** ~ 展开（config.yml dataRoot 支持 ~ 前缀） */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** 数据根解析：TIANSHU_DATA_ROOT 环境变量 > 配置值（缺省 ~/.tianshu-server） */
export function resolveDataRoot(configured: string): string {
  return process.env.TIANSHU_DATA_ROOT
    ? process.env.TIANSHU_DATA_ROOT
    : expandHome(configured);
}

/** 上下文组装结果（assembleContext 产物，streamAndPersist 消费） */
interface AssembledContext {
  /** 模型行（modelId 字符串 = 供 SDK 的模型标识；id = 落库列） */
  modelRow: { id: number; modelId: string };
  /** 会话当前助手 id（落库列；请求级覆盖已写回会话行） */
  assistantId: number | null;
  providerRow: {
    type: string;
    baseUrl: string;
    apiKey?: string | null;
    extraHeaders?: string | null;
  };
  merged: ReturnType<typeof mergeParams>;
  contextWindow: number | undefined;
  history: Array<{ role: 'user' | 'assistant'; blocks: string }>;
  systemWithSummary: string | undefined;
  agent: AgentStreamOptions;
  mode: 'agent' | 'ask' | 'plan';
  skills: SkillInfo[];
  isProjectSession: boolean;
}

@Injectable()
export class ChatRunnerService {
  private readonly logger = new Logger(ChatRunnerService.name);
  private aborts = new Map<number, AbortController>();
  private approvals = new ApprovalCoordinator();
  private permissions = new PermissionStore();
  private readonly deps: Required<Pick<ChatRunnerDeps, 'modelFactory'>> & {
    config: () => ChatRunnerConfig;
  };

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(CHAT_RUNNER_DEPS)
    deps: ChatRunnerDeps = {},
  ) {
    this.deps = {
      modelFactory: deps.modelFactory ?? createChatModel,
      config:
        deps.config ??
        (() => ({
          dataRoot: resolveDataRoot('~/.tianshu-server'),
          allowDangerousTools: false,
          deleteProtection: true,
          accessMode: 'default',
        })),
    };
  }

  /** 运行配置（每次 run 实时读——改配置即生效） */
  private config(): ChatRunnerConfig {
    return this.deps.config();
  }

  /** 用户级技能目录（数据根 skills/） */
  private skillsDir(): string {
    return path.join(this.config().dataRoot, 'skills');
  }

  /** 服务端回收目录（rm 保护分支落点） */
  private trashRoot(): string {
    return path.join(this.config().dataRoot, 'trash');
  }

  /**
   * 发送一轮消息（T7 send 端点入口）：用户消息落库 → 流式执行 →
   * assistant 消息落库。并发守卫与 mirror send 同款（TOCTOU 消除：
   * AbortController 在首个 await 前注册）
   */
  async run(options: ChatRunnerRunOptions): Promise<void> {
    const userId = options.userId ?? COMPANION_USER_ID;
    if (this.aborts.has(options.sessionId)) {
      throw new Error('CONCURRENT_REQUEST');
    }
    const abort = new AbortController();
    this.aborts.set(options.sessionId, abort);
    try {
      this.ensureDataRoot();
      const session = await this.prisma.sessionRecord.findFirst({
        where: { id: options.sessionId, userId },
      });
      if (!session) {
        throw new Error('SESSION_NOT_FOUND');
      }
      if (session.archivedAt) {
        throw new Error('ARCHIVED_SESSION');
      }
      // 请求级模型覆盖写回前校验存在性（mirror session.repo assertModelOwned
      // 语义）：无效 modelId 在用户消息落库前干净失败，脏值不进会话当前值
      // （错误口径与 assembleContext 既有 MODEL_OR_PROVIDER_MISSING 一致）
      if (options.modelId != null) {
        const modelRow = await this.prisma.model.findUnique({
          where: { id: options.modelId },
          select: { id: true },
        });
        if (!modelRow) {
          throw new Error('MODEL_OR_PROVIDER_MISSING');
        }
      }
      // 请求级助手/模型选择写入会话当前值（会话记住上次选择；assembleContext
      // 重读会话行——请求级模型即优先于会话当前值生效，assistantId 同层）
      if (options.assistantId != null || options.modelId != null) {
        await this.prisma.sessionRecord.update({
          where: { id: options.sessionId },
          data: {
            ...(options.assistantId != null
              ? { assistantId: options.assistantId }
              : {}),
            ...(options.modelId != null
              ? { currentModelId: options.modelId }
              : {}),
          },
        });
      }
      // 用户消息立即落库（FA-T1 起 images 落 ImageBlock——控制端经
      // files/uploadImage 上传后的数据根相对路径，回喂走 loadImage 链）
      await this.appendMessage({
        sessionId: options.sessionId,
        role: 'user',
        blocks: serializeBlocks([
          { type: 'text', text: options.content },
          ...(options.images?.length ? imageBlocksOf(options.images) : []),
        ]),
        assistantId: options.assistantId ?? session.assistantId ?? undefined,
      });
      await this.streamAndPersist(options.sessionId, userId, abort, options);
    } catch (error) {
      // 早期失败（会话不存在/未选模型等）也要清理注册，避免映射表泄漏；
      // streamAndPersist 的 finally 已清理时此处为幂等空操作
      this.aborts.delete(options.sessionId);
      throw error;
    }
  }

  /**
   * 重新生成（mirror ChatService.regenerate 无头版）：定位目标 assistant
   * 消息（messageId 缺省=最后一条）→ 删除其自身及之后全部 → 原位重跑
   * （streamAndPersist 直接吃库内历史——不新增 user 行，与本地语义一致：
   * 删除保留边界(含)之后全部，重跑其前最近一轮 user 输入）
   */
  async regenerate(options: {
    sessionId: number;
    messageId?: number;
    userId?: number;
    onChunk?: (chunk: ChatStreamChunk) => void;
  }): Promise<void> {
    const userId = options.userId ?? COMPANION_USER_ID;
    if (this.aborts.has(options.sessionId)) {
      throw new Error('CONCURRENT_REQUEST');
    }
    const abort = new AbortController();
    this.aborts.set(options.sessionId, abort);
    try {
      this.ensureDataRoot();
      const session = await this.prisma.sessionRecord.findFirst({
        where: { id: options.sessionId, userId },
      });
      if (!session) {
        throw new Error('SESSION_NOT_FOUND');
      }
      if (session.archivedAt) {
        throw new Error('ARCHIVED_SESSION');
      }
      // id 升序 = 发生序（findMessages 同口径）：定位目标 assistant 行
      const rows = await this.prisma.messageRecord.findMany({
        where: { sessionId: options.sessionId },
        orderBy: { id: 'asc' },
        select: { id: true, role: true },
      });
      let targetId: number | null = null;
      if (options.messageId != null) {
        const hit = rows.find(
          (row) => row.id === options.messageId && row.role === 'assistant',
        );
        if (!hit) {
          throw new Error('MESSAGE_NOT_FOUND');
        }
        targetId = hit.id;
      } else {
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (rows[i].role === 'assistant') {
            targetId = rows[i].id;
            break;
          }
        }
      }
      if (targetId == null) {
        throw new Error('NOTHING_TO_REGENERATE');
      }
      await this.prisma.messageRecord.deleteMany({
        where: { sessionId: options.sessionId, id: { gte: targetId } },
      });
      // content 不参与（streamAndPersist 仅消费库内历史）；onChunk 透传
      await this.streamAndPersist(options.sessionId, userId, abort, {
        sessionId: options.sessionId,
        content: '',
        onChunk: options.onChunk,
      });
    } catch (error) {
      this.aborts.delete(options.sessionId);
      throw error;
    }
  }

  /**
   * 编辑重发（mirror ChatService.editAndResend 无头版）：定位目标 user
   * 消息 → 改写其 blocks 为新文本 → 删除其后全部 → 原位重跑（历史已含
   * 改写后的 user 行，streamAndPersist 直接消费，不新增行）
   */
  async editAndResend(options: {
    sessionId: number;
    messageId: number;
    content: string;
    userId?: number;
    onChunk?: (chunk: ChatStreamChunk) => void;
  }): Promise<void> {
    const userId = options.userId ?? COMPANION_USER_ID;
    if (this.aborts.has(options.sessionId)) {
      throw new Error('CONCURRENT_REQUEST');
    }
    const abort = new AbortController();
    this.aborts.set(options.sessionId, abort);
    try {
      this.ensureDataRoot();
      const session = await this.prisma.sessionRecord.findFirst({
        where: { id: options.sessionId, userId },
      });
      if (!session) {
        throw new Error('SESSION_NOT_FOUND');
      }
      if (session.archivedAt) {
        throw new Error('ARCHIVED_SESSION');
      }
      const target = await this.prisma.messageRecord.findFirst({
        where: {
          id: options.messageId,
          sessionId: options.sessionId,
          role: 'user',
        },
      });
      if (!target) {
        throw new Error('MESSAGE_NOT_FOUND');
      }
      // 改写 user 行 + 截断其后（id 升序边界，regenerate 同口径）
      await this.prisma.$transaction([
        this.prisma.messageRecord.update({
          where: { id: target.id },
          data: {
            blocks: serializeBlocks([{ type: 'text', text: options.content }]),
          },
        }),
        this.prisma.messageRecord.deleteMany({
          where: {
            sessionId: options.sessionId,
            id: { gt: target.id },
          },
        }),
      ]);
      await this.streamAndPersist(options.sessionId, userId, abort, {
        sessionId: options.sessionId,
        content: '',
        onChunk: options.onChunk,
      });
    } catch (error) {
      this.aborts.delete(options.sessionId);
      throw error;
    }
  }

  /**
   * 会话压缩（A9 批，mirror ChatService.compact/compactRound 无头版，
   * 行为逐行对齐桌面 golden）：
   * 并发守卫前置（旧实现经内部 send 守卫触发但清态先行，并发时白丢摘要）→
   * 清旧压缩态（保证摘要基于全量历史）→ 摘要指令走一次普通发送轮 →
   * 取末条 assistant 文本回填 summary/compactedUpToId；中止不回填（摘要轮
   * 可能是残文）。后续 send 上下文 = 摘要 + 压缩点后消息（assembleContext
   * 既有压缩态读取链零改动）
   */
  async compact(options: {
    sessionId: number;
    userId?: number;
    onChunk?: (chunk: ChatStreamChunk) => void;
  }): Promise<void> {
    const userId = options.userId ?? COMPANION_USER_ID;
    if (this.aborts.has(options.sessionId)) {
      throw new Error('CONCURRENT_REQUEST');
    }
    const abort = new AbortController();
    this.aborts.set(options.sessionId, abort);
    try {
      this.ensureDataRoot();
      const session = await this.prisma.sessionRecord.findFirst({
        where: { id: options.sessionId, userId },
      });
      if (!session) {
        throw new Error('SESSION_NOT_FOUND');
      }
      if (session.archivedAt) {
        throw new Error('ARCHIVED_SESSION');
      }
      // 清旧压缩态（mirror compactRound 首步 updateSummary(null, null)）
      await this.prisma.sessionRecord.update({
        where: { id: options.sessionId },
        data: { summary: null, compactedUpToId: null },
      });
      // 摘要指令走一次普通发送轮（指令落 user 行 + 流式可见，与
      // 桌面 sendRound(COMPACT_DIRECTIVE) 同语义——无头端无自动压缩，
      // 不存在指令豁免问题）
      await this.appendMessage({
        sessionId: options.sessionId,
        role: 'user',
        blocks: serializeBlocks([{ type: 'text', text: COMPACT_DIRECTIVE }]),
      });
      await this.streamAndPersist(options.sessionId, userId, abort, {
        sessionId: options.sessionId,
        content: COMPACT_DIRECTIVE,
        onChunk: options.onChunk,
      });
      if (abort.signal.aborted) {
        return;
      }
      // 摘要轮 streamAndPersist finally 已清注册：恢复之，摘要回填写期间
      // stop/并发守卫不缺位（mirror compactRound 同款重注册）
      this.aborts.set(options.sessionId, abort);
      const rows = await this.prisma.messageRecord.findMany({
        where: { sessionId: options.sessionId, role: 'assistant' },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });
      const last = rows[0];
      if (!last) {
        return;
      }
      const summaryText = extractAssistantText(last.blocks);
      if (summaryText.trim() === '') {
        return;
      }
      await this.prisma.sessionRecord.update({
        where: { id: options.sessionId },
        data: { summary: summaryText, compactedUpToId: last.id },
      });
    } finally {
      this.aborts.delete(options.sessionId);
    }
  }

  /**
   * 落地页润色（A9 批，mirror ChatService.polishText 无头版，行为逐行
   * 对齐桌面 golden）：一次性非流式补全，不落库不建会话。模型解析与
   * assembleContext 同口径：workspace.defaultModelId 优先，回退首个启用
   * provider 的 id 最小启用模型（model 与 provider 无 Prisma relation，
   * 启用集先取 provider id 再筛模型）；30s 超时（mirror M7：非流式补全
   * 必须带超时——半开连接时 HTTP 永久挂起）
   */
  async polish(options: {
    workspaceId?: number;
    text: string;
    style: string;
    userId?: number;
  }): Promise<{ text: string }> {
    const userId = options.userId ?? COMPANION_USER_ID;
    // workspaceId 缺省挂伴生用户最近空间（session.service resolveWorkspaceId
    // 同款口径；无空间不报错——按无默认模型走回退链）
    let workspace: { id: number; defaultModelId: number | null } | null = null;
    if (options.workspaceId != null) {
      workspace = await this.prisma.workspace.findFirst({
        where: { id: options.workspaceId, userId },
      });
      if (!workspace) {
        throw new Error('WORKSPACE_NOT_FOUND');
      }
    } else {
      workspace = await this.prisma.workspace.findFirst({
        where: { userId },
        orderBy: { id: 'desc' },
      });
    }
    const enabledProviderIds = (
      await this.prisma.provider.findMany({
        where: { enabled: true, userId },
        select: { id: true },
      })
    ).map((row) => row.id);
    const modelRow = workspace?.defaultModelId
      ? await this.prisma.model.findUnique({
          where: { id: workspace.defaultModelId },
        })
      : await this.prisma.model.findFirst({
          where: {
            enabled: true,
            providerId: { in: enabledProviderIds },
          },
          orderBy: { id: 'asc' },
        });
    const providerRow = modelRow
      ? await this.prisma.provider.findUnique({
          where: { id: modelRow.providerId },
        })
      : null;
    if (!modelRow || !providerRow) {
      throw new Error('NO_MODEL');
    }
    const chat = this.deps.modelFactory(
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
        new SystemMessage(
          STYLE_PROMPTS[options.style] ?? STYLE_PROMPTS.professional,
        ),
        new HumanMessage(options.text),
      ],
      { signal: AbortSignal.timeout(30_000) },
    );
    return { text: aiMessageContentToText(aiMessage.content) };
  }

  /** 中止会话当前流（未决审批一并作废），返回是否存在进行中的流 */
  stop(sessionId: number): boolean {
    const abort = this.aborts.get(sessionId);
    if (!abort) {
      return false;
    }
    abort.abort();
    return true;
  }

  /** A10 审批记忆批：当前 full 授权会话 id 列表（permission/listFullGrants
   *  数据源——运行态内存表，全局语义与桌面被控面同口径） */
  listFullGrantSessionIds(): number[] {
    return this.permissions.listFull();
  }

  /** A10 审批记忆批：一键收回全部 full 会话（收紧权限无泄露面），返回
   *  实际收回条数（permission/revokeAllFull 回 {revoked}）；空集 0 */
  revokeAllFullGrants(): number {
    const ids = this.permissions.listFull();
    for (const id of ids) {
      this.permissions.set(id, 'default');
    }
    return ids.length;
  }

  /** 审批决议（T7 relay 转发控制端应答）；未知 id 返回 false */
  approve(toolCallId: string, approved: boolean): boolean {
    return this.approvals.respond(toolCallId, approved);
  }

  /** 审批决议（可选记住——审批记忆批）：remember 且批准且上送 toolName
   *  时，经会话行取 workspaceId 后先落 toolPermission 记忆（upsert 幂等，
   *  先落防竞速——本次放行后同工具再触发即命中免审），后 respond；
   *  会话归属校验由调用方（session.service approve）收口 */
  async approveRemember(
    sessionId: number,
    toolCallId: string,
    approved: boolean,
    remember: boolean,
    toolName: string | null,
  ): Promise<{ hit: boolean; remembered: boolean }> {
    let remembered = false;
    if (remember && approved && toolName != null && toolName !== '') {
      const session = await this.prisma.sessionRecord.findFirst({
        where: { id: sessionId },
        select: { workspaceId: true },
      });
      if (session != null) {
        await this.prisma.toolPermission.upsert({
          where: {
            workspaceId_toolName: {
              workspaceId: session.workspaceId,
              toolName,
            },
          },
          update: {},
          create: { workspaceId: session.workspaceId, toolName },
        });
        remembered = true;
      }
    }
    const hit = this.approvals.respond(toolCallId, approved);
    return { hit, remembered };
  }

  /** 会话工具权限模式（full=静默放行 write）；未设置缺省 default */
  /** 会话当前权限模式（session/accessMode 查询面；未设缺省 default） */
  getAccessMode(sessionId: number): AccessMode {
    return this.permissions.get(sessionId);
  }

  /**
   * 上下文用量拆解（session/usage；AL 批）：与下次请求同口径组装按类
   * 估算——mirror getUsageBreakdown 简化同构（技能清单段并入 system、
   * 无 MCP 工具面恒 0；estimate 函数 core 同源）
   */
  async getUsageBreakdown(
    sessionId: number,
    userId?: number,
  ): Promise<{
    system: number;
    tools: number;
    messages: number;
    mcp: number;
    skills: number;
    total: number;
    contextWindow: number | null;
  } | null> {
    try {
      const uid = userId ?? COMPANION_USER_ID;
      const ctx = await this.assembleContext(sessionId, uid);
      const system = ctx.systemWithSummary
        ? estimateTokens(ctx.systemWithSummary)
        : 0;
      const tools =
        ctx.mode === 'ask'
          ? 0
          : estimateTokens(JSON.stringify(this.collectToolDefinitions(ctx)));
      const messages = ctx.history.reduce(
        (sum, row) => sum + estimateMessageTokens(row.blocks),
        0,
      );
      return {
        system,
        tools,
        messages,
        mcp: 0,
        skills: 0,
        total: system + tools + messages,
        contextWindow: ctx.contextWindow ?? null,
      };
    } catch {
      return null;
    }
  }

  setAccessMode(sessionId: number, mode: AccessMode): void {
    this.permissions.set(sessionId, mode);
  }

  /**
   * 通用编排（mirror streamAndPersist 无头版）：解析模型/助手 → 合并参数 →
   * 截断历史 → agent 流式执行 → 持久化（finally 清理注册并作废未决审批）
   */
  private async streamAndPersist(
    sessionId: number,
    userId: number,
    abort: AbortController,
    options: ChatRunnerRunOptions,
  ): Promise<void> {
    const startedAt = Date.now();
    const ctx = await this.assembleContext(sessionId, userId);
    try {
      const result = await runChatStream({
        model: this.deps.modelFactory(
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
        contextWindow: ctx.contextWindow,
        params: ctx.merged,
        abortSignal: abort.signal,
        toolDefinitions:
          ctx.mode === 'ask' ? [] : this.collectToolDefinitions(ctx),
        agent: ctx.agent,
        onChunk: options.onChunk,
      });

      // 持久化 assistant 消息（中断也保留已生成部分）
      if (result.blocks.length > 0 || result.errorCode) {
        await this.appendMessage({
          sessionId,
          role: 'assistant',
          blocks: serializeBlocks(result.blocks),
          modelId: ctx.modelRow.id,
          assistantId: options.assistantId ?? ctx.assistantId ?? undefined,
          error: result.errorMessage,
          durationMs: Date.now() - startedAt,
        });
      }
      // 监控埋点（MO 批；mirror chat.service 同位）：落库时提取 usage
      // （错误轮次/中止无 usage 块不写）；recordLlmCall 自吞错
      const usage = usageFromBlocks(result.blocks);
      if (usage) {
        void recordLlmCall(this.prisma, {
          userId,
          scene: 'chat',
          modelId: ctx.modelRow.id,
          sessionId,
          inputTokens: usage.input,
          outputTokens: usage.output,
          durationMs: Date.now() - startedAt,
        });
      }
      if (result.errorCode) {
        options.onChunk?.({
          type: 'error',
          errorCode: result.errorCode,
          message: result.errorMessage ?? '',
        });
      } else {
        options.onChunk?.({ type: 'finish' });
      }
    } finally {
      this.aborts.delete(sessionId);
      // 中断/收尾：作废全部未决审批（resolve false），释放挂起的 execute
      this.approvals.voidAll();
    }
  }

  /** 采样参数经构造注入（终审 T9c 口径：不随请求下发模型） */

  /**
   * 上下文组装（mirror assembleContext 无头版）：会话/模型/助手 → 参数
   * 合并 → 压缩态过滤历史（+时间行注入）→ agent/模式/技能 → system
   */
  private async assembleContext(
    sessionId: number,
    userId: number,
  ): Promise<AssembledContext> {
    const session = await this.prisma.sessionRecord.findFirst({
      where: { id: sessionId, userId },
    });
    if (!session) {
      throw new Error('SESSION_NOT_FOUND');
    }
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: session.workspaceId },
    });
    let modelId = session.currentModelId ?? workspace?.defaultModelId ?? null;
    if (!modelId) {
      // P1 双空兜底：远控空建会话 + fresh 库首用，取首个可用 llm 模型
      modelId = await this.firstEnabledLlmModelId(userId);
      if (!modelId) {
        throw new Error('NO_MODEL');
      }
    }
    const modelRow = await this.prisma.model.findUnique({
      where: { id: modelId },
    });
    const providerRow = modelRow
      ? await this.prisma.provider.findUnique({
          where: { id: modelRow.providerId },
        })
      : null;
    if (!modelRow || !providerRow) {
      throw new Error('MODEL_OR_PROVIDER_MISSING');
    }
    const assistantRow = session.assistantId
      ? await this.prisma.assistant.findUnique({
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
    ]);

    // /compact 压缩态：历史只取压缩点之后（摘要经 system 注入替代旧消息）；
    // 宽松判空与 mirror 同口径
    const compacted =
      session.compactedUpToId != null && session.summary != null;
    const history = (
      await this.prisma.messageRecord.findMany({
        where: {
          sessionId,
          ...(compacted ? { id: { gt: session.compactedUpToId ?? 0 } } : {}),
        },
        orderBy: { id: 'asc' },
        select: { role: true, blocks: true, error: true },
      })
    )
      .filter((row) => row.role !== 'system' && !row.error)
      .map((row) => ({
        role: row.role as 'user' | 'assistant',
        blocks: row.blocks,
      }));
    // 时间行注入（time-context）：最后一条 user 消息 blocks 头部——每次请求
    // 重拼随请求刷新；放这里而非 system 是为前缀缓存
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'user') {
        history[i] = {
          ...history[i],
          blocks: withTimeBlock(history[i].blocks, new Date()),
        };
        break;
      }
    }

    // 模式归一（P3 spec R5）：DB null/未识别值归一 agent；ask 零工具零技能
    const mode: 'agent' | 'ask' | 'plan' =
      session.mode === 'ask' || session.mode === 'plan'
        ? session.mode
        : 'agent';
    // 模式为 plan 的属地依据：会话关联项目即视为项目会话（plan_* 注入判定）
    const isProjectSession = session.projectId != null;

    const workspaceDir = workspace?.directoryPath?.trim()
      ? normalizeWorkspacePath(workspace.directoryPath)
      : null;
    const skills =
      mode === 'ask' ? [] : await this.collectSkills(workspaceDir ?? undefined);

    const modeSystem = buildModeSystem(
      mode,
      assistantRow?.systemPrompt,
      skills,
    );
    // 个性化段注入（PL-1，mirror chat.service assembleContext 同构）：
    // persona 前置 + 行为段（风格/身份/记忆/画像/指令）后置包裹 modeSystem，
    // 场景段仍居末；全默认（无头端 Profile 初始为空）时逐字节还原 modeSystem
    // （D8），行为与 mirror 未配置一致。每轮现查 option 不缓存
    const personalization = await loadPersonalization(this.prisma.option);
    const personalized = buildPersonalizedSystem(personalization, modeSystem);
    const baseSystem = buildScenarioSystem(session.scenario, personalized);
    const systemWithSummary =
      compacted && session.summary
        ? `${baseSystem ? `${baseSystem}\n\n` : ''}【此前对话摘要】\n${session.summary}`
        : baseSystem;

    const config = this.config();
    return {
      modelRow,
      assistantId: session.assistantId,
      providerRow,
      merged,
      contextWindow: modelRow.contextWindow ?? undefined,
      history,
      systemWithSummary,
      agent: {
        sessionId,
        userId: session.userId ?? undefined,
        modelId,
        workspacePath: workspaceDir ?? undefined,
        projectId: session.projectId ?? null,
        allowDangerousTools: config.allowDangerousTools,
        // 监控埋点（MO 批；mirror 同位）：终态工具事件 fire-and-forget
        toolStats: (e) =>
          void recordToolCall(this.prisma, {
            ...e,
            scene: 'chat',
            userId: session.userId ?? null,
            sessionId,
          }),
        // auto-approve 配置等价会话 full 模式（mirror 语义），撤回配置即收回
        fullAccess: () =>
          this.permissions.get(sessionId) === 'full' ||
          config.accessMode === 'auto-approve',
        // 工作空间工具记忆查表（审批记忆批）：session/approve remember
        // 写入——同空间同工具 write 免审；未记忆恒审批（原安全侧语义）
        isToolAllowed: async (toolName: string) => {
          const row = await this.prisma.toolPermission.findUnique({
            where: {
              workspaceId_toolName: {
                workspaceId: session.workspaceId,
                toolName,
              },
            },
          });
          return row != null;
        },
        // manual 模式挂起等远程应答（session/approve），超时自动 deny
        requestApproval: (toolCallId, argSummary) =>
          config.accessMode === 'auto-approve'
            ? Promise.resolve(true)
            : config.accessMode === 'manual'
              ? this.approvals.request(
                  toolCallId,
                  argSummary,
                  config.approvalTimeoutMs ?? 300_000,
                )
              : Promise.resolve(false),
        autoDenyApprovals: !(
          config.accessMode === 'auto-approve' || config.accessMode === 'manual'
        ),
        deleteProtection: config.deleteProtection,
        trashRoot: this.trashRoot(),
      },
      mode,
      skills,
      isProjectSession,
    };
  }

  /**
   * 模型末位兜底（P1）：currentModelId 与 defaultModelId 双空时取首个启用的
   * llm 模型——type="llm" 且 model.enabled，随 provider.enabled。model 与
   * provider 无 Prisma relation（schema：关联列普通列、service 层维护），
   * 启用集先取 provider id 再筛模型（mirror polishText 同款两步查）。
   * 再无可用模型返回 null（调用方维持 NO_MODEL，文案已含配置指引）
   */
  private async firstEnabledLlmModelId(userId: number): Promise<number | null> {
    const providers = await this.prisma.provider.findMany({
      where: { enabled: true, userId },
      select: { id: true },
    });
    if (providers.length === 0) {
      return null;
    }
    const model = await this.prisma.model.findFirst({
      where: {
        type: 'llm',
        enabled: true,
        providerId: { in: providers.map((row) => row.id) },
      },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    return model?.id ?? null;
  }

  /**
   * 注入工具集（mirror collectToolDefinitions 无头版）：read_skill 常驻
   * （未绑定目录也注入）；create_skill 落盘用户技能目录不依赖工作空间，
   * 同样常驻；plan_* 项目专属（仅项目会话注入）；文件五件与 fetch
   * 依赖工作空间路径，仅绑定目录后注入；bash 例外——未绑定目录
   * 也注入（cwd 锚点落家目录；allowDangerousTools=false 时在门层整体拒绝）；
   * browser 四件桥版（TB-T2/R3 缺口 1，spec §2.3）常驻注入——执行体发
   * tool.request 转控制端桌面执行，不依赖本机工作空间；library_search
   * （PL-2，spec §2.2）同样常驻——用户级资料库语义检索，不依赖工作空间。
   */
  private collectToolDefinitions(ctx: AssembledContext): ToolDefinition[] {
    const baseTools: ToolDefinition[] = [
      ...FILE_TOOLS,
      makeRunCommandTool(),
      ...makeWebTools(),
      makeCreateSkillTool({
        skillsRoot: this.skillsDir(),
        prisma: this.prisma.skillRecord,
      }),
    ];
    const workspaceScoped = ctx.agent.workspacePath
      ? baseTools
      : baseTools.filter(
          (def) => def.name === 'bash' || def.name === 'create_skill',
        );
    const injected = ctx.isProjectSession
      ? workspaceScoped
      : // plan 组项目专属：非项目会话剔除（显式名集——2026-10-29 改名
        // 批次 todo_* 坍缩后原 plan_ 前缀过滤失效，mirror 同款修正）
        workspaceScoped.filter(
          (def) => !PLAN_TOOL_NAMES.includes(def.name),
        );
    const planTools = ctx.isProjectSession
      ? makePlanTools({ prisma: this.prisma })
      : [];
    return [
      makeReadSkillTool(ctx.skills),
      ...planTools,
      ...injected,
      ...BROWSER_BRIDGE_TOOLS,
      // PL-2：library_search 资料库语义检索常驻（用户级资料库不依赖工作
      // 空间；显式注入本仓 prisma，不经 graph 运行时解析）
      makeLibrarySearchTool({ db: this.prisma }),
    ];
  }

  /**
   * 技能清单即时扫描（设计 spec §2）：每次 run 现算、无缓存——增删技能免
   * 重启生效；用户级目录始终加载，工作空间级仅在绑定目录时追加。
   * T6 复审 M2 / spec §13 项 4：目录扫描后按 skillRecord.enabled 过滤——
   * 禁用即时生效，禁用对模型=不存在（system 清单与 read_skill 同步剔除）；
   * 仅用户级受管（mirror filterDisabledSkills 同构：工作空间级项目本地
   * 技能不经全局启用开关）
   */
  private async collectSkills(workspaceDir?: string): Promise<SkillInfo[]> {
    const dirs: Array<{ dir: string; source: 'user' | 'workspace' }> = [
      { dir: this.skillsDir(), source: 'user' },
    ];
    if (workspaceDir) {
      dirs.push({
        dir: path.join(workspaceDir, '.tianshu', 'skills'),
        source: 'workspace',
      });
    }
    const scanned = loadSkills(dirs);
    const disabled = await this.prisma.skillRecord.findMany({
      where: { enabled: false },
      select: { name: true },
    });
    const disabledNames = new Set(disabled.map((row) => row.name));
    return scanned.filter(
      (skill) => !(skill.source === 'user' && disabledNames.has(skill.name)),
    );
  }

  /** 追加消息并刷新会话时间戳（mirror SessionRepository.appendMessage 同构） */
  private async appendMessage(message: {
    sessionId: number;
    role: 'user' | 'assistant';
    blocks: string;
    modelId?: number;
    assistantId?: number;
    error?: string;
    durationMs?: number;
  }): Promise<void> {
    await this.prisma.messageRecord.create({
      data: {
        sessionId: message.sessionId,
        role: message.role,
        blocks: message.blocks,
        modelId: message.modelId,
        assistantId: message.assistantId,
        error: message.error,
        durationMs: message.durationMs,
      },
    });
    await this.prisma.sessionRecord.update({
      where: { id: message.sessionId },
      data: { lastMessageAt: new Date(), updatedAt: new Date() },
    });
  }

  /** 数据根就绪（技能/回收目录懒建；失败只影响对应工具的落盘，不挡 run） */
  ensureDataRoot(): void {
    try {
      fs.mkdirSync(this.skillsDir(), { recursive: true });
      fs.mkdirSync(this.trashRoot(), { recursive: true });
    } catch (e) {
      this.logger.warn(
        `数据根目录创建失败: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
