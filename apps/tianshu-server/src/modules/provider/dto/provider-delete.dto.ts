import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsInt, IsOptional } from 'class-validator';

/**
 * provider/delete 载荷：批量删除（providerIds 级联清其 models；
 * modelIds 单删；归属外的 id 静默跳过——幂等）
 */
export class ProviderDeleteDto {
  @ApiProperty({ description: '服务商标识数组', required: false })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true, message: '服务商标识必须是整数数组' })
  providerIds?: number[];

  @ApiProperty({ description: '模型行标识数组', required: false })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true, message: '模型行标识必须是整数数组' })
  modelIds?: number[];
}
