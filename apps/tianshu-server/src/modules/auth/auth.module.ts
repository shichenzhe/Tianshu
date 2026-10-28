import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { JwtAuthService } from '../../commons/auth/jwt-auth.service';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';
import { UserModule } from '../user/user.module';

@Module({
  imports: [JwtModule, ConfigModule, UserModule],
  controllers: [AuthController],
  providers: [JwtAuthService],
  exports: [JwtAuthService],
})
export class AuthModule {}
