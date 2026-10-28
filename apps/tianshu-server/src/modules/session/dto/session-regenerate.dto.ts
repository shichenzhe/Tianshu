import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional } from 'class-validator';

/**
 * 重新生成载荷（messageId 缺省=最后一条 assistant 消息；删除该消息
 * 及之后全部，原位重跑——不新增 user 行）
 */
export class SessionRegenerateDto {
  @ApiProperty({ description: '会话标识' })
  @IsNotEmpty({ message: '会话标识不能为空' })
  @IsInt({ message: '会话标识必须是整数' })
  sessionId: number;

  @ApiProperty({
    description: '目标助手消息标识；缺省=最后一条',
    required: false,
  })
  @IsOptional()
  @IsInt({ message: '消息标识必须是整数' })
  messageId?: number;
}
