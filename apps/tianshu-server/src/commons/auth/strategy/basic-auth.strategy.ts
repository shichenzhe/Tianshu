import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { BasicStrategy } from 'passport-http';
import { ConfigService } from '@nestjs/config';
import { IAuthConfig, IAuthUser } from '../interface/auth.interface';
import * as bcrypt from 'bcrypt';

/**
 * BasicAuth认证策略
 * 通用的用户名密码验证策略
 */
@Injectable()
export class BasicAuthStrategy extends PassportStrategy(
  BasicStrategy,
  'basic',
) {
  private users: Array<{
    username: string;
    password: string;
    roles?: string[];
  }>;

  constructor(private configService: ConfigService) {
    super();
    const authConfig = configService.get<IAuthConfig>('auth');
    this.users = authConfig?.basic?.users || [];
  }

  /**
   * 验证用户凭据
   * @param username 用户名
   * @param password 密码
   * @returns 用户信息
   */
  async validate(username: string, password: string): Promise<IAuthUser> {
    const user = await this.validateUser(username, password);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return user;
  }

  /**
   * 验证用户是否存在且密码正确
   * @param username 用户名
   * @param password 密码
   * @returns 用户信息或null
   */
  private async validateUser(
    username: string,
    password: string,
  ): Promise<IAuthUser | null> {
    const user = this.users.find((u) => u.username === username);
    if (!user) {
      return null;
    }

    const isPasswordValid = await this.comparePassword(password, user.password);
    if (!isPasswordValid) {
      return null;
    }

    return {
      username: user.username,
      roles: user.roles || [],
    };
  }

  /**
   * 比较密码
   * @param plainPassword 明文密码
   * @param hashedPassword 哈希密码
   * @returns 是否匹配
   */
  private async comparePassword(
    plainPassword: string,
    hashedPassword: string,
  ): Promise<boolean> {
    try {
      // 如果密码看起来像是哈希值，使用bcrypt比较
      if (
        hashedPassword.startsWith('$2b$') ||
        hashedPassword.startsWith('$2a$')
      ) {
        return await bcrypt.compare(plainPassword, hashedPassword);
      }
      // 否则进行简单的字符串比较（不推荐用于生产环境）
      return plainPassword === hashedPassword;
    } catch {
      return false;
    }
  }
}
