import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { IAuthConfig, IJwtPayload } from '../interface/auth.interface';

/**
 * JWT认证策略
 * 通用的JWT令牌验证策略
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const authConfig = configService.get<IAuthConfig>('auth');

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: authConfig?.jwt?.secret as string,
      algorithms: ['HS256'], // 默认算法
    });
  }

  /**
   * 验证JWT载荷（passport 惯例：验签后回查库）
   *
   * JWT 是无状态凭证，验签通过不等于用户仍在：user 表数据消失（删行/
   * 重建库/换库）后残留 token 在有效期内验签依然通过，业务以幻影身份
   * 继续操作（2026-11-02 幻影用户防护，对齐 mirror 批修复）。故回查
   * user 表主键确认存在，不存在按 401 拒绝。
   * @param payload JWT载荷
   * @returns 用户信息
   */
  async validate(payload: IJwtPayload): Promise<IJwtPayload> {
    if (!payload.sub || !payload.username) {
      throw new UnauthorizedException('Invalid token payload');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true },
    });
    if (!user) {
      throw new UnauthorizedException('登录已过期');
    }

    return {
      sub: payload.sub,
      name: payload.name,
      username: payload.username,
      roles: payload.roles || [],
    };
  }
}
