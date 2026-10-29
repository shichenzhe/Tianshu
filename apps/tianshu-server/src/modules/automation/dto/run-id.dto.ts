import { IsInt, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * 运行标识 DTO（移动端执行详情批：runNodes 节点详情入口）
 */
export class RunIdDto {
  @ApiProperty({ description: '运行标识' })
  @IsInt({ message: '运行标识必须是整数' })
  @Min(1, { message: '运行标识最小为 1' })
  runId: number;
}
