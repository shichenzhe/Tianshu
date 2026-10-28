import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, type ApiPropertyOptions } from '@nestjs/swagger';
import type { ScheduleConfig } from '@tianshu/core';

/**
 * ScheduleConfig 判别联合的 OpenAPI 手工镜像（SK 终审 F2）：wire 形态为
 * 必填对象（repo buildTaskData 保存期 zod 深校验后 JSON.stringify 落库；
 * 终审原文疑为 JSON 字符串/可选，经运行时证据改判必填对象）。zod runtime
 * schema 无法直出 Swagger 管线，手工镜像的漂移由 test/sdk-contract.spec.ts
 * 类型层 witness（ScheduleConfig ↔ 生成形双向可赋值）封死。
 * 星期约定 ISO：1=周一 … 7=周日（@tianshu/core schedule-schema 同款）。
 */
const scheduleConfigSchema: ApiPropertyOptions = {
  description: '调度配置（ScheduleConfig 判别联合对象；保存期 zod 深校验）',
  oneOf: [
    {
      type: 'object',
      required: ['mode', 'kind', 'runAt'],
      properties: {
        mode: { type: 'string', enum: ['periodic'] },
        kind: { type: 'string', enum: ['once'] },
        runAt: { type: 'string', description: 'ISO 时间戳（含时区偏移）' },
      },
    },
    {
      type: 'object',
      required: ['mode', 'kind', 'time'],
      properties: {
        mode: { type: 'string', enum: ['periodic'] },
        kind: { type: 'string', enum: ['daily'] },
        time: { type: 'string', description: 'HH:mm' },
      },
    },
    {
      type: 'object',
      required: ['mode', 'kind', 'weekdays', 'time'],
      properties: {
        mode: { type: 'string', enum: ['periodic'] },
        kind: { type: 'string', enum: ['weekly'] },
        weekdays: { type: 'array', items: { type: 'number' } },
        time: { type: 'string', description: 'HH:mm' },
      },
    },
    {
      type: 'object',
      required: ['mode', 'kind', 'anchorDate', 'weekday', 'time'],
      properties: {
        mode: { type: 'string', enum: ['periodic'] },
        kind: { type: 'string', enum: ['biweekly'] },
        anchorDate: { type: 'string', description: 'YYYY-MM-DD' },
        weekday: { type: 'number' },
        time: { type: 'string', description: 'HH:mm' },
      },
    },
    {
      type: 'object',
      required: ['mode', 'kind', 'dayOfMonth', 'time'],
      properties: {
        mode: { type: 'string', enum: ['periodic'] },
        kind: { type: 'string', enum: ['monthly'] },
        dayOfMonth: { type: 'number' },
        time: { type: 'string', description: 'HH:mm' },
      },
    },
    {
      type: 'object',
      required: ['mode', 'kind', 'month', 'day', 'time'],
      properties: {
        mode: { type: 'string', enum: ['periodic'] },
        kind: { type: 'string', enum: ['yearly'] },
        month: { type: 'number' },
        day: { type: 'number' },
        time: { type: 'string', description: 'HH:mm' },
      },
    },
    {
      type: 'object',
      required: ['mode', 'value', 'unit'],
      properties: {
        mode: { type: 'string', enum: ['interval'] },
        value: { type: 'number', description: '正整数（间隔下限 5 分钟）' },
        unit: { type: 'string', enum: ['minute', 'hour'] },
        weekdays: { type: 'array', items: { type: 'number' } },
      },
    },
  ],
};

/**
 * 自动化任务保存DTO（spec §4.1 全量 upsert，字段面 = 仓储 TaskCreateParams
 * + id；graph 任务模型在各节点，modelId=0/prompt 空串占位——mirror 同款）。
 * schedule 深校验由仓储 buildTaskData 的 zod schema 承担（保存期即拒）。
 */
export class AutomationSaveDto {
  @ApiProperty({ description: '任务标识；携带即更新语义', required: false })
  @IsOptional()
  @IsInt({ message: '任务标识必须是整数' })
  id?: number;

  @ApiProperty({ description: '任务名' })
  @IsString({ message: '任务名必须是字符串' })
  @MaxLength(255, { message: '任务名长度不能超过255位' })
  name: string;

  @ApiProperty({ description: '提示词（graph 任务空串占位）' })
  @IsString({ message: '提示词必须是字符串' })
  prompt: string;

  @ApiProperty({ description: '工作空间标识' })
  @IsInt({ message: '工作空间标识必须是整数' })
  workspaceId: number;

  @ApiProperty({ description: '模型标识（graph 任务 0 占位）' })
  @IsInt({ message: '模型标识必须是整数' })
  modelId: number;

  @ApiProperty({ description: '温度', required: false })
  @IsOptional()
  @IsNumber({}, { message: '温度必须是数字' })
  temperature?: number;

  @ApiProperty({
    description: '执行体：prompt | graph（缺省 prompt）',
    required: false,
  })
  @IsOptional()
  @IsIn(['prompt', 'graph'], { message: '执行体必须是 prompt 或 graph' })
  targetKind?: 'prompt' | 'graph';

  @ApiProperty({
    description: 'targetKind=graph 时指向编排图',
    required: false,
  })
  @IsOptional()
  @IsInt({ message: '图标识必须是整数' })
  graphId?: number;

  @ApiProperty({ description: '事件触发配置 JSON 序列', required: false })
  @IsOptional()
  @IsString({ message: '事件触发配置必须是 JSON 字符串' })
  eventJson?: string;

  @ApiProperty(scheduleConfigSchema)
  @IsObject({ message: '调度配置必须是对象' })
  schedule: ScheduleConfig;

  @ApiProperty({ description: '调度文案' })
  @IsString({ message: '调度文案必须是字符串' })
  @MaxLength(255, { message: '调度文案长度不能超过255位' })
  scheduleText: string;

  @ApiProperty({ description: '生效时间（ISO 字符串）', required: false })
  @IsOptional()
  @IsString({ message: '生效时间必须是 ISO 字符串' })
  startAt?: string;

  @ApiProperty({ description: '失效时间（ISO 字符串）', required: false })
  @IsOptional()
  @IsString({ message: '失效时间必须是 ISO 字符串' })
  endAt?: string;

  @ApiProperty({ description: '错过策略：skip | catchUpOnce' })
  @IsIn(['skip', 'catchUpOnce'], {
    message: '错过策略必须是 skip 或 catchUpOnce',
  })
  missedPolicy: 'skip' | 'catchUpOnce';

  @ApiProperty({
    description: '无人值守权限：default | full（缺省 default）',
    required: false,
  })
  @IsOptional()
  @IsIn(['default', 'full'], { message: '权限模式必须是 default 或 full' })
  accessMode?: 'default' | 'full';

  @ApiProperty({ description: '模板标识', required: false })
  @IsOptional()
  @IsString({ message: '模板标识必须是字符串' })
  templateSlug?: string;

  @ApiProperty({ description: '所属项目 id；null=全局任务', required: false })
  @IsOptional()
  @IsInt({ message: '项目标识必须是整数' })
  projectId?: number | null;

  @ApiProperty({
    description:
      '任务开关：显式携带才写入（控制端启停走 save 全量、无 toggle 端点——' +
      'Ruling 12/14）；缺省不碰开关（编辑已暂停任务不重置用户开关）',
    required: false,
  })
  @IsOptional()
  @IsBoolean({ message: '任务开关必须是布尔值' })
  enabled?: boolean;
}
