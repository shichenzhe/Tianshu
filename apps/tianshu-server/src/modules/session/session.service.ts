import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { SessionRecord } from '@prisma/client';
import { QueryResult } from 'src/commons/query/query-result';
import { BusinessException } from 'src/commons/exception/bussiness-exception';
import { ErrorCodeEnum } from 'src/commons/exception/error-code.enum';
import {
  COMPANION_USER_ID,
  TianshuConfig,
} from 'src/commons/config/tianshu-config.entity';
import {
  ChatRunnerService,
  resolveDataRoot,
} from 'src/core/chat-runner.service';
import type { ChatStreamChunk, SessionReadResult } from '@tianshu/protocol';
import { EventBusService } from 'src/commons/event-bus/event-bus.service';
import { PrismaService } from 'src/commons/database/prisma.service';
import { SessionRepository, SessionSummaryRecord } from './session.repository';
import { SessionCreateDto } from './dto/session-create.dto';
import { SessionSendDto } from './dto/session-send.dto';
import { SessionQueryDto } from './dto/session-query.dto';
import { SessionReadDto } from './dto/session-read.dto';
import { MessageBriefDto, SessionDetailDto } from './dto/session-detail.dto';
import { SessionWireDto } from './dto/session-wire.dto';
import { SessionApproveDto } from './dto/session-approve.dto';

/** 会话标题缺省值（mirror 同款） */
const DEFAULT_SESSION_TITLE = '新会话';

/** runner 级已知错误码 → session.error 事件的用户可读文案 */
const SEND_ERROR_MESSAGES: Record<string, string> = {
  NO_MODEL:
    '未选择模型：先经 provider/save 配置，再指定会话 currentModelId 或工作空间 defaultModelId',
  MODEL_OR_PROVIDER_MISSING: '模型或服务商配置缺失',
  SESSION_NOT_FOUND: '会话不存在',
  ARCHIVED_SESSION: '会话已归档',
  CONCURRENT_REQUEST: '会话已有进行中的请求',
  MESSAGE_NOT_FOUND: '消息不存在或不是助手消息',
  NOTHING_TO_REGENERATE: '没有可重新生成的回复',
};

/** runner 异常 → session.error 载荷（未知错误原码透传便于排查） */
function describeSendError(error: unknown): { code: string; message: string } {
  const code = error instanceof Error ? error.message : String(error);
  return {
    code,
    message: SEND_ERROR_MESSAGES[code] ?? `会话执行失败: ${code}`,
  };
}

