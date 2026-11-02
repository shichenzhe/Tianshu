import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { consumeRateLimit } from '../../commons/security/rate-limit';
import { Public } from '../../commons/auth/decorator/public.decorator';
import { TokenDto } from '../../commons/auth/token.dto';
import { RaAuthService } from './ra-auth.service';
import { RaLoginDto } from './dto/ra-login.dto';

/** 管理员登录爆破限流（业务端 /auth/login 安全批 F2 同款口径） */
const LOGIN_RATE_LIMIT_MAX = 10;
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60_000;

/**
 * relay-admin 管理员认证端点（Task 9）
 * 路由前缀 /relay-admin/* 为 CRL 拉取约定（relay 侧 crlAdminUrl 拼接）。
 */
@Controller('relay-admin/auth')
export class RaAuthController {
  constructor(private readonly raAuthService: RaAuthService) {}

  /** 管理员登录：username/password → JWT（P1 裁定路径） */
  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: RaLoginDto,
    @Req() req: FastifyRequest,
  ): Promise<TokenDto> {
    const ip = (req.ip ?? 'unknown').toString();
    const verdict = consumeRateLimit(
      `ra-login:${ip}`,
      LOGIN_RATE_LIMIT_MAX,
      LOGIN_RATE_LIMIT_WINDOW_MS,
    );
    if (!verdict.allowed) {
      throw new HttpException('尝试过于频繁，请稍后再试', 429);
    }
    return this.raAuthService.login(dto);
  }
}
