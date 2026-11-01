/**
 * 监控控制器（MO 批）：POST monitor/stats——只读聚合面（7 天窗口）。
 * `@Public` 豁免 JWT；静态 token 守卫（TIANSHU_TOKEN）照常。scene 可选
 * 过滤（chat|graph|automation；非法值聚合全量——mirror IPC 同口径）。
 */
import { Body, Controller, HttpStatus, HttpCode, Post } from '@nestjs/common';
import { ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { MonitorStats } from '@tianshu/protocol';
import { IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Public } from 'src/commons/auth/decorator/public.decorator';
import { ApiWrappedOk } from 'src/commons/swagger/wrapped-response';
import { COMPANION_USER_ID } from 'src/commons/config/tianshu-config.entity';
import { MonitorService, isMonitorScene } from './monitor.service';

class MonitorStatsDto {
  @ApiProperty({
    description: '场景过滤（chat|graph|automation；缺省全量）',
    required: false,
  })
  @IsOptional()
  @IsString()
  scene?: string;
}

@ApiTags('监控')
@ApiExtraModels(MonitorStatsDto)
@Public()
@Controller('monitor')
export class MonitorController {
  constructor(private readonly monitorService: MonitorService) {}

  @Post('stats')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '用量统计（7 天窗口聚合）' })
  @ApiWrappedOk()
  async stats(@Body() dto: MonitorStatsDto): Promise<MonitorStats> {
    const scene = isMonitorScene(dto.scene) ? dto.scene : undefined;
    // 伴生用户常量（全仓 20+ 处同口径——硬编码 1 在常量调整时静默漏改）
    return await this.monitorService.getStats(COMPANION_USER_ID, scene);
  }
}
