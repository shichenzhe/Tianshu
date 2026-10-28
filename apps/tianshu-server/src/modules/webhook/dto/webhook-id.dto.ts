import { IsInt } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * webhook 管理图标识DTO（disable/status 单图入口，WH 批 2026-10-27）
 */
export class WebhookIdDto {
  @ApiProperty({ description: '图标识' })
  @IsInt({ message: '图标识必须是整数' })
  graphId: number;
}
