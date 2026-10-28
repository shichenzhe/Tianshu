import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * 工作空间写面载荷（A8 批，spec 2026-10-26 §1.1：v1 全量字段传，三态不用）。
 * create 用 {name, icon?, defaultModelId?}；update 用 {id, name?, icon?,
 * defaultModelId?}——name 空串语义校验在 service 出稳定码 WORKSPACE_INVALID
 * （与桌面被控面同码），DTO 只管形态。
 */
export class WorkspaceSaveDto {
  @ApiProperty({ description: '工作空间标识（update 必填）', required: false })
  @IsOptional()
  @IsInt({ message: '工作空间标识必须是整数' })
  id?: number;

  @ApiProperty({ description: '名称（create 必填）', required: false })
  @IsOptional()
  @IsString({ message: '名称必须是字符串' })
  @MaxLength(255, { message: '名称长度不能超过255位' })
  name?: string;

  @ApiProperty({ description: '图标（emoji）', required: false })
  @IsOptional()
  @IsString({ message: '图标必须是字符串' })
  icon?: string;

  @ApiProperty({ description: '默认模型（库内行 id）', required: false })
  @IsOptional()
  @IsInt({ message: '默认模型标识必须是整数' })
  defaultModelId?: number;
}
