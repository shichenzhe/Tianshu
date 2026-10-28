/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { ConfigService } from '@nestjs/config';
import { Logger } from '../../../log/logger';
import { LoggerFactory } from '../../../log/logger-factory';
import { ManagementConfig, SecurityConfig } from '../management-config.entity';

/**
 * Actuator端点安全守卫
 * 控制对/actuator/*端点的访问权限
 */
@Injectable()
export class ActuatorGuard implements CanActivate {
  private readonly logger: Logger;

  constructor(
    private readonly configService: ConfigService,
    private readonly loggerFactory: LoggerFactory,
  ) {
    this.logger = this.loggerFactory.create(ActuatorGuard.name);
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const managementConfig =
      this.configService.get<ManagementConfig>('management');

    // 如果没有配置安全设置，默认允许访问
    if (!managementConfig?.security) {
      return true;
    }

    const { enabled, allowedIps, requireAuth } = managementConfig.security;

    // 如果安全功能未启用，允许访问
    if (!enabled) {
      return true;
    }

    // 检查IP白名单
    if (allowedIps && allowedIps.length > 0) {
      const clientIp = this.getClientIp(request);
      if (!this.isIpAllowed(clientIp, allowedIps)) {
        this.logger.warn(`拒绝来自IP ${clientIp} 的actuator访问请求`);
        throw new ForbiddenException('访问被拒绝：IP地址不在白名单中');
      }
    }

    // 检查认证要求
    if (requireAuth) {
      const authHeader = request.headers.authorization;
      if (!authHeader) {
        this.logger.warn('actuator访问请求缺少认证信息');
        throw new UnauthorizedException('需要认证');
      }

      // 验证Bearer token或Basic auth
      if (!this.validateAuth(authHeader, managementConfig.security)) {
        this.logger.warn('actuator访问请求认证失败');
        throw new UnauthorizedException('认证失败');
      }
    }

    return true;
  }

  /**
   * 获取客户端IP地址
   */
  private getClientIp(request: FastifyRequest): string {
    const forwarded = request.headers['x-forwarded-for'] as string;
    if (forwarded) {
      return forwarded.split(',')[0].trim();
    }
    return request.ip || request.socket.remoteAddress || 'unknown';
  }

  /**
   * 检查IP是否在白名单中
   */
  private isIpAllowed(clientIp: string, allowedIps: string[]): boolean {
    return allowedIps.some((allowedIp) => {
      // 支持CIDR格式和通配符
      if (allowedIp === '*' || allowedIp === '0.0.0.0/0') {
        return true;
      }
      if (allowedIp.includes('/')) {
        // CIDR格式检查（简化版）
        const [network, prefixLength] = allowedIp.split('/');
        return this.isIpInCidr(clientIp, network, parseInt(prefixLength));
      }
      return clientIp === allowedIp;
    });
  }

  /**
   * 检查IP是否在CIDR网段中（简化实现）
   */
  private isIpInCidr(
    ip: string,
    network: string,
    prefixLength: number,
  ): boolean {
    // 简化的CIDR检查，实际项目中应使用专业的IP库
    if (prefixLength === 0) return true;
    if (prefixLength >= 32) return ip === network;

    const ipParts = ip.split('.').map(Number);
    const networkParts = network.split('.').map(Number);

    const bytesToCheck = Math.floor(prefixLength / 8);
    const remainingBits = prefixLength % 8;

    // 检查完整字节
    for (let i = 0; i < bytesToCheck; i++) {
      if (ipParts[i] !== networkParts[i]) {
        return false;
      }
    }

    // 检查剩余位
    if (remainingBits > 0 && bytesToCheck < 4) {
      const mask = 0xff << (8 - remainingBits);
      return (
        (ipParts[bytesToCheck] & mask) === (networkParts[bytesToCheck] & mask)
      );
    }

    return true;
  }

  /**
   * 验证认证信息
   */
  private validateAuth(
    authHeader: string,
    securityConfig: SecurityConfig,
  ): boolean {
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      return this.validateBearerToken(token, securityConfig);
    }

    if (authHeader.startsWith('Basic ')) {
      const credentials = authHeader.substring(6);
      return this.validateBasicAuth(credentials, securityConfig);
    }

    return false;
  }

  /**
   * 验证Bearer token
   */
  private validateBearerToken(
    token: string,
    securityConfig: SecurityConfig,
  ): boolean {
    const { tokens } = securityConfig;
    if (!tokens || tokens.length === 0) {
      return false;
    }
    return tokens.includes(token);
  }

  /**
   * 验证Basic认证
   */
  private validateBasicAuth(
    credentials: string,
    securityConfig: SecurityConfig,
  ): boolean {
    try {
      const decoded = Buffer.from(credentials, 'base64').toString('utf-8');
      const [username, password] = decoded.split(':');

      const { users } = securityConfig;
      if (!users || users.length === 0) {
        return false;
      }

      return users.some(
        (user: any) => user.username === username && user.password === password,
      );
    } catch {
      return false;
    }
  }
}
