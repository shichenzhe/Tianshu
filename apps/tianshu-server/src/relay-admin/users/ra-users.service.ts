import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RaPrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { BusinessException } from '../../commons/exception/bussiness-exception';
import { ErrorCodeEnum } from '../../commons/exception/error-code.enum';
import {
  RA_DEFAULT_PLAN,
  RaUserCreateDto,
} from './dto/ra-user-create.dto';
import { RaUserDto } from './dto/ra-user.dto';

/** 建户响应：tenantId 建户时生成（randomUUID），即对外租户标识 */
export interface RaUserCreatedResult {
  userId: string;
  tenantId: string;
}

/**
 * relay-admin 租户用户管理（Task 10）：ra_user 纯租户语义（运营方管理员
 * 在 ra_admin_user，Task 9）。所有写操作伴行 AuditService 落审计。
 */
@Injectable()
export class RaUsersService {
  constructor(
    private readonly raPrisma: RaPrismaService,
    private readonly audit: AuditService,
  ) {}

  /** 建户：name 不查重（重名允许——租户标识是 tenantId）；plan 缺省 beta */
  async create(
    dto: RaUserCreateDto,
    operator: string,
  ): Promise<RaUserCreatedResult> {
    const user = await this.raPrisma.raUser.create({
      data: {
        name: dto.name,
        plan: dto.plan ?? RA_DEFAULT_PLAN,
        tenantId: randomUUID(),
        creator: operator,
      },
    });
    await this.audit.log(
      'user.create',
      operator,
      user.id,
      JSON.stringify({ name: user.name, plan: user.plan }),
    );
    return { userId: user.id, tenantId: user.tenantId };
  }

  /** 列表：管理面全量（beta 规模量级小，不分页——收费档位上线时再引入） */
  async list(): Promise<RaUserDto[]> {
    const rows = await this.raPrisma.raUser.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => RaUserDto.create(row));
  }

  /** 禁用：先置用户再级联 AK——中途崩溃时 CRL 名单（Task 12：含 disabled
   * 用户的 tenantId）仍拦得住该租户新连接，fail-closed。级联覆盖该用户全部
   * AK（含先前已 disabled 的，幂等）。
   * TODO(Task 13)：吊销 kick 即时联动——RelayLinkService.kick({tenantId})
   * 接入本路径（失败降级 CRL 兜底，只 warn 不回滚禁用） */
  async disable(userId: string, operator: string): Promise<void> {
    await this.getExisting(userId);
    await this.raPrisma.raUser.update({
      where: { id: userId },
      data: { status: 'disabled', updator: operator },
    });
    const cascaded = await this.raPrisma.raAccessKey.updateMany({
      where: { userId },
      data: { status: 'disabled', updator: operator },
    });
    await this.audit.log('user.disable', operator, userId);
    await this.audit.log(
      'ak.cascade-disable',
      operator,
      userId,
      `cascaded ${cascaded.count} access key(s)`,
    );
  }

  /** 恢复：只恢复用户状态——级联禁用的 AK 不自动恢复（安全侧缺省：操作员
   * 逐个显式 enable，Task 11 提供 per-AK 端点），避免批量禁用后的无差别放行 */
  async enable(userId: string, operator: string): Promise<void> {
    await this.getExisting(userId);
    await this.raPrisma.raUser.update({
      where: { id: userId },
      data: { status: 'active', updator: operator },
    });
    await this.audit.log(
      'user.enable',
      operator,
      userId,
      'access keys not auto-restored',
    );
  }

  /** 取用户，缺失抛 BusinessException（4040 信封） */
  private async getExisting(userId: string) {
    const user = await this.raPrisma.raUser.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new BusinessException('用户不存在', ErrorCodeEnum.NOT_FOUND);
    }
    return user;
  }
}
