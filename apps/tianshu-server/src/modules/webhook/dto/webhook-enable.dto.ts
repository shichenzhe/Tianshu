import { IsBoolean, IsInt, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * webhook 开启DTO（WH 批 2026-10-27；形状对齐 mirror
 * orchestration:webhookEnable 的 config 段 + fullAccess 无头端先行扩展：
 * 开启即重开——生成新 token 旧失效）。statusCode 校验 100-599 整数
 * （service parseConfigValue 归一口径）
 */
export class WebhookEnableDto {
  @ApiProperty({ description: '图标识' })
  @IsInt({ message: '图标识必须是整数' })
  graphId: number;

  @ApiProperty({
    description: '响应体模板（{{nodes.x.output}}/{{input.y}}；空=默认 JSON）',
    required: false,
  })
  @IsOptional()
  @IsString({ message: '响应模板必须是字符串' })
  responseTemplate?: string;

  @ApiProperty({
    description: '响应状态码（100-599；默认 200）',
    required: false,
    minimum: 100,
    maximum: 599,
  })
  @IsOptional()
  @IsInt({ message: '响应状态码必须是整数' })
  statusCode?: number;

  @ApiProperty({
    description: '异步 job 模式（202+jobId 轮询；默认同步挂起）',
    required: false,
  })
  @IsOptional()
  @IsBoolean({ message: '异步开关必须是布尔值' })
  async?: boolean;

  @ApiProperty({
    description:
      '图级完全访问：开启后本图 webhook 触发时代码/文件写入节点放行（默认 false）',
    required: false,
  })
  @IsOptional()
  @IsBoolean({ message: '全权开关必须是布尔值' })
  fullAccess?: boolean;
}
