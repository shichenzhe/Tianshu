import {
  Body,
  Controller,
  Get,
  HttpStatus,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiWrappedOk } from 'src/commons/swagger/wrapped-response';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from 'src/commons/auth/decorator/public.decorator';
import { WebhookService } from './webhook.service';
import type {
  WebhookHttpOutcome,
  WebhookManageResult,
} from './webhook.service';
import { WebhookEnableDto } from './dto/webhook-enable.dto';
import { WebhookIdDto } from './dto/webhook-id.dto';
import { WebhookManageDto } from './dto/webhook-manage.dto';

/**
 * webhook 控制器（GA-T7）：POST /webhook/:token（同步挂起/异步 202）+
 * GET /webhook/:token/jobs/:id（异步轮询）。mirror webhook-server 的
 * http.createServer 路由分发收敛为 Nest 路由（语义对照逐条见
 * webhook.service.ts 头注释）。
 * - `@Public` 豁免 JWT 守卫；静态 token 守卫（TIANSHU_TOKEN）仍生效
 *   （graph/event 同款）
 * - 响应经 `@Res()` 直发真实状态码与原样体（自定义模板原样文本不再
 *   stringify、默认 {status,output} JSON、404/500 错误体）——注入 @Res()
 *   后 Nest 不再代发，统一包装拦截器对本路由天然失效（无需
 *   response.excludePaths 豁免）
 *
 * 管理三端点（WH 批 2026-10-27）：graph/webhook/{enable,disable,status}。
 * 路径带 graph/ 前缀是安全裁定——静态 token 守卫豁免 `/webhook/` 前缀
 * （触发面外部系统语义），管理面含 fullAccess 全权开关，落该前缀即匿名
 * 可达；graph/webhook/* 受守卫保护且语义挂图域（协议 ENDPOINTS.webhook
 * 管理段同值）。管理面走统一包装拦截器（{code,message,data}，graph
 * controller 同款），与触发面直发互不干扰。
 */
@ApiTags('Webhook')
@Public()
@ApiExtraModels(WebhookManageDto)
@Controller()
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  /** 触发图：同步（模板渲染+配置状态码，挂起至完成）/异步（202+jobId） */
  @Post('/webhook/:token')
  @ApiOperation({ summary: '触发 webhook 图（同步挂起/异步 202）' })
  async trigger(
    @Param('token') token: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // statusUrl 基址取请求自身（origin+路径，含部署前缀；去掉 query）
    const base = `${request.protocol}://${request.headers.host ?? ''}${request.url.split('?')[0]}`;
    sendOutcome(reply, await this.webhookService.trigger(token, body, base));
  }

  /** 异步 job 状态轮询（内存结果 → run 表回落） */
  @Get('/webhook/:token/jobs/:id')
  @ApiOperation({ summary: '轮询异步 webhook job' })
  async job(
    @Param('token') token: string,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    sendOutcome(reply, await this.webhookService.getJob(token, id));
  }

  /** 开启（重开换 token 旧失效）；返回相对 URL，控制端拼主机地址 */
  @Post('graph/webhook/enable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '开启图 webhook（重开换 token）' })
  @ApiWrappedOk(WebhookManageDto)
  async enable(@Body() dto: WebhookEnableDto): Promise<WebhookManageResult> {
    return await this.webhookService.enableWebhook(dto.graphId, {
      responseTemplate: dto.responseTemplate,
      statusCode: dto.statusCode,
      async: dto.async,
      fullAccess: dto.fullAccess,
    });
  }

  /** 关闭（幂等；该图在途 webhook 运行一并中止） */
  @Post('graph/webhook/disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '关闭图 webhook（幂等）' })
  @ApiWrappedOk(WebhookManageDto)
  async disable(@Body() dto: WebhookIdDto): Promise<WebhookManageResult> {
    return await this.webhookService.disableWebhook(dto.graphId);
  }

  /** 查询回显（enabled + url + 四配置；未注册 {enabled:false,url:""}） */
  @Post('graph/webhook/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '查询图 webhook 注册状态' })
  @ApiWrappedOk(WebhookManageDto)
  async status(@Body() dto: WebhookIdDto): Promise<WebhookManageResult> {
    return await this.webhookService.getWebhookStatus(dto.graphId);
  }
}

/** 原样发送（mirror sendJson 语义）：对象体 JSON 化自动 Content-Type；
 * string 体为模板渲染原样文本——Content-Type 显式 application/json
 * （模板自身可为 JSON 串，不再 stringify） */
function sendOutcome(reply: FastifyReply, outcome: WebhookHttpOutcome): void {
  if (typeof outcome.body === 'string') {
    reply.header('Content-Type', 'application/json');
  }
  reply.status(outcome.status).send(outcome.body);
}
