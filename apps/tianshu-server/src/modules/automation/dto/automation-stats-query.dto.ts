import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * 健康度总览原始行集查询（automation/library 路由化批 2026-11-10）：
 * since 为客户端本地时区推得的窗口起点（ISO）——「今日」/趋势日键取
 * 设备时区，聚合在客户端 computeStats（@tianshu/core 单源）完成，
 * 端点不做时区假设
 */
export class AutomationStatsQueryDto {
  @ApiProperty({ description: '统计窗口起点（ISO，客户端 7 天窗口）' })
  @IsNotEmpty({ message: 'since 不能为空' })
  @IsString({ message: 'since 必须是字符串' })
  since: string;
}
