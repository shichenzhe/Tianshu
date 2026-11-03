import { HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AksService } from '../aks/aks.service';
import { RaPrismaService } from '../prisma.service';
import { KeypairService } from '../keys/keypair.service';
import { RelayProtocolException } from '../protocol/relay-protocol.exception';
import { ErrorCodeEnum } from '../../commons/exception/error-code.enum';
import {
  signAccessJwt,
  type AccessClaims,
} from '../../relay/jwt-eddsa';

/** access TTL：30d（spec §5.1/§5.3——D5 长效 access，到期只拦新连接） */
const ACCESS_TTL_SEC = 30 * 24 * 60 * 60; // 2592000

/** 换发响应（接入方内存态：{token, expiresAt, maxAgeSec}——Task 14/15/16
 *  续期循环消费面） */
export interface RaTokenIssuedResult {
  accessToken: string;
  /** exp 的 ms 形态（接入方侧时钟比对统一 ms） */
  expiresAt: number;
  maxAgeSec: number;
}

/** isAkUsable 失败 reason → 401 信封（消息给人、reason 给机器） */
function akFailureException(
  reason: 'not-found' | 'disabled' | 'expired' | 'bad-secret',
): RelayProtocolException {
  const messages: Record<typeof reason, string> = {
    'not-found': 'AK 不存在',
    disabled: 'AK 已被禁用（或所属用户已被禁用）',
    expired: 'AK 已过期',
    'bad-secret': 'AK secret 不正确',
  };
  return new RelayProtocolException(
    HttpStatus.UNAUTHORIZED,
    ErrorCodeEnum.UNAUTHORIZED,
    messages[reason],
    { reason },
  );
}

/**
 * relay-admin token 换发（Task 12，spec §5.1）：AK（Basic 出示）→ 30d
 * access JWT（Ed25519 签发，relay 离线验签）。高频端点**不落审计**
 * （spec §6「renew 高频不记」）；失败一律 401 + data.reason（四端续期
 * 循环按状态码断连告警，reason 供运维定位）。
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly aksService: AksService,
    private readonly raPrisma: RaPrismaService,
    private readonly keypair: KeypairService,
  ) {}

  async issueForAkCredentials(
    akId: string,
    akSecret: string,
  ): Promise<RaTokenIssuedResult> {
    const usable = await this.aksService.isAkUsable(akId, akSecret);
    if (!usable.ok) {
      throw akFailureException(usable.reason);
    }
    // tid 取属主 tenantId（isAkUsable 成功联合不带 tenantId，补取用户行）
    const user = await this.raPrisma.raUser.findUnique({
      where: { id: usable.userId },
      select: { id: true, tenantId: true },
    });
    if (!user) {
      // 属主在两查之间被删（无删除端点，纯旁路面）——按凭证失效处理
      throw akFailureException('not-found');
    }

    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + ACCESS_TTL_SEC;
    const claims: AccessClaims = {
      iss: 'tianshu-relay',
      sub: user.id,
      tid: user.tenantId,
      // role 直取 AK role（签发面 DTO 已白名单；旁路写库的非法角色由
      // relay 侧 createJwtAuthenticator 角色白名单兜底——T3 设计裁定）
      role: usable.role as 'server' | 'client',
      ak: akId,
      quota: usable.quota,
      iat,
      exp,
      jti: randomUUID(),
      kid: this.keypair.getKeyId(),
    };
    const accessToken = signAccessJwt(claims, this.keypair.getPrivateKeyPem());
    return { accessToken, expiresAt: exp * 1000, maxAgeSec: ACCESS_TTL_SEC };
  }
}
