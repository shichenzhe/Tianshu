import { IsInt } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * 图运行中止DTO（spec §4.1：{runId}——run 行反查 graphId 后经试运行
 * inflight 注册表 abort，USER_CANCELLED 语义与 mirror cancelTestRun 同款）
 */
export class GraphRunAbortDto {
  @ApiProperty({ description: '运行标识' })
  @IsInt({ message: '运行标识必须是整数' })
  runId: number;
}
