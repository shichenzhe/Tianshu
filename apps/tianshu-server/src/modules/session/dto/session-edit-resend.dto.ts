import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * 编辑重发载荷：改写该 user 消息文本并删除其后全部，原位重跑
 */
export class SessionEditResendDto {
  @ApiProperty({ description: '会话标识' })
  @IsNotEmpty({ message: '会话标识不能为空' })
  @IsInt({ message: '会话标识必须是整数' })
  sessionId: number;

  @ApiProperty({ description: '目标 user 消息标识' })
  @IsNotEmpty({ message: '消息标识不能为空' })
  @IsInt({ message: '消息标识必须是整数' })
  messageId: number;

  @ApiProperty({ description: '改写后的消息文本' })
  @IsNotEmpty({ message: '消息内容不能为空' })
  @IsString({ message: '消息内容必须是字符串' })
  @MaxLength(32_000, { message: '消息内容长度不能超过32000位' })
  content: string;
}
