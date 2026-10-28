import { Controller, Post, Body, HttpStatus, HttpCode } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiExtraModels } from '@nestjs/swagger';
import {
  ApiWrappedAccepted,
  ApiWrappedOk,
  inlineSchemas,
  queryResultSchema,
} from 'src/commons/swagger/wrapped-response';
import { SessionRecord } from '@prisma/client';
import { Public } from 'src/commons/auth/decorator/public.decorator';
import { QueryResult } from 'src/commons/query/query-result';
import { SessionSummaryRecord } from './session.repository';
import { BusinessException } from 'src/commons/exception/bussiness-exception';
import { ErrorCodeEnum } from 'src/commons/exception/error-code.enum';
import { ChatRunnerService } from 'src/core/chat-runner.service';
import type { SessionReadResult } from '@tianshu/protocol';
import { SessionService } from './session.service';
import { SessionCreateDto } from './dto/session-create.dto';
import { SessionQueryDto } from './dto/session-query.dto';
import { SessionIdDto } from './dto/session-id.dto';
import { SessionDetailDto } from './dto/session-detail.dto';
import { SessionSummaryWireDto, SessionWireDto } from './dto/session-wire.dto';
import { SessionSendDto } from './dto/session-send.dto';
import { SessionAbortDto } from './dto/session-abort.dto';
import { SessionApproveDto } from './dto/session-approve.dto';
import { SessionUpdateDto } from './dto/session-update.dto';
import { SessionRegenerateDto } from './dto/session-regenerate.dto';
import { SessionEditResendDto } from './dto/session-edit-resend.dto';
import { SessionAccessModeDto } from './dto/session-access-mode.dto';
import { SessionReadDto } from './dto/session-read.dto';
import { SessionCompactDto } from './dto/session-compact.dto';
import { SessionPolishDto } from './dto/session-polish.dto';

/**
 * 会话控制器：天枢控制协议 CRUD + chat 执行入口。
 * `@Public` 豁免 JWT 守卫；静态 token 守卫（TIANSHU_TOKEN）仍对本路由生效。
 */
@ApiTags('会话')
@Public()
@ApiExtraModels(SessionSummaryWireDto, SessionDetailDto)
@Controller('session')
export class SessionController {
  constructor(
    private readonly sessionService: SessionService,
    private readonly chatRunner: ChatRunnerService,
  ) {}

