import { Injectable } from '@nestjs/common';
import {
  Prisma,
  MessageRecord,
  SessionRecord,
  Workspace,
} from '@prisma/client';
import { summarizeLastMessage } from '@tianshu/core/dist/last-message';
import type { SessionLastMessage } from '@tianshu/protocol';
import { PrismaService } from 'src/commons/database/prisma.service';
import { QueryResult } from 'src/commons/query/query-result';
import { SessionQueryDto } from './dto/session-query.dto';
import { SessionQueryDecoder } from './session.querydecoder';
import { BusinessException } from 'src/commons/exception/bussiness-exception';
import { ErrorCodeEnum } from 'src/commons/exception/error-code.enum';

/** 默认工作空间名（伴生单用户模式，无项目体系） */
const DEFAULT_WORKSPACE_NAME = 'default';

/** P1 未读角标批：会话行 + 查询期动态计算的未读角标/末条摘要（不落盘，
 *  非 Prisma 行——经 query/getSessionSummary 产出） */
export type SessionSummaryRecord = SessionRecord & {
  unreadCount: number;
  lastMessage: SessionLastMessage | null;
};

/** 建会话入参（userId 由 service 侧伴生常量写入，不收外部值） */
export interface SessionCreateParams {
  workspaceId: number;
  userId: number;
  title: string;
  assistantId?: number | null;
  currentModelId?: number | null;
}

/**
 * 会话仓库（relationMode=prisma 无外键，userId 归属过滤在查询条件维护）
 */
