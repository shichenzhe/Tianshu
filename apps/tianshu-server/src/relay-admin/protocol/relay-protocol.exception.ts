import { HttpException } from '@nestjs/common';

/**
 * 协议端点异常（Task 12）：token（接入方 Basic 换 access）与 revocations
 * （relay CRL 拉取）是**非管理面**端点——消费方按真实 HTTP 状态码分支
 * （四端续期循环凭 401 判 AK 失效断连、crl.ts 凭 2xx 判拉取成功），且
 * token 失败需机器可读的 data.reason。
 *
 * 全局 HttpExceptionFilter 会把一切非 UnauthorizedException 落成
 * HTTP 200 管理面信封（data 恒 null），无法承载上述契约——故本族端点
 * 绑路由级 RelayProtocolFilter（见同目录）直出真实状态码信封。
 */
export class RelayProtocolException extends HttpException {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
    readonly data: Record<string, unknown> | null = null,
  ) {
    super(message, httpStatus);
  }
}
