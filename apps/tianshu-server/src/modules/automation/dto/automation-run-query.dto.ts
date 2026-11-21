import { IsBoolean, IsIn, IsInt, IsOptional, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * 运行历史查询 DTO（移动端 CRUD+运行历史批）：taskId 指定 = 任务口径
 * （归属校验，不并图试运行）；缺省 = 全量（本人任务集 OR 本人图集）。
 * status 服务端下推筛选。graphId（orchestration 路由化批 2026-11-10）：
 * 图口径——编排页单图运行历史（归属校验同 taskId）。
 */
export class AutomationRunQueryDto {
  @ApiProperty({ description: '页码（1 起）' })
  @IsInt({ message: '页码必须是整数' })
  @Min(1, { message: '页码最小为 1' })
  page: number;

  @ApiProperty({
    description: '任务标识（任务口径筛选，归属校验）',
    required: false,
  })
  @IsOptional()
  @IsInt({ message: '任务标识必须是整数' })
  taskId?: number;

  @ApiProperty({
    description: '图标识（图口径筛选，归属校验）',
    required: false,
  })
  @IsOptional()
  @IsInt({ message: '图标识必须是整数' })
  graphId?: number;

  @ApiProperty({
    description:
      '固定图入口仅查顶层运行（taskId=null 且 triggerType!=subflow）',
    required: false,
  })
  @IsOptional()
  @IsBoolean({ message: 'topLevelOnly 必须是布尔值' })
  topLevelOnly?: boolean;

  @ApiProperty({
    description: '运行状态筛选',
    enum: ['running', 'success', 'failed', 'skipped'],
    required: false,
  })
  @IsOptional()
  @IsIn(['running', 'success', 'failed', 'skipped'], {
    message: '运行状态必须是 running/success/failed/skipped',
  })
  status?: 'running' | 'success' | 'failed' | 'skipped';
}
