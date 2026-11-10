import { IsBoolean, IsInt } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * 图启停DTO（orchestration 路由化批 2026-11-10）：控制端
 * orchestration:toggle 通道的远端等价入口
 */
export class GraphToggleDto {
  @ApiProperty({ description: '图标识' })
  @IsInt({ message: '图标识必须是整数' })
  id: number;

  @ApiProperty({ description: '目标启停态' })
  @IsBoolean({ message: '启停必须是布尔值' })
  enabled: boolean;
}
