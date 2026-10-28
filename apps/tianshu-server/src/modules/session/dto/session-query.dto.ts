import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { QueryFilter } from 'src/commons/query/query-filter';

/**
 * 会话查询DTO（starter QueryFilter 分页 + 过滤字段）
 */
export class SessionQueryDto extends QueryFilter {
  @ApiProperty({ description: '工作空间过滤', required: false })
  @IsOptional()
  @IsInt({ message: '工作空间标识必须是整数' })
  workspaceId?: number;

  @ApiProperty({
    description: '标题关键词（includes 大小写敏感，内存过滤）',
    required: false,
  })
  @IsOptional()
  @IsString({ message: '关键词必须是字符串' })
  keyword?: string;

  @ApiProperty({
    description: '归档过滤：false=未归档，true=已归档',
    required: false,
  })
  @IsOptional()
  @IsBoolean({ message: '归档过滤必须是布尔值' })
  archived?: boolean;

  @ApiProperty({
    description:
      '活动时间过滤：lastMessageAt ?? updatedAt >= 阈值（含边界，ISO 8601）——阈值由客户端按本机时区计算的滚动窗上送（A11 批，对齐桌面侧栏 FilterPopover 口径）',
    required: false,
  })
  @IsOptional()
  @IsDateString({}, { message: '活动时间阈值必须是合法日期字符串' })
  activityAfter?: string;
}
