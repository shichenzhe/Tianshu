import { ApiProperty } from '@nestjs/swagger';
import { MessageRecord } from '@prisma/client';
import { SessionWireDto } from './session-wire.dto';

/**
 * 消息摘要（getById 返回）：blocks 为天枢 blocks 协议 JSON 原样字符串，零翻译透传
 */
export class MessageBriefDto {
  @ApiProperty({ description: '消息标识' })
  id: number;

  @ApiProperty({ description: '角色：user | assistant | system' })
  role: string;

  @ApiProperty({ description: 'blocks 协议 JSON 原样字符串' })
  blocks: string;

  /** 发生时间（wire 口径 ISO 字符串——控制端消息时间戳显示） */
  @ApiProperty({ description: '创建时间 ISO' })
  createdAt: string;

  /** 生成该条 assistant 消息的模型行 id（user 行为 null——控制端模型名显示） */
  @ApiProperty({ description: '模型行 id', required: false, nullable: true })
  modelId?: number | null;

  /** 生成耗时毫秒（message 表 durationMs 列透传——round 计时落库；user 行/旧库为 null，控制端耗时显示） */
  @ApiProperty({
    description: '生成耗时毫秒',
    required: false,
    nullable: true,
  })
  durationMs?: number | null;

  constructor(partial: Partial<MessageBriefDto>) {
    Object.assign(this, partial);
  }

  static of(message: MessageRecord): MessageBriefDto {
    return new MessageBriefDto({
      id: message.id,
      role: message.role,
      blocks: message.blocks,
      // Prisma Date → wire ISO（协议 updatedAt 同口径）
      createdAt: message.createdAt.toISOString(),
      modelId: message.modelId ?? null,
      durationMs: message.durationMs ?? null,
    });
  }
}

/**
 * 会话详情DTO：会话 + 消息历史。session 字段 wire 形状经 SessionWireDto
 * 透出（SK-R 批：prisma SessionRecord 无 swagger 元数据，展开即炸；运行时
 * 对象即序列化 prisma 行，与 SessionWireDto 字段一一对应）
 */
export class SessionDetailDto {
  @ApiProperty({ description: '会话行', type: SessionWireDto })
  session: SessionWireDto;

  @ApiProperty({
    description: '消息列表（按 id 升序）',
    type: [MessageBriefDto],
  })
  messages: MessageBriefDto[];

  constructor(partial: Partial<SessionDetailDto>) {
    Object.assign(this, partial);
  }
}
