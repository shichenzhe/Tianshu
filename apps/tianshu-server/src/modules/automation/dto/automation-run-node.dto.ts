import { ApiProperty } from '@nestjs/swagger';
import type { AutomationRunNodeRecord } from '@tianshu/protocol';

/**
 * 运行节点详情响应 DTO（移动端执行详情批）：wire 形状 = 协议包
 * AutomationRunNodeRecord（graphRunNode 表逐字段透传，mirror 桌面
 * GraphRunNodeRow 同构；class implements 编译期绑定）。响应为裸数组，
 * 经 controller 内联 array schema（items $ref 本 DTO）。
 */
export class AutomationRunNodeDto implements AutomationRunNodeRecord {
  @ApiProperty({ description: '节点行标识' })
  id: number;

  @ApiProperty({ description: '所属运行标识' })
  runId: number;

  @ApiProperty({ description: '节点 id（环图重入末轮为准）' })
  nodeId: string;

  @ApiProperty({ description: '节点名', type: 'string', nullable: true })
  nodeName: string | null;

  @ApiProperty({ description: '节点状态', enum: ['success', 'failed'] })
  status: string;

  @ApiProperty({ description: '渲染后完整输入（截 64KB）', type: 'string', nullable: true })
  input: string | null;

  @ApiProperty({
    description: '完整输出（截 64KB；failed 行为失败全貌文本）',
    type: 'string',
    nullable: true,
  })
  output: string | null;

  @ApiProperty({
    description: '失败结构化 JSON 序列：{ code, message, detail }',
    type: 'string',
    nullable: true,
  })
  errorJson: string | null;

  @ApiProperty({
    description: '工具调用摘要数组 JSON 序列：[{ name, ok, durationMs }]',
    type: 'string',
    nullable: true,
  })
  toolCallsJson: string | null;

  @ApiProperty({ description: '提示词 tokens', type: 'number', nullable: true })
  promptTokens: number | null;

  @ApiProperty({ description: '补全 tokens', type: 'number', nullable: true })
  completionTokens: number | null;

  @ApiProperty({ description: '耗时（ms）' })
  durationMs: number;

  @ApiProperty({ description: '开始时间（ISO）' })
  startedAt: string;

  @ApiProperty({
    description: 'imageGen 产物相对数据根路径（移动端无文件通道暂不消费）',
    type: 'string',
    nullable: true,
  })
  outputImage: string | null;

  @ApiProperty({
    description: '循环节点死信（onItemError=continue）',
    type: 'string',
    nullable: true,
  })
  errorOutput: string | null;

  @ApiProperty({
    description: '降级继续标记 JSON 序列：{ code, message }',
    type: 'string',
    nullable: true,
  })
  fallbackJson: string | null;
}