  /**
   * 创建会话
   */
  @Post('create')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '创建会话（workspaceId 缺省挂默认空间）' })
  @ApiWrappedOk(SessionSummaryWireDto)
  async create(@Body() dto: SessionCreateDto): Promise<SessionRecord> {
    return await this.sessionService.create(dto);
  }

  /**
   * 分页查询会话（P1 未读角标批：records 带 unreadCount/lastMessage）
   */
  @Post('query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '分页查询会话列表（含未读角标/末条摘要）' })
  @ApiWrappedOk(queryResultSchema(SessionSummaryWireDto))
  async query(
    @Body() params: SessionQueryDto,
  ): Promise<QueryResult<SessionSummaryRecord>> {
    return await this.sessionService.query(params);
  }

  /**
   * 会话详情（会话 + 消息历史）
   */
  @Post('getById')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '会话详情（blocks 原样字符串）' })
  @ApiWrappedOk(SessionDetailDto)
  async getById(@Body() params: SessionIdDto): Promise<SessionDetailDto> {
    return await this.sessionService.getById(params.id);
  }

  /**
   * 发送消息：202 受理即返回，流式结果经 /event SSE 事件回传
   * （message.chunk → session.updated / session.error）
   */
  @Post('send')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: '发送消息（202 受理，流经事件通道）' })
  @ApiWrappedAccepted(inlineSchemas.accepted)
  async send(@Body() dto: SessionSendDto): Promise<{ accepted: true }> {
    return await this.sessionService.send(dto);
  }

  /**
   * 中止会话进行中的流
   */
  @Post('abort')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '中止会话进行中的流' })
  @ApiWrappedOk(inlineSchemas.aborted)
  async abort(@Body() params: SessionAbortDto): Promise<{ aborted: boolean }> {
    return { aborted: await this.sessionService.abort(params.sessionId) };
  }

  /**
   * 审批应答（manual 模式挂起流的远程决议；remember 记忆写表与归属
   * 校验收口在 service——审批记忆批）
   */
  @Post('approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '审批应答（可选记住工具）' })
  @ApiWrappedOk(inlineSchemas.responded)
  async approve(
    @Body() dto: SessionApproveDto,
  ): Promise<{ responded: boolean; remembered: boolean }> {
    return this.sessionService.approve(dto);
  }

  /**
   * 删除会话（级联清理消息）
   */
  @Post('delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除会话' })
  @ApiWrappedOk()
  async delete(@Body() params: SessionIdDto): Promise<void> {
    await this.sessionService.delete(params.id);
  }

  /**
   * 会话更新（重命名 + 模式切换 agent|ask|plan）
   */
  @Post('update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '更新会话（重命名/模式切换）' })
  @ApiWrappedOk()
  async update(@Body() params: SessionUpdateDto): Promise<void> {
    await this.sessionService.update(params.sessionId, {
      ...(params.title !== undefined ? { title: params.title } : {}),
      ...(params.mode !== undefined ? { mode: params.mode } : {}),
      ...(params.archived !== undefined ? { archived: params.archived } : {}),
      ...(params.pinned !== undefined ? { pinned: params.pinned } : {}),
      ...(params.assistantId !== undefined
        ? { assistantId: params.assistantId }
        : {}),
      ...(params.currentModelId !== undefined
        ? { currentModelId: params.currentModelId }
        : {}),
    });
  }

  /**
   * 编辑重发（改写 user 消息并删除其后重跑；202 受理即返回）
   */
  @Post('editAndResend')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: '编辑重发' })
  @ApiWrappedAccepted(inlineSchemas.accepted)
  async editAndResend(
    @Body() params: SessionEditResendDto,
  ): Promise<{ accepted: true }> {
    return await this.sessionService.editAndResend(params);
  }

  /**
   * 上下文用量拆解（五类 token 估算；未配模型为 null）
   */
  @Post('usage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '上下文用量拆解' })
  @ApiWrappedOk(inlineSchemas.sessionUsage)
  async usage(@Body() params: SessionAccessModeDto): Promise<unknown> {
    return await this.sessionService.usage(params.sessionId);
  }

  /**
   * 会话权限模式（get/set 合一：mode 缺省查询）
   */
  @Post('accessMode')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '会话权限模式（查/设）' })
  @ApiWrappedOk(inlineSchemas.accessMode)
  async accessMode(
    @Body() params: SessionAccessModeDto,
  ): Promise<{ mode: 'default' | 'full' }> {
    return await this.sessionService.accessMode(params.sessionId, params.mode);
  }

  /**
   * 重新生成（messageId 缺省=最后一条 assistant；202 受理即返回）
   */
  @Post('regenerate')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: '重新生成回复' })
  @ApiWrappedAccepted(inlineSchemas.accepted)
  async regenerate(
    @Body() params: SessionRegenerateDto,
  ): Promise<{ accepted: true }> {
    return await this.sessionService.regenerate(params);
  }

  /**
   * P1 未读角标批：已读上报——游标单调推进不回退，响应按生效游标现算
   * 未读数；成功后 enriched session.updated 事件清远端角标
   */
  @Post('read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '已读上报（未读游标单调推进）' })
  @ApiWrappedOk(inlineSchemas.sessionRead)
  async read(@Body() dto: SessionReadDto): Promise<SessionReadResult> {
    return await this.sessionService.markSessionRead(dto);
  }

  /**
   * 会话压缩（A9 批）：202 受理即返回，后台执行清态→摘要轮→回填
   * summary/compactedUpToId（中止不回填），完成后 session.updated 事件
   * 刷新（控制端重拉 getById）
   */
  @Post('compact')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: '会话压缩（202 受理，完成后 session.updated 事件）',
  })
  @ApiWrappedAccepted(inlineSchemas.accepted)
  async compact(@Body() dto: SessionCompactDto): Promise<{ accepted: true }> {
    return await this.sessionService.compact(dto);
  }

  /**
   * 落地页润色（A9 批）：一次性非流式补全同步返回；30s 超时走 5000 业务错
   */
  @Post('polish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '文本润色（同步 30s 超时）' })
  @ApiWrappedOk(inlineSchemas.polishText)
  async polish(@Body() dto: SessionPolishDto): Promise<{ text: string }> {
    return await this.sessionService.polish(dto);
  }
}
