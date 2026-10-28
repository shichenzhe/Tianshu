import { Controller, Get, Logger, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from 'src/commons/auth/decorator/public.decorator';
import { EventBusService } from 'src/commons/event-bus/event-bus.service';
import { CAPABILITIES, type ServerEvent } from '@tianshu/protocol';
import { instanceId } from 'src/modules/info/info.controller';

/** SSE 心跳间隔：注释行防中间层（代理/网关）空闲超时断连 */
const HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * SSE 帧编码：`event: <type>\ndata: <json>\n\n`（协议 §3.2）。
 * payload 经 JSON.stringify——updatedAt 等日期已在 publish 边界归一为
 * ISO 字符串（协议包 ServerEvent 口径），此处原样透传（与 REST 出参的
 * sv-SE 日期约定不同，客户端按 ISO 解析）。
 */
export function encodeSseFrame(event: ServerEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}

/**
 * 协议事件流控制器：GET /event（SSE 承载）。
 *
 * - 鉴权：`@Public` 豁免 JWT 守卫；静态 token 守卫仍生效——EventSource 无法
 *   带自定义 header，支持 `?token=` query 等效（T2 已实现）
 * - 首帧 `server.connected {instanceId, capabilities}`（与 /info 同源），
 *   之后逐事件转发 EventBus；断连（onClose）退订 + 停心跳
 * - Fastify 语义：reply.hijack() 接管响应后经 reply.raw 直写流，
 *   Nest/fastify 不再代发（response.excludePaths 已豁免统一包装）
 */
@ApiTags('事件')
@Public()
@Controller()
export class EventController {
  private readonly logger = new Logger(EventController.name);

  constructor(private readonly bus: EventBusService) {}

  @Get('/event')
  @ApiOperation({ summary: 'SSE 协议事件流（首帧 server.connected）' })
  stream(@Res() reply: FastifyReply): void {
    reply.hijack();
    const raw = reply.raw;
    // 响应头经 setHeader 预置而非 writeHead 内联：压缩中间件（compression，
    // main.ts 默认装配）在 on-headers 钩子里经 getHeader 查 Cache-Control，
    // 内联参数此刻尚未落表查不到。no-transform 是 SSE 豁免压缩的标准信号
    // ——否则 gzip 缓冲小帧不刷出，客户端永远收不到首帧（T19 E2E 直连
    // 链路实测：无此豁免时 /event 返回 content-encoding: gzip 且 15s 无字节）
    raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    raw.setHeader('Cache-Control', 'no-cache, no-transform');
    raw.setHeader('Connection', 'keep-alive');
    // 禁 nginx 等反代的响应缓冲（SSE 逐帧直达）
    raw.setHeader('X-Accel-Buffering', 'no');
    raw.writeHead(200);

    let closed = false;
    let unsubscribe: () => void = () => undefined;
    /** 目标连接是否仍可写（断连后 write 会触发 error/静默丢弃，先自查防误写） */
    const writable = () => !closed && !raw.destroyed && !raw.writableEnded;
    const heartbeat = setInterval(() => {
      try {
        if (writable()) raw.write(': ping\n\n');
      } catch {
        cleanup();
      }
    }, HEARTBEAT_INTERVAL_MS);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };

    // T2 F1：转发回调自包裹 try/catch——EventEmitter 同步扇出，订阅者异常
    // 会打断 publish 方（send 链路），连接级故障只殃及本连接
    unsubscribe = this.bus.subscribe((event) => {
      try {
        if (writable()) raw.write(encodeSseFrame(event));
      } catch (e) {
        this.logger.warn(
          `SSE 帧转发失败，退订本连接: ${e instanceof Error ? e.message : String(e)}`,
        );
        cleanup();
      }
    });
    raw.on('close', cleanup);
    raw.on('error', cleanup);

    // 首帧：进程实例标识 + 能力清单（/info 同源，连接即知服务身份）
    raw.write(
      encodeSseFrame({
        type: 'server.connected',
        payload: { instanceId, capabilities: [...CAPABILITIES] },
      }),
    );
  }
}
