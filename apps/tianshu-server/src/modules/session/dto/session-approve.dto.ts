import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString } from 'class-validator';

/**
 * 审批应答DTO（移动端 spec §4.3：manual 模式挂起流的远程决议；
 * remember/toolName 审批记忆批——对齐 @tianshu/protocol ApproveParams）
 */
export class SessionApproveDto {
  @ApiProperty({ description: '会话 id' })
  @IsInt()
  sessionId: number;

  @ApiProperty({ description: '待应答工具调用 id' })
  @IsString()
  toolCallId: string;

  @ApiProperty({ description: '批准与否' })
  @IsBoolean()
  approved: boolean;

  @ApiProperty({
    description: '批准并写工作空间级工具记忆（拒绝时忽略）',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  remember?: boolean;

  @ApiProperty({
    description: 'remember 时上送的 pending 工具名（记忆写行用）',
    required: false,
  })
  @IsOptional()
  @IsString()
  toolName?: string;
}
