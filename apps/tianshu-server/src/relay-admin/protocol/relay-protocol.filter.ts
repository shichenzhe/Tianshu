import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { RelayProtocolException } from './relay-protocol.exception';

/**
 * 协议端点异常过滤器（Task 12）：路由级绑定在 token/revocations 控制器上
 * （先于全局 APP_FILTER 生效），把 RelayProtocolException 直出为
 * `{code, success, message, data}` 信封 + **真实 HTTP 状态码**——字段面与
 * 全局信封同构（ResponseDto 四字段），仅状态码语义不同（协议端点不做
 * 管理面 HTTP 200 包装）。其余异常类型不在此接（落全局过滤器兜底）。
 */
@Catch(RelayProtocolException)
export class RelayProtocolFilter implements ExceptionFilter {
  catch(exception: RelayProtocolException, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<FastifyReply>();
    response.status(exception.httpStatus).send({
      code: exception.code,
      success: false,
      data: exception.data,
      message: exception.message,
    });
  }
}
