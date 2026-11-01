import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { ResponseDto } from '../entity/response.dto';
import { FastifyReply } from 'fastify'; // 引入 FastifyReply
import { ErrorCodeFactory } from 'src/commons/exception/error-code.factory';

/**
 * 异常响应过滤器
 * @description 统一返回格式
 * @export
 * @class HttpExceptionFilter
 * @implements {ExceptionFilter}
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: any, host: ArgumentsHost) {
    console.log('HttpExceptionFilter caught exception:', exception);
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>(); // 使用 FastifyReply
    if (exception instanceof UnauthorizedException) {
      // return 收口：无 return 会继续走到下方 status(200).send 二次发送
      // （Fastify 对已发送响应的二次 send 侥幸仅告警忽略，Nest/Fastify
      // 升级即可能变成 200 覆盖 401）
      response.status(401).send({
        code: ErrorCodeFactory.get(exception),
        success: false,
        data: null,
        message: exception.message,
      });
      return;
    }
    const status = ErrorCodeFactory.get(exception);
    const errorResponse: ResponseDto<any> = {
      code: status,
      success: false,
      data: null,
      message: '',
    };

    if (exception instanceof HttpException) {
      if (exception.getResponse() instanceof Object) {
        errorResponse.message = exception.getResponse()['message'] as string;
      } else {
        errorResponse.message = exception.getResponse() as string;
      }
    } else if (exception instanceof Error) {
      errorResponse.message = exception['message'];
    } else {
      errorResponse.message = 'Unknown Internal Server Error';
    }
    if (Array.isArray(errorResponse.message)) {
      errorResponse.message = errorResponse.message.join(',');
    }
    // 使用 Fastify 的响应方式
    response.status(200).send(errorResponse);
  }
}
