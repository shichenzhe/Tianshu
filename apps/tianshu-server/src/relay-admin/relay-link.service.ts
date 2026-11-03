import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  resolveInternalSecret,
  resolveRelayBaseUrl,
} from './relay-admin-config';

/** relay /internal/stats 响应（Task 5 契约）：按租户聚合的在线连接数
 *  （static 模式无租户记账 → 空数组；tenants 由 relay 按 tenantId 字典序
 *  排序保证输出稳定） */
export interface RelayOnlineStats {
  tenants: Array<{ tenantId: string; servers: number; clients: number }>;
}

/** kick 目标（与 relay /internal/kick 请求体同构）：tenantId 与 ak 至少
 *  一维——relay 侧空目标 400 bad-request，调用方（disable/rotate/user-
 *  disable）恒携带恰一维，不构成放行面 */
export interface KickTarget {
  tenantId?: string;
  ak?: string;
}

/** 单次联动调用超时：relay 僵死时按失败降级，不得挂起管理面写路径
 *  （crl.ts FETCH_TIMEOUT_MS 同款纪律；收紧到 3s——kick 在 disable
 *  请求路径上串行等待，且失败仅是延迟补偿而非功能损失） */
const LINK_TIMEOUT_MS = 3_000;

/** 错误摘要一行化（warn 不打堆栈——降级是预期分支，不是事故现场） */
function summarizeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

/**
 * relay 本体联动通道（Task 13，spec §6 吊销即时面 + 在线视图）：管理面
 * 写路径经本服务调 relay 内部端点（Bearer internalSecret，与 Ed25519
 * 凭证密钥分域——spec §10 同 revocations 端点口径）。
 *
 * **失败降级是核心契约**：任何失败（未配置/网络错/超时/非 2xx/坏载荷）
 * 一律返回 null，**不向调用方抛异常、不回滚已落库的禁用**——CRL 周期
 * 拉取（crl.ts）兜住 kick 丢失场景（relay 重启、网络分区下名单自愈），
 * 回滚禁用反而制造「凭证已泄露但连接保留」的更大放行面。因此本服务
 * 不落审计（禁用动作自身的审计行已存在；relay 侧调用是同一动作的
 * 附属面，不是独立管理操作）。
 *
 * 配置（Task 12 已登记单源，本任务消费）：env RA_RELAY_BASE_URL /
 * RA_INTERNAL_SECRET > yml relayAdmin.relayBaseUrl / internalSecret；
 * relayBaseUrl 无缺省值——缺失视为**联动关闭**（kick/stats 静默降级
 * null，启动时单次 warn 声明，管理面写不受影响），保持无 relay 的
 * dev/test 环境可用。逐请求解析（revocations 同款纪律：改 env 即生效）。
 */
@Injectable()
export class RelayLinkService implements OnModuleInit {
  constructor(private readonly configService: ConfigService) {}

  /** 启动体检：联动不可用时单次 warn（运行期不再重复——每次 kick 失败
   *  的 warn 已逐次声明状态） */
  onModuleInit(): void {
    const baseUrl = resolveRelayBaseUrl(this.configService);
    if (!baseUrl) {
      console.warn(
        '[relay-link] 未配置 RA_RELAY_BASE_URL（env 或 config.yml relayAdmin.relayBaseUrl）——kick/stats 联动关闭：吊销即时拆除不可用（禁用仍生效，CRL 补偿兜底）',
      );
      return;
    }
    if (!resolveInternalSecret(this.configService)) {
      console.warn(
        '[relay-link] 已配置 relayBaseUrl 但缺 RA_INTERNAL_SECRET——kick/stats 将鉴权失败降级（CRL 名单端点亦 fail-closed），请补齐控制信道秘密',
      );
    }
  }

  /** 即时吊销联动：POST {relayBaseUrl}/internal/kick。返回 relay 侧
   *  目标匹配拆除数（kicked 只计目标匹配连接——server 拆除时被配对
   *  4003 连带拆除的 client 不计入，Task 5 已裁定的计数口径）。失败
   *  → null（降级语义见类注释） */
  async kick(target: KickTarget): Promise<{ kicked: number } | null> {
    const body = await this.fetchRelay('POST', '/internal/kick', target);
    if (body === null) return null;
    const kicked = (body as { kicked?: unknown }).kicked;
    if (typeof kicked !== 'number') {
      console.warn(
        '[relay-link] kick 响应载荷非法（kicked 非数字），按失败降级',
      );
      return null;
    }
    return { kicked };
  }

  /** 在线连接聚合：GET {relayBaseUrl}/internal/stats。失败 → null
   *  （stats/online 端点据此降级为 {error:'unreachable'}） */
  async stats(): Promise<RelayOnlineStats | null> {
    const body = await this.fetchRelay('GET', '/internal/stats');
    if (body === null) return null;
    const tenants = (body as { tenants?: unknown }).tenants;
    if (!Array.isArray(tenants)) {
      console.warn(
        '[relay-link] stats 响应载荷非法（tenants 非数组），按失败降级',
      );
      return null;
    }
    return { tenants };
  }

  /** 共享传输层：配置齐备 → fetch（3s 超时，Bearer internalSecret）→
   *  2xx JSON 体；未配置/任何失败 → null（unknown 含 null——判空即失败
   *  分支，调用方各自做载荷形状校验） */
  private async fetchRelay(
    method: 'GET' | 'POST',
    path: string,
    jsonBody?: KickTarget,
  ): Promise<unknown> {
    const baseUrl = resolveRelayBaseUrl(this.configService);
    const internalSecret = resolveInternalSecret(this.configService);
    if (!baseUrl || !internalSecret) return null;
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${internalSecret}`,
          ...(jsonBody === undefined
            ? {}
            : { 'content-type': 'application/json' }),
        },
        body: jsonBody === undefined ? undefined : JSON.stringify(jsonBody),
        signal: AbortSignal.timeout(LINK_TIMEOUT_MS),
      });
      if (!response.ok) {
        console.warn(
          `[relay-link] ${method} ${path} 失败：HTTP ${response.status}（降级，CRL 兜底）`,
        );
        return null;
      }
      return await response.json();
    } catch (error) {
      console.warn(
        `[relay-link] ${method} ${path} 失败：${summarizeError(error)}（降级，CRL 兜底）`,
      );
      return null;
    }
  }
}
