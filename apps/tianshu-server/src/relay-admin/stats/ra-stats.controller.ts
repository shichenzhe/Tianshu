import { Controller, Get } from '@nestjs/common';
import { RelayLinkService } from '../relay-link.service';

/** stats/online 响应形状：relayStats 为 relay /internal/stats 载荷原样
 *  透传（{tenants:[...]}），或 relay 不可达时的降级占位
 *  {error:'unreachable'}；fetchedAt 为本端取数时刻（ISO 串） */
export interface RelayOnlineView {
  relayStats:
    | { tenants: Array<{ tenantId: string; servers: number; clients: number }> }
    | { error: 'unreachable' };
  fetchedAt: string;
}

/**
 * relay-admin 在线视图端点（Task 13）：`GET /relay-admin/stats/online`
 * （管理员 JWT——全局 JwtAuthGuard 默认受保护，无 @Public）。
 *
 * **降级形状裁定**：relay 不可达（未配置/网络失败/超时/非 2xx，即
 * RelayLinkService.stats() 返回 null 的全部情形）时 relayStats 落
 * `{error:'unreachable'}` 占位而非抛 BusinessException——观测端点非
 * 关键面，relay 停机不应让管理面 5xx；`error` 标记让前端可区分渲染
 * 「无数据」与「无连接」。fetchedAt 恒在（降级时标记取数尝试时刻，
 * 前端可据此提示视图新鲜度）。两种情形共用同一 unreachable 形状，
 * 不细分原因（运维排障走 relay-link warn 日志，非 API 面）。
 */
@Controller('relay-admin/stats')
export class RaStatsController {
  constructor(private readonly relayLink: RelayLinkService) {}

  @Get('online')
  async online(): Promise<RelayOnlineView> {
    const relayStats = await this.relayLink.stats();
    return {
      relayStats: relayStats ?? { error: 'unreachable' },
      fetchedAt: new Date().toISOString(),
    };
  }
}
