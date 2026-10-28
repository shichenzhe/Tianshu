import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * 润色载荷（A9 会话内工具批，spec 2026-10-26 §1 阶段 3：{workspaceId?,
 * text, style}）：一次性非流式补全，不落库不建会话；同步 30s 超时（对齐
 * 桌面 AbortSignal.timeout(30_000)）。style 同桌面 PolishStyle 三值
 * （professional|concise|translate-en），服务端缺省/未知回退 professional
 */
export class SessionPolishDto {
  @ApiProperty({
    description: '工作空间标识；缺省挂伴生用户最近空间',
    required: false,
  })
  @IsOptional()
  @IsInt({ message: '工作空间标识必须是整数' })
  workspaceId?: number;

  @ApiProperty({ description: '待润色文本' })
  @IsNotEmpty({ message: '待润色文本不能为空' })
  @IsString({ message: '待润色文本必须是字符串' })
  text: string;

  @ApiProperty({
    description:
      '润色风格 professional|concise|translate-en；缺省 professional',
    required: false,
  })
  @IsOptional()
  @IsString({ message: '润色风格必须是字符串' })
  style?: string;
}
