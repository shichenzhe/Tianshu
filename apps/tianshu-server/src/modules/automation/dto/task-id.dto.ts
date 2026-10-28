import { IsInt } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * 任务标识DTO（runNow 手动触发入口）
 */
export class TaskIdDto {
  @ApiProperty({ description: '任务标识' })
  @IsInt({ message: '任务标识必须是整数' })
  taskId: number;
}
