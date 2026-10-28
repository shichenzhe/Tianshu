import { Module, DynamicModule } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtStrategy } from './strategy/jwt.strategy';
import { BasicAuthStrategy } from './strategy/basic-auth.strategy';
import { JwtAuthGuard } from './guard/jwt-auth.guard';
import { BasicAuthGuard } from './guard/basic-auth.guard';
import { IAuthConfig } from './interface/auth.interface';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthService } from './jwt-auth.service';
/**
 * 认证模块配置选项
 */
export interface AuthModuleOptions {
  /** 是否全局模块 */
  global?: boolean;
  /** 默认认证策略 */
  defaultStrategy?: 'jwt' | 'basic';
  /** 自定义JWT配置 */
  jwtOptions?: {
    secret?: string;
    expiresIn?: string;
  };
}

/**
 * 通用认证模块
 * 提供JWT和Basic Auth认证功能
 */
@Module({})
export class AuthModule {
  /**
   * 注册认证模块
   * @param options 模块配置选项
   * @returns 动态模块
   */
  static register(options: AuthModuleOptions = {}): DynamicModule {
    return {
      module: AuthModule,
      global: options.global || false,
      imports: [
        PassportModule.register({
          defaultStrategy: options.defaultStrategy || 'jwt',
        }),
        JwtModule.registerAsync({
          imports: [ConfigModule],
          useFactory: (configService: ConfigService) => {
            const authConfig = configService.get<IAuthConfig>('auth');
            return {
              secret: options.jwtOptions?.secret || authConfig?.jwt?.secret,
              signOptions: {
                expiresIn:
                  options.jwtOptions?.expiresIn || authConfig?.jwt?.expiresIn,
              },
            };
          },
          inject: [ConfigService],
        }),
      ],
      providers: [
        JwtAuthService,
        JwtStrategy,
        BasicAuthStrategy,
        JwtAuthGuard,
        BasicAuthGuard,
        // 条件性提供全局守卫
        {
          provide: APP_GUARD,
          useFactory: (
            configService: ConfigService,
            jwtAuthGuard: JwtAuthGuard,
            basicAuthGuard: BasicAuthGuard,
          ) => {
            const authConfig = configService.get<IAuthConfig>('auth');

            // 如果配置中禁用了全局认证，返回 null
            if (!authConfig?.global) {
              return null;
            }

            // 根据配置选择默认策略
            if (authConfig?.defaultStrategy === 'basic') {
              return basicAuthGuard;
            }

            // 默认使用 JWT 认证
            return jwtAuthGuard;
          },
          inject: [ConfigService, JwtAuthGuard, BasicAuthGuard],
        },
      ],
      exports: [
        JwtAuthGuard,
        BasicAuthGuard,
        JwtModule,
        PassportModule,
        JwtAuthService,
      ],
    };
  }

  /**
   * 注册为全局模块
   * @param options 模块配置选项
   * @returns 动态模块
   */
  static forRoot(options: AuthModuleOptions = {}): DynamicModule {
    return this.register({ ...options, global: true });
  }
}
