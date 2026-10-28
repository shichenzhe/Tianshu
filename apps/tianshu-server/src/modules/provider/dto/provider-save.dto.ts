import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * 服务商配置项（save upsert 语义：带 id 更新，不带 id 新建）
 */
export class ProviderItemDto {
  @ApiProperty({ description: '服务商标识；缺省新建', required: false })
  @IsOptional()
  @IsInt({ message: '服务商标识必须是整数' })
  id?: number;

  @ApiProperty({ description: '服务商名称' })
  @IsNotEmpty({ message: '服务商名称不能为空' })
  @IsString({ message: '服务商名称必须是字符串' })
  name: string;

  @ApiProperty({ description: '服务商类型（openai-compatible/ollama 等）' })
  @IsNotEmpty({ message: '服务商类型不能为空' })
  @IsString({ message: '服务商类型必须是字符串' })
  type: string;

  @ApiProperty({ description: '基础地址' })
  @IsNotEmpty({ message: '基础地址不能为空' })
  @IsString({ message: '基础地址必须是字符串' })
  baseUrl: string;

  @ApiProperty({
    description: 'API 密钥（未配置为 null）',
    required: false,
    type: String,
    nullable: true,
  })
  @IsOptional()
  @IsString({ message: 'API密钥必须是字符串' })
  apiKey?: string | null;

  @ApiProperty({
    description: '额外请求头 JSON 字符串（形如 {"X-Key":"v"}；未配置为 null）',
    required: false,
    type: String,
    nullable: true,
  })
  @IsOptional()
  @IsString({ message: '额外请求头必须是JSON字符串' })
  extraHeaders?: string | null;

  @ApiProperty({ description: '是否启用；新建缺省 true', required: false })
  @IsOptional()
  @IsBoolean({ message: '启用状态必须是布尔值' })
  enabled?: boolean;
}

/**
 * 模型配置项（save upsert 语义同上；经所属 provider 校验归属）
 */
export class ModelItemDto {
  @ApiProperty({
    description: '模型标识（库内行标识）；缺省新建',
    required: false,
  })
  @IsOptional()
  @IsInt({ message: '模型行标识必须是整数' })
  id?: number;

  @ApiProperty({ description: '所属服务商' })
  @IsNotEmpty({ message: '所属服务商不能为空' })
  @IsInt({ message: '所属服务商必须是整数' })
  providerId: number;

  @ApiProperty({ description: '模型标识（上游模型名）' })
  @IsNotEmpty({ message: '模型标识不能为空' })
  @IsString({ message: '模型标识必须是字符串' })
  @MaxLength(255, { message: '模型标识长度不能超过255位' })
  modelId: string;

  @ApiProperty({
    description: '展示名',
    required: false,
    type: String,
    nullable: true,
  })
  @IsOptional()
  @IsString({ message: '展示名必须是字符串' })
  name?: string | null;

  @ApiProperty({
    description: '类型 llm|embedding|tts|reranker|asr；缺省 llm',
    required: false,
  })
  @IsOptional()
  @IsString({ message: '模型类型必须是字符串' })
  type?: string;

  @ApiProperty({ description: '是否启用', required: false })
  @IsOptional()
  @IsBoolean({ message: '启用状态必须是布尔值' })
  enabled?: boolean;

  @ApiProperty({
    description: '温度参数',
    required: false,
    type: Number,
    nullable: true,
  })
  @IsOptional()
  @IsNumber({}, { message: '温度参数必须是数字' })
  temperature?: number | null;

  @ApiProperty({
    description: 'topP 参数',
    required: false,
    type: Number,
    nullable: true,
  })
  @IsOptional()
  @IsNumber({}, { message: 'topP参数必须是数字' })
  topP?: number | null;

  @ApiProperty({
    description: '最大 token 数（整数）',
    required: false,
    type: Number,
    nullable: true,
  })
  @IsOptional()
  @IsInt({ message: '最大token数必须是整数' })
  maxTokens?: number | null;

  @ApiProperty({
    description: '上下文窗口（整数）',
    required: false,
    type: Number,
    nullable: true,
  })
  @IsOptional()
  @IsInt({ message: '上下文窗口必须是整数' })
  contextWindow?: number | null;
}

/**
 * 模型配置查存DTO（一期 upsert 数组语义：不带删除，控制者裁定）
 */
export class ProviderSaveDto {
  @ApiProperty({
    description: '服务商配置数组（可缺省）',
    required: false,
    type: [ProviderItemDto],
  })
  @IsOptional()
  @IsArray({ message: '服务商配置必须是数组' })
  @ValidateNested({ each: true })
  @Type(() => ProviderItemDto)
  providers?: ProviderItemDto[];

  @ApiProperty({
    description: '模型配置数组（可缺省）',
    required: false,
    type: [ModelItemDto],
  })
  @IsOptional()
  @IsArray({ message: '模型配置必须是数组' })
  @ValidateNested({ each: true })
  @Type(() => ModelItemDto)
  models?: ModelItemDto[];
}
