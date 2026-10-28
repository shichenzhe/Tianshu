import { IsInt, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * 会话标识DTO（getById/delete 共用）
 */
export class SessionIdDto {
  @ApiProperty({ description: '会话标识' })
  @IsNotEmpty({ message: '会话标识不能为空' })
  @IsInt({ message: '会话标识必须是整数' })
  id: number;
}
