import { QueryDecoder } from 'src/commons/query/query-decoder.interface';
import { QueryFilter, QuerySort } from 'src/commons/query/query-filter';
import { SessionQueryDto } from './dto/session-query.dto';

/**
 * 会话查询解析器（照 user 模块 querydecoder 写法）
 */
export class SessionQueryDecoder implements QueryDecoder {
  private static instance: SessionQueryDecoder;

  private constructor() {}

  public static getInstance(): SessionQueryDecoder {
    if (!SessionQueryDecoder.instance) {
      SessionQueryDecoder.instance = new SessionQueryDecoder();
    }
    return SessionQueryDecoder.instance;
  }

  sort(params: QueryFilter): any {
    const orderBy: any = {};

    if (params.sorts) {
      params.sorts.forEach((sort: QuerySort) => {
        orderBy[sort.field] = sort.direction;
      });
    } else {
      // 默认排序对齐 mirror listAllSessions：置顶优先（pinnedAt 倒序，
      // NULL 居尾 SQLite DESC）→ lastMessageAt 倒序（无消息行 null 居尾）；
      // id desc 次键保证 null 并列时分页确定
      return [{ pinnedAt: 'desc' }, { lastMessageAt: 'desc' }, { id: 'desc' }];
    }
    return orderBy;
  }

  condition(params: SessionQueryDto): any {
    const where: any = {};

    if (params.workspaceId) {
      where.workspaceId = params.workspaceId;
    }

    // keyword 不在此处：SQLite LIKE 对 ASCII 不敏感，无法表达 mirror 的
    // 大小写敏感 includes 语义——由 SessionRepository.query 内存过滤

    if (typeof params.archived === 'boolean') {
      // SQLite 语义：null 表示未归档
      where.archivedAt = params.archived ? { not: null } : null;
    }

    // A11 时间筛选批：活动时间 = lastMessageAt ?? updatedAt（mirror 桌面
    // 侧栏 FilterPopover 同口径），阈值含边界（>=）。下推 DB where 后两条
    // 查询路径（无 keyword DB 分页 / 有 keyword 先全量再内存）分页前都生效
    if (params.activityAfter) {
      const since = new Date(params.activityAfter);
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : []),
        {
          OR: [
            { lastMessageAt: { gte: since } },
            // lastMessageAt 为 null 的行回退 updatedAt 比较
            { AND: [{ lastMessageAt: null }, { updatedAt: { gte: since } }] },
          ],
        },
      ];
    }

    return where;
  }
}
