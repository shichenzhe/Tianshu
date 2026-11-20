import { ApiProperty } from '@nestjs/swagger';
import type { AutomationRunDetail, RunGroupRecord } from '@tianshu/protocol';
import { AutomationRunRecordDto } from './automation-run-record.dto';

export class AutomationRunDetailDto
  extends AutomationRunRecordDto
  implements AutomationRunDetail
{
  @ApiProperty({ description: '完整图运行轨迹 JSON', required: false })
  graphTrace?: string;
}

export class RunGroupRecordDto implements RunGroupRecord {
  @ApiProperty({ description: '分组类型', enum: ['task', 'graph'] })
  kind: RunGroupRecord['kind'];

  @ApiProperty({ description: '任务或图 id（按 kind 分命名空间）' })
  ownerId: number;

  @ApiProperty({ description: '任务或图当前名称' })
  name: string;

  @ApiProperty({ description: '工作空间 id', required: false })
  workspaceId?: number;

  @ApiProperty({
    description: '项目 id',
    type: 'number',
    nullable: true,
    required: false,
  })
  projectId?: number | null;

  @ApiProperty({
    description: '最近运行摘要（不含轨迹与图快照）',
    type: AutomationRunRecordDto,
    required: false,
  })
  latestRun?: AutomationRunRecordDto;

  @ApiProperty({ description: '是否存在可见运行' })
  hasRuns: boolean;
}
