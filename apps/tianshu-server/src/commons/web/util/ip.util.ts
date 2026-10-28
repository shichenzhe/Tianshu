import { FastifyRequest } from 'fastify';

/**
 * IP工具类
 */
export default class IPUtil {
  /**
   * 获取客户端IP地址
   * @param request 请求对象
   * @returns
   */
  static getClientIP(request: FastifyRequest): string {
    let forwarded = request.headers['x-forwarded-for'] as string;
    if (!forwarded || forwarded.length == 0 || 'unknown' == forwarded) {
      forwarded = request.headers['Proxy-Client-IP'] as string;
    }
    if (!forwarded || forwarded.length == 0 || 'unknown' == forwarded) {
      forwarded = request.headers['WL-Proxy-Client-IP'] as string;
    }
    if (!forwarded || forwarded.length == 0 || 'unknown' == forwarded) {
      forwarded = request.headers['x-real-ip'] as string;
    }
    if (!forwarded || forwarded.length == 0 || 'unknown' == forwarded) {
      forwarded = request.ip;
    }
    if (!forwarded || forwarded.length == 0 || 'unknown' == forwarded) {
      forwarded = request.socket?.remoteAddress || 'unknown';
    }
    if (forwarded) {
      return forwarded.split(',')[0].trim();
    }
    return forwarded;
  }
}
