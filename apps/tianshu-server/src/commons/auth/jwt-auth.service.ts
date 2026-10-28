import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { IAuthConfig, IJwtPayload } from './interface/auth.interface';
import { TokenDto } from './token.dto';

@Injectable()
export class JwtAuthService {
  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * 创建访问令牌
   * @param map
   * @returns
   */
  private createToken(map: any): string {
    const authConfig = this.configService.get<IAuthConfig>('auth');

    if (!authConfig?.jwt?.secret || !authConfig?.jwt?.expiresIn) {
      throw new Error('JWT configuration is missing');
    }

    return this.jwtService.sign(map, {
      secret: authConfig.jwt.secret,
      expiresIn: authConfig.jwt.expiresIn,
    });
  }

  /**
   * 创建刷新令牌
   * @param map
   * @returns
   */
  private createRefreshToken(map: any): string {
    const authConfig = this.configService.get<IAuthConfig>('auth');

    if (!authConfig?.jwt?.secret || !authConfig?.jwt?.refreshExpiresIn) {
      throw new Error('JWT configuration is missing');
    }

    return this.jwtService.sign(map, {
      secret: authConfig.jwt.secret,
      expiresIn: authConfig.jwt.refreshExpiresIn,
    });
  }

  /**
   * 生成访问令牌和刷新令牌
   * @param payload JWT载荷数据
   * @returns 包含访问令牌和刷新令牌的对象
   */
  generateTokens(payload: IJwtPayload): TokenDto {
    if (!payload.sub || !payload.username) {
      throw new Error('Invalid payload: sub and username are required');
    }

    delete payload.iat;
    delete payload.exp;
    return {
      accessToken: this.createToken(payload),
      refreshToken: this.createRefreshToken(payload),
    };
  }

  /**
   * 验证令牌
   * @param token JWT令牌
   * @returns 解码后的载荷
   */
  verifyToken(token: string): IJwtPayload {
    const authConfig = this.configService.get<IAuthConfig>('auth');

    if (!authConfig?.jwt?.secret) {
      throw new Error('JWT configuration is missing');
    }

    try {
      return this.jwtService.verify(token, {
        secret: authConfig.jwt.secret,
      });
    } catch {
      throw new Error('Invalid or expired token');
    }
  }

  /**
   * 验证刷新令牌
   * @param refreshToken 刷新令牌
   * @returns 解码后的载荷
   */
  verifyRefreshToken(refreshToken: string): IJwtPayload {
    const authConfig = this.configService.get<IAuthConfig>('auth');

    if (!authConfig?.jwt?.secret) {
      throw new Error('JWT configuration is missing');
    }

    try {
      return this.jwtService.verify(refreshToken, {
        secret: authConfig.jwt.secret,
      });
    } catch {
      throw new Error('Invalid or expired refresh token');
    }
  }

  /**
   * 从刷新令牌生成新的访问令牌
   * @param refreshToken 刷新令牌
   * @returns 新的令牌对
   */
  refreshTokens(refreshToken: string): TokenDto {
    const payload = this.verifyRefreshToken(refreshToken);

    // 创建新的载荷，移除时间戳字段
    const newPayload: IJwtPayload = {
      sub: payload.sub,
      username: payload.username,
      name: payload.name,
      roles: payload.roles,
    };

    return this.generateTokens(newPayload);
  }
}
