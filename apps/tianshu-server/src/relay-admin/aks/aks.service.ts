import { Injectable } from '@nestjs/common';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { RaPrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { BusinessException } from '../../commons/exception/bussiness-exception';
import { ErrorCodeEnum } from '../../commons/exception/error-code.enum';
import { RaAkCreateDto } from './dto/ra-ak-create.dto';
import { RaAkExtendDto } from './dto/ra-ak-extend.dto';
import { RaAkDto } from './dto/ra-ak.dto';

/** 套餐配额（spec §6：beta 单档 maxServers=5/maxClients=10；签发 access 时
 * 写入 claims 的 quota 即此值）。扩档时此处与 users DTO 的 RA_PLANS 同步增补 */
export interface PlanQuota {
  maxServers: number;
  maxClients: number;
}

/** plan → quota 映射：Task 11 isAkUsable / Task 12 token 端点共用单源。
 * 未知 plan 裁定（brief 二选一）：**签发时 BusinessException 拒发**（fail-
 * closed——配额未配置的档位大声失败，不静默放行）；isAkUsable 查询侧对
 * 直插库等旁路产生的未知 plan 降级按 beta 取（结果联合无 unknown-plan
 * reason，认证路径不可因数据瑕疵抛异常），与签发侧裁定不冲突 */
export const PLAN_QUOTA: Record<string, PlanQuota> = {
  beta: { maxServers: 5, maxClients: 10 },
};

/** 签发/轮换响应：akSecret 明文仅本次响应返回一次，库内只存 sha256(明文) */
export interface RaAkIssuedResult {
  akId: string;
  akSecret: string;
}

/** isAkUsable 结果联合（Task 12 token 端点消费，失败 401 {reason} 映射源） */
export type AkUsableResult =
  | { ok: true; userId: string; role: string; quota: PlanQuota }
  | {
      ok: false;
      reason: 'not-found' | 'disabled' | 'expired' | 'bad-secret';
    };

/** AK 有效期缺省 365d（spec §5.2「有效期默认 1 年」） */
const DEFAULT_AK_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** sha256 hex 摘要（AK secret 库内存储形态——spec §5.2 GitHub PAT 惯例） */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * relay-admin AK 生命周期管理（Task 11）：签发/禁用/恢复/轮换/续期。
 * secret 明文只在 create/rotateSecret 的本次响应出现一次，库内存
 * sha256(明文)；所有写操作伴行 AuditService 落审计（动作名 ak.create /
 * ak.disable / ak.enable / ak.rotate-secret / ak.extend——用户级联禁用是
 * users 模块的 ak.cascade-disable 词汇，本模块不复用）。
 * isAkUsable 供 Task 12 token 端点做凭证校验（auth 热路径，不落审计——
 * spec §6「renew 高频不记」）。
 */
@Injectable()
export class AksService {
  constructor(
    private readonly raPrisma: RaPrismaService,
    private readonly audit: AuditService,
  ) {}

  /** 签发：akId=randomUUID()、akSecret=randomBytes(32) hex、库存摘要；
   * expireAt 缺省 now+365d。前置校验用户存在且 status=active（禁用租户
   * 不得补发新凭证——fail-closed） */
  async create(
    dto: RaAkCreateDto,
    operator: string,
  ): Promise<RaAkIssuedResult> {
    const user = await this.raPrisma.raUser.findUnique({
      where: { id: dto.userId },
    });
    if (!user) {
      throw new BusinessException('用户不存在', ErrorCodeEnum.NOT_FOUND);
    }
    if (user.status !== 'active') {
      throw new BusinessException(
        '用户已被禁用，不能签发 AK',
        ErrorCodeEnum.FORBIDDEN,
      );
    }
    if (!PLAN_QUOTA[user.plan]) {
      throw BusinessException.of(
        `用户套餐 ${user.plan} 未配置配额映射，无法签发 AK`,
      );
    }
    const akSecret = randomBytes(32).toString('hex');
    const row = await this.raPrisma.raAccessKey.create({
      data: {
        id: randomUUID(),
        secretHash: sha256Hex(akSecret),
        role: dto.role,
        userId: user.id,
        expireAt: dto.expireAt
          ? new Date(dto.expireAt)
          : new Date(Date.now() + DEFAULT_AK_TTL_MS),
        creator: operator,
      },
    });
    await this.audit.log(
      'ak.create',
      operator,
      row.id,
      JSON.stringify({ userId: user.id, role: dto.role }),
    );
    return { akId: row.id, akSecret };
  }

  /** 列表：按 userId 过滤（createdAt desc） */
  async list(userId: string): Promise<RaAkDto[]> {
    const rows = await this.raPrisma.raAccessKey.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => RaAkDto.create(row));
  }

  /** 禁用（临时吊销，可恢复）。无 status 前件（重复禁用幂等）
   * TODO(Task 13)：吊销 kick 即时联动——RelayLinkService.kick({ak}) 接入
   * 本路径（失败降级 CRL 兜底，只 warn 不回滚禁用） */
  async disable(akId: string, operator: string): Promise<void> {
    await this.getExisting(akId);
    await this.raPrisma.raAccessKey.update({
      where: { id: akId },
      data: { status: 'disabled', updator: operator },
    });
    await this.audit.log('ak.disable', operator, akId);
  }

  /** 恢复：fail-closed——所属用户仍禁用时拒绝（须先 users.enable 恢复用户，
   * 再逐把恢复 AK；否则会出现「用户在 CRL 名单但其租户仍可换 token」的
   * 吊销缺口） */
  async enable(akId: string, operator: string): Promise<void> {
    const ak = await this.getExisting(akId);
    const user = await this.raPrisma.raUser.findUnique({
      where: { id: ak.userId },
    });
    if (!user) {
      throw new BusinessException(
        'AK 所属用户不存在',
        ErrorCodeEnum.NOT_FOUND,
      );
    }
    if (user.status !== 'active') {
      throw new BusinessException(
        '所属用户已被禁用，请先恢复用户',
        ErrorCodeEnum.FORBIDDEN,
      );
    }
    await this.raPrisma.raAccessKey.update({
      where: { id: akId },
      data: { status: 'active', updator: operator },
    });
    await this.audit.log('ak.enable', operator, akId);
  }

  /** 轮换 secret（泄露处置）：发新 32B 明文、旧摘要即刻替换——旧 secret
   * 在本调用返回后即 bad-secret。无 status 前件（禁用态 AK 轮换后仍禁用，
   * 不构成放行面）。TODO(Task 13)：同 disable 接入 kick({ak}) 拆存量 */
  async rotateSecret(
    akId: string,
    operator: string,
  ): Promise<RaAkIssuedResult> {
    await this.getExisting(akId);
    const akSecret = randomBytes(32).toString('hex');
    await this.raPrisma.raAccessKey.update({
      where: { id: akId },
      data: { secretHash: sha256Hex(akSecret), updator: operator },
    });
    await this.audit.log('ak.rotate-secret', operator, akId);
    return { akId, akSecret };
  }

  /** 续期：expireAt 只能延后不能提前（与现库存值比较，等值亦拒——无操作
   * 语义）；提前抛 BusinessException。无 status 前件（禁用/已过期 AK 均可
   * 续期——过期续命、禁用恢复是运营侧正路，恢复走 enable） */
  async extend(
    akId: string,
    dto: RaAkExtendDto,
    operator: string,
  ): Promise<void> {
    const ak = await this.getExisting(akId);
    const newExpireAt = new Date(dto.expireAt);
    if (newExpireAt.getTime() <= ak.expireAt.getTime()) {
      throw BusinessException.of('过期时间只能延后，不能提前');
    }
    await this.raPrisma.raAccessKey.update({
      where: { id: akId },
      data: { expireAt: newExpireAt, updator: operator },
    });
    await this.audit.log(
      'ak.extend',
      operator,
      akId,
      `expireAt -> ${newExpireAt.toISOString()}`,
    );
  }

  /** 凭证可用性判定（Task 12 token 端点消费）。失败 reason 语义：
   * not-found（akId 不存在，含 relationMode=prisma 无外键下的属主悬空行）/
   * disabled / expired（expireAt 动态判定，非存储态）/ bad-secret（sha256
   * 摘要常时比较）。成功路径回带 userId/role/quota（quota 自属主 user.plan
   * 查 PLAN_QUOTA，未知 plan 降级 beta——见 PLAN_QUOTA 头注释裁定） */
  async isAkUsable(akId: string, secretPlain: string): Promise<AkUsableResult> {
    const ak = await this.raPrisma.raAccessKey.findUnique({
      where: { id: akId },
    });
    if (!ak) {
      return { ok: false, reason: 'not-found' };
    }
    if (ak.status !== 'active') {
      return { ok: false, reason: 'disabled' };
    }
    if (ak.expireAt.getTime() <= Date.now()) {
      return { ok: false, reason: 'expired' };
    }
    if (!this.secretMatches(ak.secretHash, secretPlain)) {
      return { ok: false, reason: 'bad-secret' };
    }
    const user = await this.raPrisma.raUser.findUnique({
      where: { id: ak.userId },
    });
    if (!user) {
      return { ok: false, reason: 'not-found' };
    }
    return {
      ok: true,
      userId: user.id,
      role: ak.role,
      quota: PLAN_QUOTA[user.plan] ?? PLAN_QUOTA.beta,
    };
  }

  /** 摘要常时比较（T5 Bearer 比对同款纪律：长度守卫 + timingSafeEqual；
   * 非法 hex 的库存行经长度守卫直接失配，不抛异常） */
  private secretMatches(storedHash: string, secretPlain: string): boolean {
    const computed = Buffer.from(sha256Hex(secretPlain), 'hex');
    const stored = Buffer.from(storedHash, 'hex');
    return (
      stored.length === computed.length && timingSafeEqual(stored, computed)
    );
  }

  /** 取 AK，缺失抛 BusinessException（4040 信封） */
  private async getExisting(akId: string) {
    const ak = await this.raPrisma.raAccessKey.findUnique({
      where: { id: akId },
    });
    if (!ak) {
      throw new BusinessException('AK 不存在', ErrorCodeEnum.NOT_FOUND);
    }
    return ak;
  }
}
