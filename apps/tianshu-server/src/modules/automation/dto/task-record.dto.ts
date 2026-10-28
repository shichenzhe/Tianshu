import { ApiProperty } from '@nestjs/swagger';
import type { TaskRecord } from '@tianshu/protocol';

/**
 * 自动化任务记录响应DTO（SK-R 批）：wire 形状 = 协议包 TaskRecord
 * （class implements 编译期绑定）；枚举字面量以 enum 数组透出
 */
export class TaskRecordDto implements TaskRecord {
  @ApiProperty({ description: '任务标识' })
  id: number;

  @ApiProperty({ description: '任务名' })
  name: string;

  @ApiProperty({ description: '提示词（graph 任务为空串）' })
  prompt: string;

  @ApiProperty({ description: '工作空间标识' })
  workspaceId: number;

  @ApiProperty({ description: '工作空间名（冗余展示）' })
  workspaceName: string;

  @ApiProperty({ description: '来源', enum: ['local', 'project'] })
  source: TaskRecord['source'];

  @ApiProperty({ description: '模型标识（graph 任务 0 占位）' })
  modelId: number;

  @ApiProperty({ description: '采样温度', required: false })
  temperature?: number;

  @ApiProperty({
    description: '执行体类型',
    enum: ['prompt', 'graph'],
  })
  targetKind: TaskRecord['targetKind'];

  @ApiProperty({
    description: '目标图标识（graph 任务；prompt 任务 null）',
    type: 'number',
    nullable: true,
  })
  graphId: number | null;

  @ApiProperty({
    description: '事件触发配置 JSON（null=未配置）',
    nullable: true,
  })
  eventJson: string | null;

  @ApiProperty({ description: '调度配置 JSON' })
  scheduleJson: string;

  @ApiProperty({ description: '调度文案（人读）' })
  scheduleText: string;

  @ApiProperty({ description: '开始时间（ISO，可选）', required: false })
  startAt?: string;

  @ApiProperty({ description: '结束时间（ISO，可选）', required: false })
  endAt?: string;

  @ApiProperty({ description: '错过后策略', enum: ['skip', 'catchUpOnce'] })
  missedPolicy: TaskRecord['missedPolicy'];

  @ApiProperty({ description: '访问模式', enum: ['default', 'full'] })
  accessMode: TaskRecord['accessMode'];

  @ApiProperty({ description: '启用状态' })
  enabled: boolean;

  @ApiProperty({
    description: '运行状态',
    enum: ['active', 'error', 'expired'],
  })
  status: TaskRecord['status'];

  @ApiProperty({ description: '状态备注', required: false })
  statusNote?: string;

  @ApiProperty({ description: '上次运行（ISO，可选）', required: false })
  lastRunAt?: string;

  @ApiProperty({ description: '下次运行（ISO，可选）', required: false })
  nextRunAt?: string;

  @ApiProperty({ description: '创建模板 slug', required: false })
  templateSlug?: string;

  @ApiProperty({
    description: '所属项目（null=全局任务）',
    type: 'number',
    nullable: true,
  })
  projectId: number | null;

  @ApiProperty({ description: '创建时间（ISO）' })
  createdAt: string;

  @ApiProperty({ description: '更新时间（ISO）' })
  updatedAt: string;
}
