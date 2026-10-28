import { IsInt } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * 图标识DTO（删除等单 id 入口）
 */
export class GraphIdDto {
  @ApiProperty({ description: '图标识' })
  @IsInt({ message: '图标识必须是整数' })
  id: number;
}
