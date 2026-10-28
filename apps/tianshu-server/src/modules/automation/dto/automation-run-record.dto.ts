import { ApiProperty } from '@nestjs/swagger';
import type { AutomationRunPage, AutomationRunRecord } from '@tianshu/protocol';

/**
 * 运行记录响应 DTO（移动端 CRUD+运行历史批）：wire 形状 = 协议包
 * AutomationRunRecord（桌面 RunRecord 剔 graphTrace 精简面；class
 * implements 编译期绑定）；分页壳 AutomationRunPageResultDto 同文件。
 */
export class AutomationRunRecordDto implements AutomationRunRecord {
  @ApiProperty({ description: '运行标识' })
  id: number;

  @ApiProperty({
    description: '任务标识（图试运行为 null，taskName 取图名）',
    type: 'number',
    nullable: true,
  })
  taskId: number | null;

  @ApiProperty({ description: '任务名（图试运行取图名）' })
  taskName: string;

  @ApiProperty({
    description: '关联编排图（图运行；prompt 任务 run 无此字段）',
    required: false,
  })
  graphId?: number;

  @ApiProperty({ description: '会话标识', required: false })
  sessionId?: number;

  @ApiProperty({ description: '尝试序号' })
  attempt: number;

  @ApiProperty({
    description: '触发类型',
    enum: ['schedule', 'catchUp', 'retry', 'manual', 'event', 'subflow', 'webhook'],
  })
  triggerType: AutomationRunRecord['triggerType'];

  @ApiProperty({
    description: '运行状态',
    enum: ['running', 'success', 'failed', 'skipped'],
  })
  status: AutomationRunRecord['status'];

  @ApiProperty({ description: '耗时（ms）', required: false })
  durationMs?: number;

  @ApiProperty({ description: '提示词 tokens', required: false })
  promptTokens?: number;

  @ApiProperty({ description: '补全 tokens', required: false })
  completionTokens?: number;

  @ApiProperty({ description: '错误信息', required: false })
  error?: string;

  @ApiProperty({ description: '开始时间（ISO）' })
  startedAt: string;

  @ApiProperty({ description: '结束时间（ISO，运行中为 null）', required: false })
  finishedAt?: string;
}

/** runPage 分页响应壳（协议包 AutomationRunPage 同形） */
export class AutomationRunPageResultDto implements AutomationRunPage {
  @ApiProperty({ description: '总数（筛选口径）' })
  total: number;

  @ApiProperty({ type: [AutomationRunRecordDto], description: '当前页记录' })
  items: AutomationRunRecordDto[];
}
