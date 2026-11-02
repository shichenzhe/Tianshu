import { Global, Module } from '@nestjs/common';
import { RelayLinkService } from './relay-link.service';

/** relay 联动基础设施模块（Task 13，RaPrismaModule/RaAuditModule 同款
 *  @Global 形态）：kick 是一切吊销类写操作（ak.disable / ak.rotate-secret
 *  / user.disable）的强制伴行面（与 audit 伴行同级），加上 stats 视图
 *  消费方——aks/users/stats 免逐个 import 即可注入 RelayLinkService */
@Global()
@Module({
  providers: [RelayLinkService],
  exports: [RelayLinkService],
})
export class RelayLinkModule {}
