import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpException,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { createHash } from 'node:crypto';
import { FastifyRequest, FastifyReply } from 'fastify';
import { Logger } from 'src/commons/log/logger';
import { LoggerFactory } from 'src/commons/log/logger-factory';
import IPUtil from '../util/ip.util';
import { MASKED_VALUE, maskUrlToken } from '../util/url-sanitize.util';
import { BusinessException } from 'src/commons/exception/bussiness-exception';

/**
 * 请求日志拦截器
 * 记录所有controller请求的详细信息
 * 凭据脱敏（终审必修 1）：url/query 的 token、authorization 头、请求体与
 * 响应体中的敏感键值（apiKey/authKey/token/accessToken/refreshToken）均
 * 打码为 *** 后才落日志——日志按 config.yml 落盘旋转保留，不可回传明文。
 */
/** 敏感键（小写比较）：对象直接持有即整值打码 */
const SENSITIVE_VALUE_KEYS = new Set([
  'apikey',
  'authkey',
  'token',
  'accesstoken',
  'refreshtoken',
  // 备份多用户批（spec 2026-10-28）：backup/claim 包装响应 data.clientToken
  // 为长期设备凭据（与 accesstoken/refreshtoken 后缀命名同款）——「明文
  // 仅 claim 回显一次」不变量在日志面同样成立，不落按日轮转日志
  'clienttoken',
  // relay 多租户（spec 2026-11-03 §5.2）：aks 签发/rotate-secret 包装响应
  // data.akSecret 为 32B hex 长期凭证（GitHub PAT 同级）——「明文仅本次
  // 响应返回一次」不变量在日志面同样成立（clienttoken 先例同款镜像）
  'aksecret',
  // 口令面（复审补）：/auth/login 请求体 password、改密 DTO 三键、
  // user query 响应 passwordHash（bcrypt 摘要亦不落日志）
  'password',
  'oldpassword',
  'newpassword',
  'confirmpassword',
  'passwordhash',
]);
/** 敏感值打码占位符（url/query 面共用口径已抽 url-sanitize.util） */
/** 递归打码深度上限（防畸形深嵌套；超出层原样保留） */
const MASK_MAX_DEPTH = 8;

@Injectable()
export class RequestLoggerInterceptor implements NestInterceptor {
  private readonly logger: Logger;

  constructor(private readonly factory: LoggerFactory) {
    this.logger = this.factory.create('RequestLoggerInterceptor');
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const response = context.switchToHttp().getResponse<FastifyReply>();
    const startTime = Date.now();
    const requestTime = new Date().toISOString();

    // 获取请求基本信息
    const requestInfo = this.extractRequestInfo(request);
    requestInfo['requestTime'] = requestTime;
    this.logger.info(JSON.stringify(requestInfo));

    return next.handle().pipe(
      tap((responseData: any) => {
        const endTime = Date.now();
        const duration = endTime - startTime;

        this.logger.info(
          JSON.stringify({
            status: response.statusCode,
            responseTime: new Date().toISOString(),
            duration,
            response: this.sanitizeResponseData(responseData),
          }),
        );
      }),
      catchError((error: any) => {
        const endTime = Date.now();
        const duration = endTime - startTime;

        this.logger.error(
          JSON.stringify({
            status: response.statusCode,
            responseTime: new Date().toISOString(),
            duration,
            error:
              error instanceof BusinessException
                ? error.toJSON()
                : String(error),
          }),
        );

        return throwError(() => error as HttpException | BusinessException);
      }),
    );
  }

