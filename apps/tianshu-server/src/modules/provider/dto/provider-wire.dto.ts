import { ApiProperty } from '@nestjs/swagger';

/**
 * 服务商/模型行 wire 响应DTO（SK-R 批）：prisma Provider/Model 序列化
 * 形态（Date→ISO；原 ProviderBundleDto 字段直引 prisma class，swagger
 * 元数据展开爆栈——wire 化 class 替代；运行时对象即序列化 prisma 行）
 */
export class ProviderWireDto {
  @ApiProperty({ description: '服务商标识' })
  id: number;

  @ApiProperty({ description: '名称' })
  name: string;

  @ApiProperty({ description: '类型（openai-compatible 等）' })
  type: string;

  @ApiProperty({ description: '接口基址' })
  baseUrl: string;

  @ApiProperty({ description: 'API 密钥', nullable: true })
  apiKey: string | null;

  @ApiProperty({ description: '附加请求头 JSON', nullable: true })
  extraHeaders: string | null;

  @ApiProperty({ description: '启用状态' })
  enabled: boolean;

  @ApiProperty({ description: '创建时间（ISO）' })
  createdAt: string;

  @ApiProperty({ description: '更新时间（ISO）' })
  updatedAt: string;

  @ApiProperty({
    description: '用户标识（冗余列）',
    type: 'number',
    nullable: true,
  })
  userId: number | null;
}

export class ModelWireDto {
  @ApiProperty({ description: '模型行标识' })
  id: number;

  @ApiProperty({ description: '所属服务商标识' })
  providerId: number;

  @ApiProperty({ description: '上游模型 id' })
  modelId: string;

  @ApiProperty({ description: '展示名', nullable: true })
  name: string | null;

  @ApiProperty({
    description: '类型（llm | embedding | tts | reranker | asr）',
  })
  type: string;

  @ApiProperty({ description: '启用状态' })
  enabled: boolean;

  @ApiProperty({ description: '采样温度', required: false })
  temperature?: number;

  @ApiProperty({ description: 'top_p', required: false })
  topP?: number;

  @ApiProperty({ description: '最大输出 tokens', required: false })
  maxTokens?: number;

  @ApiProperty({ description: '上下文窗口', required: false })
  contextWindow?: number;

  @ApiProperty({ description: '创建时间（ISO）' })
  createdAt: string;

  @ApiProperty({ description: '更新时间（ISO）' })
  updatedAt: string;
}
