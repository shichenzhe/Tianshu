import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { QueryFilter } from 'src/commons/query/query-filter';

/**
 * 图查询DTO（starter QueryFilter 分页 + keyword 名称 contains 下推，查询下推批）
 */
export class GraphQueryDto extends QueryFilter {
  @ApiProperty({
    description: '名称关键词（contains 下推 DB；大小写不敏感——双引擎统一）',
    required: false,
  })
  @IsOptional()
  @IsString({ message: '关键词必须是字符串' })
  @MaxLength(255, { message: '关键词长度不能超过255位' })
  keyword?: string;
}
