import { Controller, Post, Body, HttpStatus, HttpCode } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiExtraModels } from '@nestjs/swagger';
import { GraphRecordDto } from './dto/graph-record.dto';
import {
  ApiWrappedAccepted,
  ApiWrappedOk,
  inlineSchemas,
  queryResultSchema,
} from 'src/commons/swagger/wrapped-response';
import { Public } from 'src/commons/auth/decorator/public.decorator';
import { QueryResult } from 'src/commons/query/query-result';
import { GraphService } from './graph.service';
import type { GraphRecord } from './graph.repository';
import { GraphQueryDto } from './dto/graph-query.dto';
import { GraphSaveDto } from './dto/graph-save.dto';
import { GraphIdDto } from './dto/graph-id.dto';
import { GraphRunDto } from './dto/graph-run.dto';
import { GraphRunAbortDto } from './dto/graph-run-abort.dto';

/**
 * 编排图控制器（spec §4.1 五端点）：CRUD 薄转 GA-T3 仓储，run/runAbort
 * 接 GA-T4 executor 链。`@Public` 豁免 JWT 守卫；静态 token 守卫
 * （TIANSHU_TOKEN）仍对本路由生效。
 */
@ApiTags('编排图')
@Public()
@ApiExtraModels(GraphRecordDto)
@Controller('graph')
export class GraphController {
  constructor(private readonly graphService: GraphService) {}

  /**
   * 图定义列表（分页 + keyword）
   */
  @Post('query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '分页查询图定义列表' })
  @ApiWrappedOk(queryResultSchema(GraphRecordDto))
  async query(@Body() dto: GraphQueryDto): Promise<QueryResult<GraphRecord>> {
    return await this.graphService.query(dto);
  }

  /**
   * 保存图定义（全量 upsert：带 id 更新/version 乐观锁，否则创建）
   */
  @Post('save')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '保存图定义（全量 upsert）' })
  @ApiWrappedOk(GraphRecordDto)
  async save(@Body() dto: GraphSaveDto): Promise<GraphRecord> {
    return await this.graphService.save(dto);
  }

  /**
   * 删除图（引用检查 + run 级联）
   */
  @Post('delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除图（GRAPH_IN_USE 引用拦 + run 级联）' })
  @ApiWrappedOk()
  async delete(@Body() dto: GraphIdDto): Promise<void> {
    await this.graphService.delete(dto.id);
  }

  /**
   * 试运行：202 受理即返回 {runId}，执行流经 graph.run.updated 事件回传
   */
  @Post('run')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: '试运行图（202 受理，状态经事件流）' })
  @ApiWrappedAccepted(inlineSchemas.runId)
  async run(@Body() dto: GraphRunDto): Promise<{ runId: number }> {
    return await this.graphService.run(dto);
  }

  /**
   * 中止在途试运行（USER_CANCELLED → aborted 投影）
   */
  @Post('runAbort')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '中止在途图运行' })
  @ApiWrappedOk(inlineSchemas.aborted)
  async abort(@Body() dto: GraphRunAbortDto): Promise<{ aborted: boolean }> {
    return await this.graphService.abortRun(dto.runId);
  }
}
