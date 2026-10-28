import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * 图保存DTO（spec §4.1 全量 upsert：带 id → update（version 乐观锁必带）；
 * 不带 id → create）。graphJson 为图定义 JSON 字符串，合法性由仓储
 * parseGraphJson → validateGraph 保存期兜底（mirror 同款）
 */
export class GraphSaveDto {
  @ApiProperty({ description: '图标识；携带即更新语义', required: false })
  @IsOptional()
  @IsInt({ message: '图标识必须是整数' })
  id?: number;

  @ApiProperty({
    description: '乐观锁版本号（更新必带；创建忽略）',
    required: false,
  })
  @IsOptional()
  @IsInt({ message: '版本号必须是整数' })
  version?: number;

  @ApiProperty({ description: '图名称' })
  @IsString({ message: '名称必须是字符串' })
  @MaxLength(255, { message: '名称长度不能超过255位' })
  name: string;

  @ApiProperty({ description: '图描述', required: false })
  @IsOptional()
  @IsString({ message: '描述必须是字符串' })
  description?: string;

  @ApiProperty({ description: '图定义 JSON 字符串（全量）' })
  @IsString({ message: '图定义必须是 JSON 字符串' })
  graphJson: string;
}
