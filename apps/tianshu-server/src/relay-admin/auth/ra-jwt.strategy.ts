import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { RaPrismaService } from '../prisma.service';
import { IAuthConfig, IJwtPayload } from '../../commons/auth/interface/auth.interface';

/**
 * relay-admin 管理员 JWT 验证策略（Task 9）
 *
 * 与业务端 commons JwtStrategy 的关键分叉：验签后回查的是 ra_admin_user
 * 而非业务 user 表——操作者身份只存在于 relay-admin 独立库（P1 裁定），
 * 业务用户 token（即使共用 JWT_SECRET 签发）因 sub 不在 ra_admin_user
 * 而被拒，反之亦然。注册名沿用 'jwt'：commons JwtAuthGuard
 * （PassportAuthGuard('jwt')）无需改动即消费本策略。
 */
@Injectable()
export class RaJwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    configService: ConfigService,
    private readonly raPrisma: RaPrismaService,
  ) {
    const authConfig = configService.get<IAuthConfig>('auth');

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: authConfig?.jwt?.secret as string,
      algorithms: ['HS256'],
    });
  }

  /**
   * 验证 JWT 载荷（passport 惯例：验签后回查库——幻影凭证防护对齐业务端
   * 2026-11-02 批；此处回查对象是管理员表）
   */
  async validate(payload: IJwtPayload): Promise<IJwtPayload> {
    if (!payload.sub || !payload.username) {
      throw new UnauthorizedException('Invalid token payload');
    }

    const admin = await this.raPrisma.raAdminUser.findUnique({
      where: { id: payload.sub },
      select: { id: true },
    });
    if (!admin) {
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
