import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * 创建会话DTO（spec §3.1：{title?, workspaceId?}；
 * assistantId/currentModelId 为建会话时可选直挂列，供无头端指定起点配置）
 */
export class SessionCreateDto {
  @ApiProperty({ description: '会话标题；缺省「新会话」', required: false })
  @IsOptional()
  @IsString({ message: '标题必须是字符串' })
  @MaxLength(255, { message: '标题长度不能超过255位' })
  title?: string;

  @ApiProperty({
    description: '工作空间；缺省挂用户最近一个空间（不自建，mirror 同款）',
    required: false,
  })
  @IsOptional()
  @IsInt({ message: '工作空间标识必须是整数' })
  workspaceId?: number;

  @ApiProperty({ description: '助手', required: false })
  @IsOptional()
  @IsInt({ message: '助手标识必须是整数' })
  assistantId?: number;

  @ApiProperty({ description: '当前模型', required: false })
  @IsOptional()
  @IsInt({ message: '模型标识必须是整数' })
  currentModelId?: number;
}
