import { ApiProperty } from '@nestjs/swagger';
import type { SessionRecord } from '@prisma/client';
import type { SessionLastMessage } from '@tianshu/protocol';

/**
 * 会话行 wire 响应DTO（SK-R 批）：prisma SessionRecord 序列化形态——
 * Date 字段 wire 口径 ISO 字符串（协议包头注释既定纪律；prisma 类型
 * 不能 implements，键集与序列化输出由 sdk-contract 键集断言钉死）
 */
export class SessionWireDto {
  @ApiProperty({ description: '会话标识' })
  id: number;

  @ApiProperty({ description: '工作空间标识' })
  workspaceId: number;

  @ApiProperty({
    description: '专家标识',
    type: 'number',
    nullable: true,
  })
  assistantId: number | null;

  @ApiProperty({
    description: '当前模型标识',
    type: 'number',
    nullable: true,
  })
  currentModelId: number | null;

  @ApiProperty({ description: '标题' })
  title: string;

  @ApiProperty({ description: '模式（persona 等扩展位）', nullable: true })
  mode: string | null;

  @ApiProperty({ description: '场景', nullable: true })
  scenario: string | null;

  @ApiProperty({
    description: '置顶时间（ISO；null=未置顶）',
    nullable: true,
  })
  pinnedAt: string | null;

  @ApiProperty({
    description: '归档时间（ISO；null=未归档）',
    nullable: true,
  })
  archivedAt: string | null;

  @ApiProperty({
    description: '项目标识',
    type: 'number',
    nullable: true,
  })
  projectId: number | null;

  @ApiProperty({ description: '压缩摘要', nullable: true })
  summary: string | null;

  @ApiProperty({
    description: '压缩水位消息 id',
    type: 'number',
    nullable: true,
  })
  compactedUpToId: number | null;

  @ApiProperty({ description: '创建时间（ISO）' })
  createdAt: string;

  @ApiProperty({ description: '更新时间（ISO）' })
  updatedAt: string;

  @ApiProperty({
    description: '末条消息时间（ISO；null=无消息）',
    nullable: true,
  })
  lastMessageAt: string | null;

  @ApiProperty({
    description: '用户标识（冗余列）',
    type: 'number',
    nullable: true,
  })
  userId: number | null;

  @ApiProperty({
    description: '关联计划事项 id',
    type: 'number',
    nullable: true,
  })
  planItemId: number | null;

  @ApiProperty({
    description: '已读游标（message.id；null=全新未读）',
    type: 'number',
    nullable: true,
  })
  lastReadMessageId: number | null;

  /** prisma 行 → wire（Date 字段 ISO 化；getById 详情组装消费——
   * SessionDetailDto.session 字段类型为 wire 形，运行时与此同形） */
  static of(row: SessionRecord): SessionWireDto {
    return {
      ...row,
      pinnedAt: row.pinnedAt?.toISOString() ?? null,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    } as unknown as SessionWireDto;
  }
}

/**
 * 会话列表行响应DTO（P1 批）：会话行 + 查询期动态计算的未读角标/末条
 * 摘要（非落盘字段）
 */
export class SessionSummaryWireDto extends SessionWireDto {
  @ApiProperty({ description: '未读数（查询期动态算）' })
  unreadCount: number;

  @ApiProperty({
    description: '末条消息摘要（无消息 null）',
    nullable: true,
  })
  lastMessage: SessionLastMessage | null;
}
