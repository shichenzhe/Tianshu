import { Injectable } from '@nestjs/common';
import { RaPrismaService } from '../prisma.service';
import { RaAuditLog } from '../generated/prisma';

/**
 * relay-admin 管理操作审计（Task 10）：所有管理写操作（建户/禁用/发 AK/续期
 * 等）统一经本服务落 ra_audit_log——append-only，仅 createdAt（schema 注释
 * 同款语义）。renew 高频换 token 不记（spec §6）。
 */
@Injectable()
export class AuditService {
  constructor(private readonly raPrisma: RaPrismaService) {}

  /** 审计落库。operator 为管理员 username（单值语义，schema 审计字段同源）；
   * target 为操作对象标识（userId/akId 等）；detail 可选自由文本 */
  async log(
    action: string,
    operator: string,
    target: string,
    detail?: string,
  ): Promise<RaAuditLog> {
    return this.raPrisma.raAuditLog.create({
      data: { action, operator, target, detail: detail ?? null },
    });
  }
}
