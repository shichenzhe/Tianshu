import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * 发送消息DTO（spec §3.1：{sessionId, content, images?, assistantId?,
 * modelId?}；FA-T1 开放 images——被控端数据根相对路径（files/uploadImage
 * 返回值），落 ImageBlock 走 loadImage 回喂链；原 attachments 字段废弃）
 */
export class SessionSendDto {
  @ApiProperty({ description: '会话标识' })
  @IsNotEmpty({ message: '会话标识不能为空' })
  @IsInt({ message: '会话标识必须是整数' })
  sessionId: number;

  @ApiProperty({ description: '用户消息内容' })
  @IsNotEmpty({ message: '消息内容不能为空' })
  @IsString({ message: '消息内容必须是字符串' })
  @MaxLength(65535, { message: '消息内容长度不能超过65535位' })
  content: string;

  @ApiProperty({
    description: '图片附件（数据根相对路径，attachments/ 前缀）',
    required: false,
  })
  @IsOptional()
  @IsArray({ message: '图片附件必须是数组' })
  @IsString({ each: true, message: '图片附件路径必须是字符串' })
  images?: string[];

  @ApiProperty({
    description: '助手（请求级覆盖，写回会话当前值）',
    required: false,
  })
  @IsOptional()
  @IsInt({ message: '助手标识必须是整数' })
  assistantId?: number;

  @ApiProperty({
    description: '模型（请求级覆盖，写回会话当前值）',
    required: false,
  })
  @IsOptional()
  @IsInt({ message: '模型标识必须是整数' })
  modelId?: number;
}
