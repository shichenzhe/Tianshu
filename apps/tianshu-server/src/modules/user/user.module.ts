import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { UserRepository } from './user.repository';
import { PrismaModule } from '../../commons/database/prisma.module';
import { LogModule } from '../../commons/log/log.module';
import { JwtAuthService } from '../../commons/auth/jwt-auth.service';
import { JwtAuthGuard } from '../../commons/auth/guard/jwt-auth.guard';
import { RolesGuard } from '../../commons/auth/roles.guard';

@Module({
  imports: [
    LogModule,
    PrismaModule,
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: configService.get<string>('JWT_EXPIRES_IN', '1h'),
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [UserController],
  providers: [
    UserService,
    UserRepository,
    JwtAuthService,
    JwtAuthGuard,
    RolesGuard,
  ],
  exports: [UserService, UserRepository, JwtAuthService],
})
export class UserModule {}
