import { Controller, Post, Body, UseGuards, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../../commons/auth/guard/jwt-auth.guard';
import { RolesGuard } from '../../commons/auth/roles.guard';
import { Roles } from '../../commons/auth/roles.decorator';
import { UserType } from '@prisma/client';
import { OperationLogService } from './operation-log.service';
import { OperationLogQueryFilter } from './dto/operation-log-query-filter.dto';
import { QueryResult } from 'src/commons/query/query-result';
import { OperationLog } from './operation-log.entity';
import { SkipOperationLog } from './operation-log.interceptor';

/**
 * 操作日志控制器
 */
@SkipOperationLog()
@Controller('operationLogs')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OperationLogController {
  constructor(private readonly operationLogService: OperationLogService) {}

  /**
   * 分页查询操作日志
   */
  @Post('query')
  @Roles(UserType.admin)
  async query(
    @Body() params: OperationLogQueryFilter,
  ): Promise<QueryResult<OperationLog>> {
    return this.operationLogService.query(params);
  }

  /**
   * 清理过期日志
   */
  @Post('cleanup')
  @Roles(UserType.admin)
  async cleanup(@Body() body: { days?: number }): Promise<{
    code: number;
    message: string;
    data: { deletedCount: number };
  }> {
    const daysToKeep = body.days || 90;
    const deletedCount =
      await this.operationLogService.cleanupExpiredLogs(daysToKeep);
    return {
      code: HttpStatus.OK,
      message: `清理完成，删除了 ${deletedCount} 条过期日志`,
      data: { deletedCount },
    };
  }
}
