import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ResponseDto } from '../entity/response.dto';
import { FastifyRequest } from 'fastify';
import { ConfigService } from '@nestjs/config';
import { ResponseConfig } from '../../config/response-config.entity';

/**
 * 响应拦截器
 * @description 统一返回格式
 * @export
 * @class ResponseInterceptor
 * @implements {NestInterceptor}
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  ResponseDto<T>
> {
  constructor(private readonly configService: ConfigService) {}
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ResponseDto<T>> {
    const ctx = context.switchToHttp();
    const request = ctx.getRequest<FastifyRequest>();

    // 获取响应配置
    const responseConfig = this.configService.get<ResponseConfig>(
      'response',
      ResponseConfig.getDefault(),
    );

    // 检查当前请求路径是否在排除列表中
    const shouldExclude = responseConfig.excludePaths.some((excludePath) =>
      request.url?.includes(excludePath),
    );

    if (shouldExclude) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return next.handle();
    }

    return next.handle().pipe(
      map((data) => ({
        code: '2000',
        success: true,
        data: data as T,
        message: 'success',
      })),
    );
  }
}