/**
 * 会话服务（userId 伴生写死 1，见 COMPANION_USER_ID 头注释）。
 * send 为 202 受理即返回——流式结果经 EventBus（message.chunk → finish 后
 * session.updated / runner 抛错 session.error）推 /event SSE。
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly chatRunner: ChatRunnerService,
    private readonly bus: EventBusService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * 审批应答（审批记忆批）：纯应答不校验归属（审批卡产生于已校验归属的
   * 会话流内，toolCallId 一次性——mirror face 同口径）；remember 是持久
   * 权限行写入——升格会话归属校验（COMPANION_USER_ID 单用户语义），
   * 记忆写表与先落防竞速在 chatRunner.approveRemember 内收口
   */
  async approve(dto: SessionApproveDto): Promise<{
    responded: boolean;
    remembered: boolean;
  }> {
    const remember = dto.remember === true && dto.approved === true;
    if (remember) {
      const session = await this.sessionRepository.findById(
        dto.sessionId,
        COMPANION_USER_ID,
      );
      if (session == null) {
        throw new BusinessException('会话不存在', ErrorCodeEnum.NOT_FOUND);
      }
    }
    const r = await this.chatRunner.approveRemember(
      dto.sessionId,
      dto.toolCallId,
      dto.approved,
      remember,
      dto.toolName ?? null,
    );
    if (!r.hit) {
      throw new BusinessException(
        '审批不存在或已应答',
        ErrorCodeEnum.NOT_FOUND,
      );
    }
    return { responded: true, remembered: r.remembered };
  }

  /**
   * 启动兜底：默认工作空间（绑定数据根下 workspace/ 沙箱目录——file 工具
   * 默认可用）。RC-T6 对齐 mirror：create 不再自建空间（无空间报 4040），
   * 伴生单用户缺省挂靠目标由本钩子在启动时保证存在
   */
  async onModuleInit(): Promise<void> {
    const directoryPath = this.defaultWorkspacePath();
    // 沙箱目录自建（缺失/多级一并补齐；失败即整体报错，不静默挂空目录）
    mkdirSync(directoryPath, { recursive: true });
    await this.sessionRepository.getOrCreateDefaultWorkspace(
      COMPANION_USER_ID,
      directoryPath,
    );
  }

  /**
   * 创建会话：workspaceId 缺省挂用户最近一个空间（mirror 同款 id desc
   * 口径，create 不自建——启动兜底 onModuleInit 已保证默认空间存在）
   */
  async create(dto: SessionCreateDto): Promise<SessionRecord> {
    const workspaceId = await this.resolveWorkspaceId(dto.workspaceId);
    return await this.sessionRepository.create({
      workspaceId,
      userId: COMPANION_USER_ID,
      title: dto.title ?? DEFAULT_SESSION_TITLE,
      assistantId: dto.assistantId ?? null,
      currentModelId: dto.currentModelId ?? null,
    });
  }

  /**
   * 发送一轮消息（202 受理即返回）：setImmediate 异步启动 ChatRunner，
   * onChunk → message.chunk 事件；正常收尾（含中止）→ session.updated，
   * runner 抛错（NO_MODEL 等）→ session.error。
   * 归档会话 send 不做同步拒绝（与 mirror 有意分歧：HTTP 语义正确，
   * 控制端按事件流处理——202 受理后 ARCHIVED_SESSION 经 session.error 回传）
   */
  async send(dto: SessionSendDto): Promise<{ accepted: true }> {
    const session = await this.sessionRepository.findById(
      dto.sessionId,
      COMPANION_USER_ID,
    );
    if (!session) {
      throw new BusinessException('会话不存在', ErrorCodeEnum.NOT_FOUND);
    }
    setImmediate(() => void this.dispatchRound(dto));
    return { accepted: true };
  }

  /** 中止会话当前流（未决审批一并作废）；返回是否存在进行中的流 */
  async abort(sessionId: number): Promise<boolean> {
    const session = await this.sessionRepository.findById(
      sessionId,
      COMPANION_USER_ID,
    );
    if (!session) {
      throw new BusinessException('会话不存在', ErrorCodeEnum.NOT_FOUND);
    }
    return this.chatRunner.stop(sessionId);
  }

  /**
   * 分页查询会话（P1 未读角标批：enriched 行——每行带 unreadCount +
   * lastMessage 查询期动态字段，repository 恒定两条聚合禁 N+1）
   */
  async query(
    params: SessionQueryDto,
  ): Promise<QueryResult<SessionSummaryRecord>> {
    return await this.sessionRepository.query(params, COMPANION_USER_ID);
  }

  /**
   * P1 未读角标批：已读上报——归属校验（4040）+ message 属会话校验
   * （4040，不泄露存在性）；游标单调推进（updateMany 条件写天然并发
   * 安全，更小/相等幂等不回退）；响应按生效游标 max(库值, 请求 id)
   * 现算 unreadCount；成功后发 enriched session.updated（updatedAt
   * 保持库值）复用清远端角标
   */
  async markSessionRead(dto: SessionReadDto): Promise<SessionReadResult> {
    const session = await this.sessionRepository.findById(
      dto.sessionId,
      COMPANION_USER_ID,
    );
    if (!session) {
      throw new BusinessException('会话不存在', ErrorCodeEnum.NOT_FOUND);
    }
    const message = await this.prisma.messageRecord.findFirst({
      where: { id: dto.messageId, sessionId: dto.sessionId },
    });
    if (!message) {
      throw new BusinessException('会话不存在', ErrorCodeEnum.NOT_FOUND);
    }
    await this.sessionRepository.advanceReadCursor(
      dto.sessionId,
      dto.messageId,
      COMPANION_USER_ID,
    );
    const cursor = Math.max(session.lastReadMessageId ?? 0, dto.messageId);
    const unreadCount = await this.sessionRepository.countUnreadAfter(
      dto.sessionId,
      cursor,
    );
    await this.publishSessionUpdated(dto.sessionId);
    return { sessionId: dto.sessionId, lastReadMessageId: cursor, unreadCount };
  }

  /** P1 未读角标批：轮次收尾/读毕统一发布 enriched session.updated——
   *  getSessionSummary 一次取回（末条摘要 + 未读数 + updatedAt 库值，
   *  绝不伪造时间戳）；会话已删/无归属静默跳过（事件无消费者可作用对象） */
  private async publishSessionUpdated(sessionId: number): Promise<void> {
    const summary = await this.sessionRepository.getSessionSummary(
      sessionId,
      COMPANION_USER_ID,
    );
    if (!summary) {
      return;
    }
    this.bus.publish({
      type: 'session.updated',
      payload: {
        id: summary.id,
        title: summary.title,
        // wire 口径归一（RC-T2）：publish 边界 Date→ISO 字符串——协议包
        // ServerEvent 定义 updatedAt 为 string，SSE/relay 序列化层原样
        // 透传；服务端进程内部（仓储/Prisma）保持 Date 不受影响
        updatedAt: summary.updatedAt.toISOString(),
        unreadCount: summary.unreadCount,
        lastMessage: summary.lastMessage,
      },
    });
  }

  /**
   * 会话详情：会话 + 消息历史（blocks 原样字符串）
   */
  async getById(id: number): Promise<SessionDetailDto> {
    const session = await this.sessionRepository.findById(
      id,
      COMPANION_USER_ID,
    );
    if (!session) {
      throw new BusinessException('会话不存在', ErrorCodeEnum.NOT_FOUND);
    }
    const messages = await this.sessionRepository.findMessages(id);
    return new SessionDetailDto({
      // prisma 行 wire 化（Date→ISO；SessionDetailDto.session 为 wire 形）
      session: SessionWireDto.of(session),
      messages: messages.map((message) => MessageBriefDto.of(message)),
    });
  }

  /**
   * 删除会话（级联清理消息）
   */
  async delete(id: number): Promise<void> {
    const session = await this.sessionRepository.findById(
      id,
      COMPANION_USER_ID,
    );
    if (!session) {
      throw new BusinessException('会话不存在', ErrorCodeEnum.NOT_FOUND);
    }
    await this.sessionRepository.delete(id);
  }

  /** 会话字段更新（重命名/模式切换/归档；title/mode/archived 至少一项） */
  async update(
    sessionId: number,
    fields: {
      title?: string;
      mode?: 'agent' | 'ask' | 'plan';
      archived?: boolean;
      pinned?: boolean;
      assistantId?: number | null;
      currentModelId?: number | null;
    },
  ): Promise<void> {
    const data: {
      title?: string;
      mode?: 'agent' | 'ask' | 'plan';
      archivedAt?: Date | null;
      pinnedAt?: Date | null;
      assistantId?: number | null;
      currentModelId?: number | null;
    } = {};
    if (fields.title !== undefined) data.title = fields.title.trim();
    if (fields.mode !== undefined) data.mode = fields.mode;
    if (fields.archived !== undefined) {
      data.archivedAt = fields.archived ? new Date() : null;
    }
    if (fields.pinned !== undefined) {
      data.pinnedAt = fields.pinned ? new Date() : null;
    }
    if (fields.assistantId !== undefined) {
      data.assistantId = fields.assistantId;
    }
    // 写前校验存在性（chat-runner send.modelId 同口径——脏值不进会话
    // 当前值，下次 send 干净失败）
    if (fields.currentModelId !== undefined) {
      if (fields.currentModelId != null) {
        const modelRow = await this.prisma.model.findUnique({
          where: { id: fields.currentModelId },
          select: { id: true },
        });
        if (!modelRow) {
          throw new BusinessException('模型不存在', ErrorCodeEnum.NOT_FOUND);
        }
      }
      data.currentModelId = fields.currentModelId;
    }
    if (data.title === '' && Object.keys(data).length === 1) {
      throw new BusinessException(
        '标题不能为空',
        ErrorCodeEnum.INTERNAL_SERVER_ERROR,
      );
    }
    if (Object.keys(data).length === 0) {
      throw new BusinessException(
        'title/mode/archived 至少一项',
        ErrorCodeEnum.INTERNAL_SERVER_ERROR,
      );
    }
    await this.sessionRepository.updateFields(
      sessionId,
      data,
      COMPANION_USER_ID,
    );
  }

  /**
   * 编辑重发（202 受理即返回；dispatch 同构——runner 换 editAndResend）
   */
  async editAndResend(dto: {
    sessionId: number;
    messageId: number;
    content: string;
  }): Promise<{ accepted: true }> {
    const session = await this.sessionRepository.findById(
      dto.sessionId,
      COMPANION_USER_ID,
    );
    if (!session) {
      throw new BusinessException('会话不存在', ErrorCodeEnum.NOT_FOUND);
    }
    setImmediate(() => void this.dispatchEditResend(dto).catch(() => {}));
    return { accepted: true };
  }

  /** 编辑重发异步执行载荷（dispatchRegenerate 同构） */
  private async dispatchEditResend(dto: {
    sessionId: number;
    messageId: number;
    content: string;
  }): Promise<void> {
    try {
      await this.chatRunner.editAndResend({
        sessionId: dto.sessionId,
        messageId: dto.messageId,
        content: dto.content,
        onChunk: (chunk) => this.publishChunk(dto.sessionId, chunk),
      });
      await this.publishSessionUpdated(dto.sessionId);
    } catch (error) {
      const described = describeSendError(error);
      this.bus.publish({
        type: 'session.error',
        payload: { sessionId: dto.sessionId, ...described },
      });
    }
  }

  /** 上下文用量拆解（session/usage；未配模型/会话缺失返回 null） */
  async usage(sessionId: number): Promise<{
    system: number;
    tools: number;
    messages: number;
    mcp: number;
    skills: number;
    total: number;
    contextWindow: number | null;
  } | null> {
    const session = await this.sessionRepository.findById(
      sessionId,
      COMPANION_USER_ID,
    );
    if (!session) {
      throw new BusinessException('会话不存在', ErrorCodeEnum.NOT_FOUND);
    }
    return this.chatRunner.getUsageBreakdown(sessionId);
  }

  /**
   * 会话权限模式（get/set 合一）：mode 缺省查询；设置后返回新值
   */
  async accessMode(
    sessionId: number,
    mode?: 'default' | 'full',
  ): Promise<{ mode: 'default' | 'full' }> {
    const session = await this.sessionRepository.findById(
      sessionId,
      COMPANION_USER_ID,
    );
    if (!session) {
      throw new BusinessException('会话不存在', ErrorCodeEnum.NOT_FOUND);
    }
    if (mode !== undefined) {
      this.chatRunner.setAccessMode(sessionId, mode);
    }
    return { mode: this.chatRunner.getAccessMode(sessionId) };
  }

  /**
   * 重新生成（202 受理即返回；send 同款异步 dispatch + 事件收尾）：
   * messageId 缺省重生成最后一条 assistant 消息
   */
  async regenerate(dto: {
    sessionId: number;
    messageId?: number;
  }): Promise<{ accepted: true }> {
    const session = await this.sessionRepository.findById(
      dto.sessionId,
      COMPANION_USER_ID,
    );
    if (!session) {
      throw new BusinessException('会话不存在', ErrorCodeEnum.NOT_FOUND);
    }
    setImmediate(
      () =>
        void this.dispatchRegenerate({ ...dto, content: '' }).catch(() => {}),
    );
    return { accepted: true };
  }

  /** regenerate 的异步执行载荷（dispatchRound 同构：run→regenerate） */
  private async dispatchRegenerate(dto: {
    sessionId: number;
    messageId?: number;
    content: string;
  }): Promise<void> {
    try {
      await this.chatRunner.regenerate({
        sessionId: dto.sessionId,
        messageId: dto.messageId,
        onChunk: (chunk) => this.publishChunk(dto.sessionId, chunk),
      });
      await this.publishSessionUpdated(dto.sessionId);
    } catch (error) {
      const described = describeSendError(error);
      this.bus.publish({
        type: 'session.error',
        payload: {
          sessionId: dto.sessionId,
          ...described,
        },
      });
    }
  }

  /**
   * 会话压缩（A9 批；202 受理即返回，dispatch 同构——runner 换 compact；
   * 行为桌面 golden：清态 → 摘要轮 → 回填 summary/compactedUpToId，中止
   * 不回填）：正常收尾（含中止）发 enriched session.updated，runner 抛错
   * 经 session.error 回传
   */
  async compact(dto: { sessionId: number }): Promise<{ accepted: true }> {
    const session = await this.sessionRepository.findById(
      dto.sessionId,
      COMPANION_USER_ID,
    );
    if (!session) {
      throw new BusinessException('会话不存在', ErrorCodeEnum.NOT_FOUND);
    }
    setImmediate(() => void this.dispatchCompact(dto).catch(() => {}));
    return { accepted: true };
  }

  /** compact 的异步执行载荷（dispatchRound 同构：run→compact） */
  private async dispatchCompact(dto: { sessionId: number }): Promise<void> {
    try {
      await this.chatRunner.compact({
        sessionId: dto.sessionId,
        onChunk: (chunk) => this.publishChunk(dto.sessionId, chunk),
      });
      await this.publishSessionUpdated(dto.sessionId);
    } catch (error) {
      const described = describeSendError(error);
      this.bus.publish({
        type: 'session.error',
        payload: { sessionId: dto.sessionId, ...described },
      });
    }
  }

  /**
   * 落地页润色（A9 批；同步 await——30s 超时语义在 runner 内
   * AbortSignal.timeout(30_000)，超时/无模型走 5000 业务错）：一次性
   * 非流式补全，不落库不建会话；workspaceId 缺省挂伴生用户最近空间
   */
  async polish(dto: {
    workspaceId?: number;
    text: string;
    style?: string;
  }): Promise<{ text: string }> {
    try {
      return await this.chatRunner.polish({
        workspaceId: dto.workspaceId,
        text: dto.text,
        style: dto.style ?? 'professional',
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      if (code === 'WORKSPACE_NOT_FOUND') {
        throw new BusinessException('工作空间不存在', ErrorCodeEnum.NOT_FOUND);
      }
      if (code === 'NO_MODEL') {
        throw new BusinessException(
          '未配置可用模型，请先在服务商设置中配置',
          ErrorCodeEnum.INTERNAL_SERVER_ERROR,
        );
      }
      throw error;
    }
  }

  /** 异步执行一轮流（send 的 setImmediate 载荷；自身兜底，异常不出逃） */
  private async dispatchRound(dto: SessionSendDto): Promise<void> {
    try {
      await this.chatRunner.run({
        sessionId: dto.sessionId,
        content: dto.content,
        images: dto.images,
        assistantId: dto.assistantId,
        modelId: dto.modelId,
        onChunk: (chunk) => this.publishChunk(dto.sessionId, chunk),
      });
      await this.publishSessionUpdated(dto.sessionId);
    } catch (error) {
      const described = describeSendError(error);
      this.bus.publish({
        type: 'session.error',
        payload: { sessionId: dto.sessionId, ...described },
      });
    }
  }

  private publishChunk(sessionId: number, chunk: ChatStreamChunk): void {
    this.bus.publish({
      type: 'message.chunk',
      payload: { sessionId, chunk },
    });
  }

  /** 工作空间解析：缺省挂用户最近一个空间（mirror 同款 id desc，不自建；
   *  无空间 4040「工作空间不存在」——被控面不可替用户拍板目录）；显式
   *  传入校验归属 */
  private async resolveWorkspaceId(workspaceId?: number): Promise<number> {
    if (workspaceId == null) {
      const latest =
        await this.sessionRepository.findLatestWorkspace(COMPANION_USER_ID);
      if (!latest) {
        throw new BusinessException('工作空间不存在', ErrorCodeEnum.NOT_FOUND);
      }
      return latest.id;
    }
    const workspace = await this.sessionRepository.getWorkspaceById(
      workspaceId,
      COMPANION_USER_ID,
    );
    if (!workspace) {
      throw new BusinessException('工作空间不存在', ErrorCodeEnum.NOT_FOUND);
    }
    return workspace.id;
  }

  /** 默认工作空间沙箱目录：数据根下 workspace/（TIANSHU_DATA_ROOT 可覆盖） */
  private defaultWorkspacePath(): string {
    const tianshu = this.configService.get<TianshuConfig>(
      'tianshu',
      TianshuConfig.getDefault(),
    );
    return path.join(resolveDataRoot(tianshu.dataRoot), 'workspace');
  }
}
