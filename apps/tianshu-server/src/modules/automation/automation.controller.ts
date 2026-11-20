import { Controller, Post, Body, HttpStatus, HttpCode } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiExtraModels, getSchemaPath } from '@nestjs/swagger';
import type {
  AutomationRunDetail,
  AutomationRunNodeRecord,
  AutomationRunPage,
  RunGroupRecord,
} from '@tianshu/protocol';
import { TaskRecordDto } from './dto/task-record.dto';
import {
  AutomationRunPageResultDto,
  AutomationRunRecordDto,
} from './dto/automation-run-record.dto';
import { AutomationRunNodeDto } from './dto/automation-run-node.dto';
import {
  ApiWrappedAccepted,
  ApiWrappedOk,
  inlineSchemas,
  queryResultSchema,
} from 'src/commons/swagger/wrapped-response';
import { Public } from 'src/commons/auth/decorator/public.decorator';
import { QueryResult } from 'src/commons/query/query-result';
import { AutomationService } from './automation.service';
import type { TaskRecord } from './automation.repository';
import { AutomationQueryDto } from './dto/automation-query.dto';
import { AutomationSaveDto } from './dto/automation-save.dto';
import { AutomationDeleteDto } from './dto/automation-delete.dto';
import { TaskIdDto } from './dto/task-id.dto';
import { RunIdDto } from './dto/run-id.dto';
import { AutomationRunQueryDto } from './dto/automation-run-query.dto';
import { AutomationStatsQueryDto } from './dto/automation-stats-query.dto';
import {
  AutomationRunDetailDto,
  RunGroupRecordDto,
} from './dto/run-session.dto';

/**
 * 自动化任务控制器（spec §4.1 四端点 + CRUD 批 runPage + 执行详情批
 * runNodes）。`@Public` 豁免 JWT 守卫；静态 token 守卫（TIANSHU_TOKEN）仍生效。
 */
@ApiTags('自动化')
@Public()
@ApiExtraModels(
  TaskRecordDto,
  AutomationRunRecordDto,
  AutomationRunPageResultDto,
  AutomationRunNodeDto,
  AutomationRunDetailDto,
  RunGroupRecordDto,
)
@Controller('automation')
export class AutomationController {
  constructor(private readonly automationService: AutomationService) {}

  /**
   * 任务列表（分页 + keyword）
   */
  @Post('query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '分页查询自动化任务列表' })
  @ApiWrappedOk(queryResultSchema(TaskRecordDto))
  async query(
    @Body() dto: AutomationQueryDto,
  ): Promise<QueryResult<TaskRecord>> {
    return await this.automationService.query(dto);
  }

  /**
   * 保存任务（全量 upsert：带 id 更新，否则创建）
   */
  @Post('save')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '保存自动化任务（全量 upsert）' })
  @ApiWrappedOk(TaskRecordDto)
  async save(@Body() dto: AutomationSaveDto): Promise<TaskRecord> {
    return await this.automationService.save(dto);
  }

  /**
   * 批量删除任务（run 级联）
   */
  @Post('delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '批量删除自动化任务（run 级联）' })
  @ApiWrappedOk()
  async delete(@Body() dto: AutomationDeleteDto): Promise<void> {
    await this.automationService.delete(dto.ids);
  }

  /**
   * 手动触发：202 受理即返回（不消耗调度字段；收尾经 automation.changed）
   */
  @Post('runNow')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: '手动触发任务（202 受理，不消耗调度字段）' })
  @ApiWrappedAccepted(inlineSchemas.accepted)
  async runNow(@Body() dto: TaskIdDto): Promise<{ accepted: true }> {
    return await this.automationService.runNow(dto.taskId);
  }

  /**
   * 运行历史分页（taskId 任务口径 / 全量含本人图试运行；status 下推；
   * 载荷剔 graphTrace——移动端 CRUD+运行历史批）
   */
  @Post('runPage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '分页查询运行历史（载荷剔 graphTrace）' })
  @ApiWrappedOk(AutomationRunPageResultDto)
  async runPage(
    @Body() dto: AutomationRunQueryDto,
  ): Promise<AutomationRunPage> {
    return await this.automationService.runPage(dto);
  }

  @Post('runGroups')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '查询固定运行分组（latestRun 不含轨迹/快照）' })
  @ApiWrappedOk({
    type: 'array',
    items: { $ref: getSchemaPath(RunGroupRecordDto) },
  })
  async runGroups(): Promise<RunGroupRecord[]> {
    return await this.automationService.runGroups();
  }

  @Post('runById')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '按 id 查询本人运行详情（保留 graphTrace）' })
  @ApiWrappedOk(AutomationRunDetailDto)
  async runById(@Body() dto: RunIdDto): Promise<AutomationRunDetail> {
    return await this.automationService.runById(dto);
  }

  /**
   * 运行节点级执行详情（移动端执行详情批）：图 run 专有——归属两段校验
   * 不符/prompt run/老 run 无节点行一律空集；行透传（input/output 全文）
   */
  @Post('runNodes')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '运行节点级执行详情（图 run，空集语义不暴露存在性）',
  })
  @ApiWrappedOk({
    type: 'array',
    items: { $ref: getSchemaPath(AutomationRunNodeDto) },
  })
  async runNodes(@Body() dto: RunIdDto): Promise<AutomationRunNodeRecord[]> {
    return await this.automationService.runNodes(dto.runId);
  }

  /**
   * 健康度总览原始行集（automation/library 路由化批 2026-11-10）：since
   * 起的精简 run 行 + error 任务行——时区敏感的日键聚合在客户端
   * computeStats（@tianshu/core 单源）完成，端点不做时区假设
   */
  @Post('stats')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '健康度总览原始行集（客户端聚合）' })
  @ApiWrappedOk({
    type: 'object',
    properties: {
      runs: {
        type: 'array',
        items: { $ref: getSchemaPath(AutomationRunRecordDto) },
      },
      errorTasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            name: { type: 'string' },
            statusNote: { type: 'string', nullable: true },
          },
          required: ['id', 'name'],
        },
      },
    },
    required: ['runs', 'errorTasks'],
  })
  async stats(@Body() dto: AutomationStatsQueryDto) {
    return await this.automationService.statsRaw(dto);
  }
}
