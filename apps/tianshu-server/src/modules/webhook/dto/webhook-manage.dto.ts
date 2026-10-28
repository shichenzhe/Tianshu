import { ApiProperty } from '@nestjs/swagger';
import type { WebhookManageResult } from '../webhook.service';

/**
 * webhook 管理三端点统一响应DTO（SK-R 批；WH 批 WebhookManageResult
 * 形状）：implements 编译期绑定；url 为相对路径（控制端拼主机地址）
 */
export class WebhookManageDto implements WebhookManageResult {
  @ApiProperty({ description: '是否已注册' })
  enabled: boolean;

  @ApiProperty({
    description: '触发 URL（相对路径 /webhook/<token>；未注册空串）',
  })
  url: string;

  @ApiProperty({ description: '响应模板', required: false })
  responseTemplate?: string;

  @ApiProperty({ description: '响应状态码', required: false })
  statusCode?: number;

  @ApiProperty({ description: '异步 job 模式', required: false })
  async?: boolean;

  @ApiProperty({ description: '图级完全访问', required: false })
  fullAccess?: boolean;
}
