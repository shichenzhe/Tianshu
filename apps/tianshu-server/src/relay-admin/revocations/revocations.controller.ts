import {
  Controller,
  Get,
  Headers,
  HttpStatus,
  UseFilters,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { Public } from '../../commons/auth/decorator/public.decorator';
import { ErrorCodeEnum } from '../../commons/exception/error-code.enum';
import { RaPrismaService } from '../prisma.service';
import { resolveInternalSecret } from '../relay-admin-config';
import { RelayProtocolException } from '../protocol/relay-protocol.exception';
import { RelayProtocolFilter } from '../protocol/relay-protocol.filter';

/** CRL 名单响应（Task 6 crl.ts parseList 消费契约——本端点在
 *  response.excludePaths，直出无统一包装信封） */
interface RevocationsList {
  epoch: number;
  revokedAk: string[];
  revokedTenant: string[];
}

/**
 * Bearer internal secret 比对（时序安全——T5 relay 内部端点 bearerMatches
 * 同款纪律：长度不等直接 false 只泄露长度，等长路径走 timingSafeEqual）
 */
function bearerMatches(
  authorization: string | undefined,
  secret: string,
): boolean {
  if (typeof authorization !== 'string') return false;
  const presented = Buffer.from(authorization, 'utf8');
  const expected = Buffer.from(`Bearer ${secret}`, 'utf8');
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  );
}

/**
 * relay-admin CRL 名单端点（Task 12，spec §4.4/§6 补偿吊销路径）：
 * `GET /relay-admin/revocations`（`Authorization: Bearer <internalSecret>`）
 * → `{epoch, revokedAk, revokedTenant}`——名单 = 全部 status="disabled" AK
 * + 全部 status="disabled" 用户的 tenantId。
 *
 * **公开路由 + 手检 internal secret**（管理员 JWT 与本端点不同域——
 * internal secret 保护控制信道，与 Ed25519 密钥分域，spec §10）；未配置
 * secret → 503 fail-closed（宁可拒绝服务也不给名单——吊销面不可匿名可读）。
 * epoch 进程内单调 +1；种子取启动时钟秒（跨重启亦大体单调），**多实例
 * 部署（LB 后多进程）不保证全局单调**——beta 单实例语义，relay 侧仅作
 * 观测不据此门控（crl.ts 头注释同款口径）。
 */
@ApiTags('relay-admin/revocations')
@Controller('relay-admin/revocations')
@UseFilters(RelayProtocolFilter)
export class RevocationsController {
  /** 单调计数器（每次响应 +1） */
  private nextEpoch = Math.floor(Date.now() / 1000);

  constructor(
    private readonly raPrisma: RaPrismaService,
    private readonly configService: ConfigService,
  ) {}

  @Get()
  @Public()
  async list(
    @Headers('authorization') authorization?: string,
  ): Promise<RevocationsList> {
    const internalSecret = resolveInternalSecret(this.configService);
    if (!internalSecret) {
      throw new RelayProtocolException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCodeEnum.INTERNAL_SERVER_ERROR,
        '未配置 RA_INTERNAL_SECRET（env 或 config.yml relayAdmin.internalSecret），CRL 名单端点 fail-closed 拒绝服务',
        null,
      );
    }
    if (!bearerMatches(authorization, internalSecret)) {
      throw new RelayProtocolException(
        HttpStatus.UNAUTHORIZED,
        ErrorCodeEnum.UNAUTHORIZED,
        'internal secret 不正确',
        null,
      );
    }

    const [disabledAks, disabledUsers] = await Promise.all([
      this.raPrisma.raAccessKey.findMany({
        where: { status: 'disabled' },
        select: { id: true },
      }),
      this.raPrisma.raUser.findMany({
        where: { status: 'disabled' },
        select: { tenantId: true },
      }),
    ]);
    return {
      epoch: (this.nextEpoch += 1),
      revokedAk: disabledAks.map((row) => row.id),
      revokedTenant: disabledUsers.map((row) => row.tenantId),
    };
  }
}
