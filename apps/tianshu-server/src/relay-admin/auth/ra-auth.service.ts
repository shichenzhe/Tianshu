import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { RaPrismaService } from '../prisma.service';
import { JwtAuthService } from '../../commons/auth/jwt-auth.service';
import { IJwtPayload } from '../../commons/auth/interface/auth.interface';
import { TokenDto } from '../../commons/auth/token.dto';
import { RaLoginDto } from './dto/ra-login.dto';

/** 管理员角色标记（区别于业务库 UserType.admin——不共用枚举语义） */
export const RA_ADMIN_ROLE = 'ra-admin';

/** 用户不存在时的等时垫背摘要：仍跑一次 bcrypt.compare 拉平耗时，
 * 避免「用户名枚举 → 响应时延差异」侧信道（业务端 login 无此垫背，
 * 控制面登录暴露面更敏感，加上） */
const TIMING_PAD_HASH =
  '$2b$10$vDESCOTQOrv.DU1t72Ge9u1mS4JcLujwqsmV8IF9CpFPWIL.gJu6a';

/**
 * relay-admin 管理员登录（Task 9，P1 裁定）：凭据只认 ra_admin_user——
 * 不触业务 user 表。签发复用 commons JwtAuthService（generateTokens 可
 * 签任意 IJwtPayload，secret 走与业务端同源的 JWT_SECRET env 约定）。
 */
@Injectable()
export class RaAuthService {
  constructor(
    private readonly raPrisma: RaPrismaService,
    private readonly jwtAuthService: JwtAuthService,
  ) {}

  async login(dto: RaLoginDto): Promise<TokenDto> {
    const admin = await this.raPrisma.raAdminUser.findUnique({
      where: { username: dto.username },
      select: { id: true, username: true, passwordHash: true },
    });

    // 等时比较：admin 缺失也走完整 compare，统一失败耗时
    const passwordValid = await bcrypt.compare(
      dto.password,
      admin?.passwordHash ?? TIMING_PAD_HASH,
    );
    if (!admin || !passwordValid) {
      throw new UnauthorizedException('用户名或密码错误');
    }

    const payload: IJwtPayload = {
      sub: admin.id,
      username: admin.username,
      name: admin.username,
      roles: [RA_ADMIN_ROLE],
    };
    return this.jwtAuthService.generateTokens(payload);
  }
}