  /**
   * 提取请求信息
   */
  private extractRequestInfo(request: FastifyRequest) {
    const method = request.method;
    // 获取子路径（query 中 token 打码，SSE EventSource 经 ?token= 携带凭证）
    const url = maskUrlToken(request.url);
    const queryParams = this.maskQueryToken(request.query);
    // 安全批 B6：消息载荷路径正文只记摘要——聊天/图/自动化请求体原文
    // 落 info 级按日日志曾使 e2e 内容防护在日志面旁路失效（日志采集/
    // 备份/运维读取即全量对话内容）；非载荷路径保持原打码记录
    const body = this.isMessagePayloadPath(request.url)
      ? `<payload ${JSON.stringify(request.body ?? {}).length}B 摘要 ${this.payloadDigest(request.body)}>`
      : this.maskSensitiveData(request.body);
    const headers = this.extractHeaders(request.headers);
    const clientIp = IPUtil.getClientIP(request);
    const userAgent = request.headers['user-agent'];

    return {
      method,
      url,
      queryParams,
      body,
      headers,
      clientIp,
      userAgent,
    };
  }

  /** 消息载荷路径判定（安全批 B6）：正文/提示词类请求体只记摘要 */
  private isMessagePayloadPath(url: string): boolean {
    return /\/session\/(send|editAndResend|regenerate|polish|compact)|\/graph\/(run|save)|\/automation\/(save|runNow)|\/webhook\//.test(
      url,
    );
  }

  /** 载荷摘要：全文 sha256 前 8 字（可区分不可还原） */
  private payloadDigest(body: unknown): string {
    try {
      const json = JSON.stringify(body ?? {});
      return createHash("sha256").update(json).digest("hex").slice(0, 8);
    } catch {
      return "n/a";
    }
  }

  /** query 对象的 token 键值打码（浅层：token 只出现在顶层） */
  private maskQueryToken(query: unknown): unknown {
    if (!query || typeof query !== 'object') {
      return query;
    }
    const masked: Record<string, unknown> = { ...(query as object) };
    if ('token' in masked) {
      masked.token = MASKED_VALUE;
    }
    return masked;
  }

  /**
   * 递归打码敏感字段：仅对象直接持有的敏感键整值打码，嵌套对象/数组继续
   * 下钻（深度上限 MASK_MAX_DEPTH）；返回新对象不改写原数据（响应体经
   * 序列化回客户端，不可被日志逻辑污染），Date 原样保留。
   */
  private maskSensitiveData(data: unknown, depth = 0): unknown {
    if (
      depth >= MASK_MAX_DEPTH ||
      data === null ||
      typeof data !== 'object' ||
      data instanceof Date
    ) {
      return data;
    }
    if (Array.isArray(data)) {
      return data.map((item) => this.maskSensitiveData(item, depth + 1));
    }
    const masked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      data as Record<string, unknown>,
    )) {
      masked[key] =
        SENSITIVE_VALUE_KEYS.has(key.toLowerCase()) && value != null
          ? MASKED_VALUE
          : this.maskSensitiveData(value, depth + 1);
    }
    return masked;
  }

  private extractHeaders(
    headers: FastifyRequest['headers'],
  ): Record<string, string | string[] | undefined> {
    const sensitiveHeaders = [
      'authorization',
      'content-length',
      'cookie',
      'sec-ch-ua',
      'sec-ch-ua-mobile',
      'accept',
      'accept-encoding',
      'accept-language',
      'origin',
      'referer',
      'sec-ch-ua-platform',
      'sec-fetch-site',
      'sec-fetch-mode',
      'sec-fetch-dest',
      'connection',
      'pragma',
      'cache-control',
      'user-agent',
      'request-origion',
    ];
    const sanitized: Record<string, string | string[] | undefined> = {
      ...headers,
    };

    sensitiveHeaders.forEach((header) => {
      if (sanitized[header]) {
        delete sanitized[header];
      }
    });

    return sanitized;
  }

  /**
   * 清理响应数据：敏感键值递归打码后序列化，超长截断（4096 字符）
   */
  private sanitizeResponseData(data: any): string {
    if (!data) return 'null';

    const dataString = JSON.stringify(this.maskSensitiveData(data));
    // 限制响应数据大小最大输出4096个字符，避免日志过大
    return dataString.length > 4096
      ? dataString.substring(0, 4096)
      : dataString;
  }
}
