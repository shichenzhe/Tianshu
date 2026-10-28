import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty } from 'class-validator';

/** provider/test 与 provider/fetchModels 共用载荷（归属 provider） */
export class ProviderTargetDto {
  @ApiProperty({ description: '服务商标识' })
  @IsNotEmpty({ message: '服务商标识不能为空' })
  @IsInt({ message: '服务商标识必须是整数' })
  providerId: number;
}
