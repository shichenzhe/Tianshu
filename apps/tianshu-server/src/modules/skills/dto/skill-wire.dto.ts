import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  SKILL_SCENARIOS,
  type RemoteSkillBrief,
  type SkillBriefExtension,
  type SkillScenario,
  type SkillStatItem,
} from '@tianshu/protocol';

/**
 * 技能概要行 wire 响应DTO（SDK 响应面批）：wire 形状 = 协议包
 * RemoteSkillBrief + SkillBriefExtension（class implements 编译期绑定）。
 * 字段以 skills.service.query 实际返回为准——scenarios/source 仅
 * skillRecord 行存在才出（可选段），builtin 恒判定（source==='builtin'）。
 */
export class SkillBriefWireDto
  implements RemoteSkillBrief, SkillBriefExtension
{
  @ApiProperty({ description: '技能名（frontmatter name）' })
  name: string;

  @ApiProperty({ description: '技能描述', nullable: true })
  description: string | null;

  @ApiProperty({ description: '启用状态（扫描态无记录视为启用）' })
  enabled: boolean;

  @ApiPropertyOptional({
    description: '场景打标（daily/coding/design；行存在才出）',
    type: [String],
    enum: SKILL_SCENARIOS,
  })
  scenarios?: SkillScenario[];

  @ApiPropertyOptional({
    description: '来源（user/local/builtin；行存在才出）',
  })
  source?: string;

  @ApiPropertyOptional({ description: '内置技能（拒卸载判定口径）' })
  builtin?: boolean;
}

/**
 * 技能统计行 wire 响应DTO：协议包 SkillStatItem 同形（class implements
 * 编译期绑定）——skillStat 事件表聚合（usedCount 全事件合计、lastUsedAt
 * 最新事件 ISO，无事件 null）。
 */
export class SkillStatWireDto implements SkillStatItem {
  @ApiProperty({ description: '技能名' })
  name: string;

  @ApiProperty({ description: '使用次数（全部埋点事件合计）' })
  usedCount: number;

  @ApiProperty({
    description: '最近使用时间（ISO；无事件 null）',
    nullable: true,
  })
  lastUsedAt: string | null;
}
