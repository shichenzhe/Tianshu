import { ArrayNotEmpty, IsArray, IsInt } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * 自动化任务批量删除DTO（mirror automation:delete 处理体语义：他人 id
 * 混入被过滤，run 随任务级联）
 */
export class AutomationDeleteDto {
  @ApiProperty({ description: '任务标识清单（至少一项）', type: [Number] })
  @IsArray({ message: '任务标识清单必须是数组' })
  @ArrayNotEmpty({ message: '任务标识清单不能为空' })
  @IsInt({ each: true, message: '任务标识必须是整数' })
  ids: number[];
}
