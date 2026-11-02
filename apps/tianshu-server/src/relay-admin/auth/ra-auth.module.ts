import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { JwtAuthService } from '../../commons/auth/jwt-auth.service';
import { RaJwtStrategy } from './ra-jwt.strategy';
import { RaAuthService } from './ra-auth.service';
import { RaAuthController } from './ra-auth.controller';
import { RaPrismaModule } from '../prisma.module';

/**
 * relay-admin 认证模块（Task 9）
 *
 * 不整体 import commons AuthModule：其 providers 会拉起业务库
 * JwtStrategy（回查业务 user 表）与 BasicAuthStrategy——操作者身份在
 * ra_admin_user（P1 裁定），业务库 client 不应进入本入口。守卫/
 * 签发服务仍复用 commons 单份实现：JwtAuthGuard 消费 passport 'jwt'
 * 策略名（本模块以 RaJwtStrategy 注册同名策略顶替），JwtAuthService
 * 经显式 provider 装配（业务端 modules/auth 同款：plain JwtModule +
 * 签发时显式传 secret）。
 */
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule,
    RaPrismaModule,
  ],
  controllers: [RaAuthController],
  providers: [RaJwtStrategy, JwtAuthService, RaAuthService],
  exports: [JwtAuthService],
})
export class RaAuthModule {}
