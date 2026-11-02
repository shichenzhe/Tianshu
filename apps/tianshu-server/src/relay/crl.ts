/**
 * CRL 吊销名单拉取（多租户批 Task 6，spec §4.4 吊销补偿路径）：即时拆
 * 存量走 /internal/kick（Task 5），本模块负责补偿面——周期从控制平面
 * 拉全量吊销名单，首帧 auth 验签通过后比对，命中即拒（接线在
 * relay-main：jwt 模式注入 createJwtAuthenticator 的 isRevoked）。覆盖
 * kick 丢失场景（relay 重启、网络分区下名单自愈）。
 *
 * 停机语义（spec §5.3/§5.4 契约，业界主流对齐）：拉取失败 fail-static
 * （维持现有名单）为缺省——控制平面停机不影响存量连接与（access 未
 * 过期的）离线验签重连；可配 fail-close（连续 N 次失败后 isNewConnDenied
 * 返回 true，relay-main 据此在 admit 时拒**新**连接）——只拒新、永不拆
 * 存量：鉴权是连接建立时的一次性裁决，本 store 只在 admit 时被消费。
 */

/** CRL store：名单查询 + 拉取生命周期。isNewConnDenied 为 fail-close
 *  触发态查询（relay-main 拒新连接用；failCloseAfter=0 恒 false） */
export interface CrlStore {
  isRevoked(t: { tid?: string; ak?: string }): boolean;
  isNewConnDenied(): boolean;
  start(): void;
  stop(): void;
}

/** 拉取周期缺省 45s（spec §4.4 的 30–60s 区间中值） */
const DEFAULT_INTERVAL_MS = 45_000;
/** 单次拉取超时：控制平面僵死时按失败计，不得挂起周期轮询 */
const FETCH_TIMEOUT_MS = 5_000;

export function createCrlStore(opts: {
  adminUrl: string;
  internalSecret: string;
  /** 拉取周期 ms（缺省 45s；测试注入缩短） */
  intervalMs?: number;
  /** 连续失败阈值（缺省 0=fail-static；>0 触发后拒新连接） */
  failCloseAfter?: number;
}): CrlStore {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const failCloseAfter = opts.failCloseAfter ?? 0;
  const endpoint = `${opts.adminUrl.replace(/\/+$/, '')}/relay-admin/revocations`;
  let revokedAk = new Set<string>();
  let revokedTenant = new Set<string>();
  let consecutiveFailures = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let fetching = false;
  let stopped = false;

  /** 单次拉取：2xx + 双数组字段合法 → 全量替换名单并复位失败计数；
   *  其余一律按失败计（fail-static：名单不动）。串行互斥保证同一时刻
   *  至多一个在途——「下一次请求发出 ⇒ 上一次响应已应用」是测试同步门 */
  async function refresh(): Promise<void> {
    if (fetching || stopped) return;
    fetching = true;
    try {
      const res = await fetch(endpoint, {
        headers: { authorization: `Bearer ${opts.internalSecret}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = parseList(await res.json());
      if (!list) throw new Error('bad-payload');
      revokedAk = new Set(list.revokedAk);
      revokedTenant = new Set(list.revokedTenant);
      consecutiveFailures = 0;
    } catch {
      consecutiveFailures += 1;
      // 恰在触发点告警一次（此后持续失败不再刷屏；恢复无需报喜）
      if (failCloseAfter > 0 && consecutiveFailures === failCloseAfter)
        console.warn(
          `[crl] 连续 ${consecutiveFailures} 次拉取失败，fail-close 生效：拒绝新连接（存量不动）`,
        );
    } finally {
      fetching = false;
    }
  }

  return {
    isRevoked({ tid, ak }) {
      if (ak !== undefined && revokedAk.has(ak)) return true;
      return tid !== undefined && revokedTenant.has(tid);
    },
    isNewConnDenied() {
      return failCloseAfter > 0 && consecutiveFailures >= failCloseAfter;
    },
    start() {
      stopped = false;
      void refresh(); // 立即首拉，不等满一个周期（冷启动尽快拿到名单）
      if (timer !== undefined) clearInterval(timer); // 重复 start 防泄漏
      timer = setInterval(() => void refresh(), intervalMs);
      timer.unref(); // 后台轮询不阻进程退出
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}

/** 名单响应形状校验（Task 12 契约 {epoch, revokedAk, revokedTenant}）：
 *  epoch 单调递增仅供观测，此处不据此门控——串行拉取下后到响应即最新；
 *  双数组字段缺失/非字符串数组视为坏载荷（按拉取失败计） */
function parseList(
  body: unknown,
): { revokedAk: string[]; revokedTenant: string[] } | null {
  if (typeof body !== 'object' || body === null) return null;
  const source = body as Record<string, unknown>;
  if (!isStringArray(source.revokedAk)) return null;
  if (!isStringArray(source.revokedTenant)) return null;
  return { revokedAk: source.revokedAk, revokedTenant: source.revokedTenant };
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}
