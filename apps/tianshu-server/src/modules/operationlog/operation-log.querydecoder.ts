import { QueryDecoder } from 'src/commons/query/query-decoder.interface';
import { QueryFilter, QuerySort } from 'src/commons/query/query-filter';
import { OperationLogQueryFilter } from './dto/operation-log-query-filter.dto';
import { DateUtil } from 'src/commons/util/date.util';

/**
 * 操作日志查询解码器
 */
export class OperationLogQueryDecoder implements QueryDecoder {
  private static instance: OperationLogQueryDecoder;

  private constructor() {}

  public static getInstance(): OperationLogQueryDecoder {
    if (!OperationLogQueryDecoder.instance) {
      OperationLogQueryDecoder.instance = new OperationLogQueryDecoder();
    }
    return OperationLogQueryDecoder.instance;
  }

  /**
   * 构造排序条件
   */
  sort(params: QueryFilter): any {
    const orderBy: any = {};

    if (params.sorts) {
      params.sorts.forEach((sort: QuerySort) => {
        orderBy[sort.field] = sort.direction;
      });
    } else {
      // 默认按创建时间倒序排序
      orderBy.createdAt = 'desc';
    }

    return orderBy;
  }

  /**
   * 构造查询条件
   */
  condition(params: OperationLogQueryFilter): any {
    const where: any = {};

    // 用户ID过滤
    if (params.userId) {
      where.userId = params.userId;
    }

    // 操作类型过滤
    if (params.operation) {
      where.operation = {
        contains: params.operation,
      };
    }

    // 操作状态过滤
    if (params.status) {
      where.status = params.status;
    }

    // IP地址过滤
    if (params.ipAddress) {
      where.ipAddress = {
        contains: params.ipAddress,
      };
    }

    // 时间范围过滤
    if (params.startDate || params.endDate) {
      where.createdAt = {};

      if (params.startDate) {
        where.createdAt.gte = DateUtil.truncateDate(params.startDate);
      }

      if (params.endDate) {
        where.createdAt.lte = DateUtil.truncateDateToEndTime(params.endDate);
      }
    }

    // 执行时间范围过滤
    if (
      params.minExecutionTime !== undefined ||
      params.maxExecutionTime !== undefined
    ) {
      where.executionTime = {};

      if (params.minExecutionTime !== undefined) {
        where.executionTime.gte = params.minExecutionTime;
      }

      if (params.maxExecutionTime !== undefined) {
        where.executionTime.lte = params.maxExecutionTime;
      }
    }

    return where;
  }
}
