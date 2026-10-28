import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty } from 'class-validator';

/**
 * P1 未读角标批：已读上报载荷（spec §1.4）。messageId 为已读到的消息
 * 标识（全角色 id）——服务端单调推进（更大 id 写入，更小/相等幂等
 * 不回退）；全局 ValidationPipe 未开 whitelist，须自带显式 @IsInt 校验
 */
export class SessionReadDto {
  @ApiProperty({ description: '会话标识' })
  @IsNotEmpty({ message: '会话标识不能为空' })
  @IsInt({ message: '会话标识必须是整数' })
  sessionId: number;

  @ApiProperty({ description: '已读到的消息标识（单调推进不回退）' })
  @IsNotEmpty({ message: '消息标识不能为空' })
  @IsInt({ message: '消息标识必须是整数' })
  messageId: number;
}
