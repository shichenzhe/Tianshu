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
      response.status(401).send({
        code: ErrorCodeFactory.get(exception),
        success: false,
        data: null,
        message: exception.message,
      });
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
