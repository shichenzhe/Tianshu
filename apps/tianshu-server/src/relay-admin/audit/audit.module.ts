import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/** relay-admin 审计模块（RaPrismaModule 同款 @Global 形态）：users（T10）、
 * aks（T11）、token/revocations 等后续管理面模块免逐个 import 即可注入
 * AuditService——所有管理写操作的强制伴行依赖 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class RaAuditModule {}
