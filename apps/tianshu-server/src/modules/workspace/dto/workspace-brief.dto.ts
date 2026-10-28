import { ApiProperty } from '@nestjs/swagger';
import type { WorkspaceBrief } from '../workspace.service';

/**
 * 工作空间概要响应DTO（SK-R 批）：implements WorkspaceBrief 编译期绑定
 * （概要四字段——HD-A1 语义，icon/审计字段不透出）
 */
export class WorkspaceBriefDto implements WorkspaceBrief {
  @ApiProperty({ description: '工作空间标识' })
  id: number;

  @ApiProperty({ description: '名称' })
  name: string;

  @ApiProperty({
    description: '绑定目录（未绑定 null）',
    nullable: true,
  })
  directoryPath: string | null;

  @ApiProperty({
    description: '默认模型标识（未设 null）',
    type: 'number',
    nullable: true,
  })
  defaultModelId: number | null;
}
