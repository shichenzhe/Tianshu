import { Injectable } from '@nestjs/common';
import { OperationLog } from './operation-log.entity';
import { OperationLogRepository } from './operation-log.repository';
import { OperationLogQueryFilter } from './dto/operation-log-query-filter.dto';
import { QueryResult } from 'src/commons/query/query-result';

/**
 * 操作日志服务
 */
@Injectable()
export class OperationLogService {
  constructor(
    private readonly operationLogRepository: OperationLogRepository,
  ) {}

  /**
   * 创建操作日志
   */
  async create(createDto: OperationLog): Promise<OperationLog> {
    return await this.operationLogRepository.create(createDto);
  }

  /**
   * 分页查询操作日志
   */
  async query(
    params: OperationLogQueryFilter,
  ): Promise<QueryResult<OperationLog>> {
    return await this.operationLogRepository.query(params);
  }

  /**
   * 清理过期日志
   */
  async cleanupExpiredLogs(daysToKeep: number = 90): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    return await this.operationLogRepository.deleteExpiredLogs(cutoffDate);
  }
}