@Injectable()
export class SessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 默认工作空间：取用户最近一个空间（id desc，与 create 缺省挂靠
   * resolveWorkspaceId 同键位——终审备案项 B：原存在性检查 id asc 与
   * 挂靠 id desc 不对称，单一建点下无行为差，统一键位消除分叉），
   * 无则建（伴生单用户模式）。
   * T6/T7 裁定：缺省空间绑定数据根下 workspace/ 沙箱目录（自建），已有空间
   * 未绑定目录时回填（用户显式配置过的目录不覆盖）。
   * spec §13 项 5 并发安全：存在性检查→create 有空窗——并发请求同时过
   * 检查都进 create 时，由 workspace_userId_name 唯一索引兜底败者
   * （catch P2002 重查取胜者行，幂等收敛到单空间）
   */
  async getOrCreateDefaultWorkspace(
    userId: number,
    directoryPath: string,
  ): Promise<Workspace> {
    const existing = await this.findLatestWorkspace(userId);
    if (existing) {
      return this.backfillDirectoryPath(existing, directoryPath);
    }
    try {
      return await this.prisma.workspace.create({
        data: { name: DEFAULT_WORKSPACE_NAME, directoryPath, userId },
      });
    } catch (error) {
      const winner = await this.retryAfterUniqueViolation(
        error,
        userId,
        directoryPath,
      );
      if (!winner) throw error;
      return winner;
    }
  }

  /** 用户最近一个空间（id desc——mirror server-face ipc.ts
   *  resolveDefaultWorkspaceId 同款口径）：create 缺省 workspaceId 的
   *  挂靠目标 + getOrCreateDefaultWorkspace 存在性检查（同键位防分叉） */
  async findLatestWorkspace(userId: number): Promise<Workspace | null> {
    return await this.prisma.workspace.findFirst({
      where: { userId },
      orderBy: { id: 'desc' },
    });
  }

  /** 已有空间未绑定目录时回填（显式配置过的目录不覆盖） */
  private async backfillDirectoryPath(
    workspace: Workspace,
    directoryPath: string,
  ): Promise<Workspace> {
    if (!workspace.directoryPath?.trim()) {
      return await this.prisma.workspace.update({
        where: { id: workspace.id },
        data: { directoryPath },
      });
    }
    return workspace;
  }

  /** 并发竞态败者收敛：P2002（同用户同名唯一）→ 重查取胜者并同样回填目录；
   * 非 P2002 或重查仍空（异常态）返回 null 由调用方抛回原错误 */
  private async retryAfterUniqueViolation(
    error: unknown,
    userId: number,
    directoryPath: string,
  ): Promise<Workspace | null> {
    if (!(
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    )) {
      return null;
    }
    const winner = await this.findLatestWorkspace(userId);
    return winner ? this.backfillDirectoryPath(winner, directoryPath) : null;
  }

  /**
   * 按归属查工作空间
   */
  async getWorkspaceById(
    id: number,
    userId: number,
  ): Promise<Workspace | null> {
    return await this.prisma.workspace.findFirst({
      where: { id, userId },
    });
  }

  /**
   * 创建会话
   */
  async create(params: SessionCreateParams): Promise<SessionRecord> {
    return await this.prisma.sessionRecord.create({ data: params });
  }

  /**
   * 按归属查会话
   */
  async findById(id: number, userId: number): Promise<SessionRecord | null> {
    return await this.prisma.sessionRecord.findFirst({
      where: { id, userId },
    });
  }

  /** 会话字段更新（重命名/模式切换/归档共用；归属先行校验） */
  async updateFields(
    id: number,
    data: {
      title?: string;
      mode?: 'agent' | 'ask' | 'plan';
      archivedAt?: Date | null;
      pinnedAt?: Date | null;
      assistantId?: number | null;
      currentModelId?: number | null;
    },
    userId: number,
  ): Promise<void> {
    const existing = await this.findById(id, userId);
    if (!existing) {
      throw new BusinessException('会话不存在', ErrorCodeEnum.NOT_FOUND);
    }
    await this.prisma.sessionRecord.update({ where: { id }, data });
  }

  /**
   * 分页查询会话（userId 伴生固定值由 service 侧合并进 where）。
   * RC-T6 keyword 对齐 mirror（server-face routes.ts 内存
   * title.includes，大小写敏感）：SQLite LIKE 对 ASCII 不敏感、Prisma
   * SQLite 无 mode 参数，命中 keyword 时取全量行内存过滤后分页——伴生
   * 单用户百级会话量级，mirror 同款全量路径。title 列声明 NOT NULL，
   * 但外部写入/旧库残留可能为 null——?? 空串防御不抛 TypeError
   *
   * P1 未读角标批：返回 enriched 行（unreadCount + lastMessage 查询期
   * 动态算），分页切片完成后恒定两条聚合批量补算（禁 N+1）
   */
  async query(
    params: SessionQueryDto,
    userId: number,
  ): Promise<QueryResult<SessionSummaryRecord>> {
    const { keyword, ...rest } = params;
    const where = {
      ...SessionQueryDecoder.getInstance().condition(rest),
      userId,
    };
    const orderBy = SessionQueryDecoder.getInstance().sort(params);

    if (!keyword) {
      const [records, total] = await Promise.all([
        this.prisma.sessionRecord.findMany({
          where,
          skip: (params.page - 1) * params.pageSize,
          take: params.pageSize,
          orderBy,
        }),
        this.prisma.sessionRecord.count({ where }),
      ]);
      return QueryResult.of<SessionSummaryRecord>(
        await this.enrichRecords(records),
        params.page,
        params.pageSize,
        total,
      );
    }

    const filtered = (
      await this.prisma.sessionRecord.findMany({ where, orderBy })
    ).filter((row) => (row.title ?? '').includes(keyword));
    const start = (params.page - 1) * params.pageSize;
    return QueryResult.of<SessionSummaryRecord>(
      await this.enrichRecords(filtered.slice(start, start + params.pageSize)),
      params.page,
      params.pageSize,
      filtered.length,
    );
  }

  /** P1 未读角标批：单行 enriched 摘要（session.updated 事件/读毕刷新） */
  async getSessionSummary(
    id: number,
    userId: number,
  ): Promise<SessionSummaryRecord | null> {
    const row = await this.prisma.sessionRecord.findFirst({
      where: { id, userId },
    });
    if (!row) {
      return null;
    }
    const [enriched] = await this.enrichRecords([row]);
    return enriched ?? null;
  }

  /** P1 未读角标批：已读游标单调推进——updateMany 条件写（cursor 为
   *  NULL 或小于目标 id 才推进）天然并发安全；回退请求幂等不回退由
   *  条件写本身保证（更小 id 匹配零行） */
  async advanceReadCursor(
    sessionId: number,
    messageId: number,
    userId: number,
  ): Promise<void> {
    await this.prisma.sessionRecord.updateMany({
      where: {
        id: sessionId,
        userId,
        OR: [
          { lastReadMessageId: null },
          { lastReadMessageId: { lt: messageId } },
        ],
      },
      data: { lastReadMessageId: messageId },
    });
  }

  /** P1 未读角标批：单会话 cursor 后未读数（read 响应现算；cursor 0=全计） */
  async countUnreadAfter(sessionId: number, cursor: number): Promise<number> {
    return await this.prisma.messageRecord.count({
      where: {
        sessionId,
        role: 'assistant',
        ...(cursor !== 0 ? { id: { gt: cursor } } : {}),
      },
    });
  }

  /** 会话行批量 enrich：恒定两条聚合——①groupBy 各会话末条 message id
   *  一次性取行 summarizeLastMessage；②单条 groupBy 按会话分组计未读
   *  （OR 逐会话一分支：NULL 游标 bare {sessionId} 计全量，有游标
   *  {sessionId, id>cursor}——sessionId 分支内唯一，分组计数精确无交叉） */
  private async enrichRecords(
    rows: SessionRecord[],
  ): Promise<SessionSummaryRecord[]> {
    if (rows.length === 0) {
      return [];
    }
    const [lastById, unreadById] = await Promise.all([
      this.fetchLastMessages(rows.map((row) => row.id)),
      this.countUnreadBySessions(rows),
    ]);
    return rows.map((row) => ({
      ...row,
      unreadCount: unreadById.get(row.id) ?? 0,
      lastMessage: lastById.get(row.id) ?? null,
    }));
  }

  /** 各会话末条 message（groupBy _max id → 一次 findMany 批量取行 →
   *  逐行 summarizeLastMessage 纯函数出 wire 摘要） */
  private async fetchLastMessages(
    sessionIds: number[],
  ): Promise<Map<number, SessionLastMessage>> {
    const grouped = await this.prisma.messageRecord.groupBy({
      by: ['sessionId'],
      where: { sessionId: { in: sessionIds } },
      _max: { id: true },
    });
    const lastIds = grouped
      .map((g) => g._max.id)
      .filter((id): id is number => id != null);
    if (lastIds.length === 0) {
      return new Map();
    }
    const rows = await this.prisma.messageRecord.findMany({
      where: { id: { in: lastIds } },
    });
    return new Map(
      rows.map((row) => [
        row.sessionId,
        summarizeLastMessage({
          id: row.id,
          role: row.role,
          blocks: row.blocks,
          createdAt: row.createdAt,
        }),
      ]),
    );
  }

  /** 批量未读计数（单条 groupBy 按会话分组，禁 N+1） */
  private async countUnreadBySessions(
    rows: Array<{ id: number; lastReadMessageId: number | null }>,
  ): Promise<Map<number, number>> {
    const or = rows.flatMap((row) =>
      row.lastReadMessageId == null
        ? [{ sessionId: row.id }]
        : [{ sessionId: row.id, id: { gt: row.lastReadMessageId } }],
    );
    if (or.length === 0) {
      return new Map();
    }
    const grouped = await this.prisma.messageRecord.groupBy({
      by: ['sessionId'],
      where: { role: 'assistant', OR: or },
      _count: { _all: true },
    });
    return new Map(grouped.map((g) => [g.sessionId, g._count._all] as const));
  }

  /**
   * 会话消息（按 id 升序 = 发生顺序）
   */
  async findMessages(sessionId: number): Promise<MessageRecord[]> {
    return await this.prisma.messageRecord.findMany({
      where: { sessionId },
      orderBy: { id: 'asc' },
    });
  }

  /**
   * 删除会话并级联清理消息（无外键，事务内双删）
   */
  async delete(id: number): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.messageRecord.deleteMany({ where: { sessionId: id } }),
      this.prisma.sessionRecord.delete({ where: { id } }),
    ]);
  }
}
