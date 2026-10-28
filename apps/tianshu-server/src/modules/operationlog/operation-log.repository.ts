import { Injectable } from '@nestjs/common';
import { OperationLog } from './operation-log.entity';
import { PrismaService } from 'src/commons/database/prisma.service';
import { OperationLogQueryFilter } from './dto/operation-log-query-filter.dto';
import { QueryResult } from 'src/commons/query/query-result';
import { OperationLogQueryDecoder } from './operation-log.querydecoder';

/**
 * 操作日志仓库
 */
@Injectable()
export class OperationLogRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 创建操作日志
   */
  async create(createEntity: OperationLog): Promise<OperationLog> {
    const log = await this.prisma.operationLog.create({ data: createEntity });
    return new OperationLog(log);
  }

  /**
   * 分页查询操作日志
   */
  async query(
    params: OperationLogQueryFilter,
  ): Promise<QueryResult<OperationLog>> {
    const where = OperationLogQueryDecoder.getInstance().condition(params);
    const orderBy = OperationLogQueryDecoder.getInstance().sort(params);

    const [logs, total] = await Promise.all([
      this.prisma.operationLog.findMany({
        where,
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        orderBy,
      }),
      this.prisma.operationLog.count({ where }),
    ]);

    return QueryResult.of<OperationLog>(
      logs.map((log) => new OperationLog(log)),
      params.page,
      params.pageSize,
      total,
    );
  }

  /**
   * 清理过期日志
   */
  async deleteExpiredLogs(cutoffDate: Date): Promise<number> {
    const result = await this.prisma.operationLog.deleteMany({
      where: {
        createdAt: {
          lt: cutoffDate,
        },
      },
    });

    return result.count;
  }
}
