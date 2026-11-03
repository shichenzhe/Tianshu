// AK 凭证续期模块（relay 多租户 Task 15 / spec §5.4 消费侧）：
// tianshu-server relay-client（T14）语义的桌面被控端同构实现——AK 三要素
// （adminUrl/akId/akSecret）→ relay-admin token 端点（T12 契约）Basic 换
// access；内存三元组（进程重启重换，不落盘）+ 10min 巡检 shouldRenew
// （@tianshu/core 单源）低频换新。401 = AK 失效粘滞终局（启动侧干净失败
// / 续期侧经 onStaleInvalid 断开不重连——重连只会复现同一终局）；网络/
// 非 401 异常态 30s 起指数退避封顶 10min。mobile/桌面控制端（Task 16/17）
// 无法共享 electron 侧文件——各自实现但语义对齐本模块。
import Log from "../../commons/Log";
import { shouldRenew } from "@tianshu/core";

/** 续期巡检间隔（spec §5.4：低频巡检，shouldRenew 真值才换） */
const RENEW_CHECK_INTERVAL_MS = 10 * 60 * 1000;
/** 换 access 退避：30s 起、指数翻倍封顶 10min（网络/服务异常用） */
const AK_RETRY_BASE_MS = 30_000;
const AK_RETRY_MAX_MS = 10 * 60 * 1000;
/** 单次 token 请求超时（挂死请求按瞬态失败进退避，不卡死巡检循环） */
const AK_REQUEST_TIMEOUT_MS = 30_000;

/** AK 凭证三要素（Task 15：relay-admin token 端点消费面） */
export interface RelayAkCredentials {
  /** relay-admin 基址（token 端点 = {adminUrl}/relay-admin/token） */
  adminUrl: string;
  akId: string;
  akSecret: string;
}

export interface RenewableCredentialOptions {
  /** 续期巡检间隔（缺省 10min；测试注入） */
  renewCheckIntervalMs?: number;
  /** 换 access 退避基数（缺省 30s 封顶 10min；测试注入） */
  akRetryBaseMs?: number;
  /** 续期侧 401（AK 失效）粘滞终局回调：调用方断开 relay 且不再重连 */
  onStaleInvalid?: () => void;
}

export interface RenewableCredential {
  /** 当前 access（未换发/已停止 null——auth 首帧发帧时取值：续期换新
   *  后即新值，非启动时快照） */
  currentToken(): string | null;
  /** 启动期换 access：循环退避直至成功；401 直接抛（干净启动失败，
   *  绝不无凭证连接）；实例 stop（停用/被新实例顶替）即放弃 */
  ensureAccess(): Promise<void>;
  /** 起续期巡检循环（幂等） */
  startRenewLoop(): void;
  /** 停止收口：清计时器 + 后续换发/巡检全部放弃（幂等） */
  stop(): void;
}

/** access 三元组（内存态——T12 RaTokenIssuedResult 的客户端对偶） */
interface AkAccess {
  token: string;
  expiresAt: number;
  maxAgeSec: number;
}

/** token 端点统一信封（管理面 ResponseInterceptor 包装 {code,message,data}；
 * 四端只消费 data 三元组） */
interface TokenEnvelope {
  data?: {
    accessToken?: unknown;
    expiresAt?: unknown;
    maxAgeSec?: unknown;
  };
}

/** 401（AK 失效——disabled/expired/bad-secret）专属错误类：粘滞终局，
 * 不进退避重试（启动侧干净失败、续期侧断开不重连） */
class AkCredentialInvalidError extends Error {
  constructor() {
    super("AK 凭证失效（disabled/expired），relay 客户端未启动或已断开");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 换 access 退避延迟：base 起指数翻倍封顶 10min（attempt 从 1 起） */
function akRetryDelayMs(base: number, attempt: number): number {
  return Math.min(base * 2 ** (attempt - 1), AK_RETRY_MAX_MS);
}

/** AK → access 换发（T12 端点）：POST {adminUrl}/relay-admin/token +
 * Basic base64(akId:akSecret)；成功读统一信封 data 三元组。401 = AK
 * 失效（告警日志单点在此发出）；网络/超时/非 401 异常状态/信封畸形均按
 * 瞬态抛 Error，由调用方退避重试 */
async function requestAccess(config: RelayAkCredentials): Promise<AkAccess> {
  const authorization = `Basic ${Buffer.from(
    `${config.akId}:${config.akSecret}`,
  ).toString("base64")}`;
  let response: Response;
  try {
    response = await fetch(
      `${config.adminUrl.replace(/\/+$/, "")}/relay-admin/token`,
      {
        method: "POST",
        headers: { authorization },
        signal: AbortSignal.timeout(AK_REQUEST_TIMEOUT_MS),
      },
    );
  } catch (e) {
    throw new Error(`token 端点不可达（${config.adminUrl}）: ${String(e)}`);
  }
  if (response.status === 401) {
    Log.error(
      "[server-face] AK 凭证失效（disabled/expired），需运营方恢复或换发",
    );
    throw new AkCredentialInvalidError();
  }
  if (!response.ok) {
    throw new Error(`token 端点异常状态 ${response.status}`);
  }
  const payload = (await response
    .json()
    .catch(() => null)) as TokenEnvelope | null;
  const data = payload?.data;
  if (
    !data ||
    typeof data.accessToken !== "string" ||
    !data.accessToken ||
    typeof data.expiresAt !== "number" ||
    typeof data.maxAgeSec !== "number"
  ) {
    throw new Error("token 端点响应形状非法（缺 data 三元组）");
  }
  return {
    token: data.accessToken,
    expiresAt: data.expiresAt,
    maxAgeSec: data.maxAgeSec,
  };
}

/**
 * 续期凭证实例（闭包态——每个 relay 启动一个；被顶替即 stop，实例级
 * stopped 标记使在途 ensureAccess/巡检自知放弃，不动新实例状态）。
 */
export function createRenewableCredential(
  config: RelayAkCredentials,
  options: RenewableCredentialOptions = {},
): RenewableCredential {
  const retryBaseMs = options.akRetryBaseMs ?? AK_RETRY_BASE_MS;
  const checkIntervalMs =
    options.renewCheckIntervalMs ?? RENEW_CHECK_INTERVAL_MS;
  let access: AkAccess | null = null;
  let stopped = false;
  let renewTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAttempts = 0;

  function clearRenewTimer(): void {
    if (renewTimer) {
      clearTimeout(renewTimer);
      renewTimer = null;
    }
  }

  /** 停止收口（闭包级——renewTick 粘滞路径与对外 stop() 同一实现） */
  function doStop(): void {
    stopped = true;
    clearRenewTimer();
  }

  /** 排下一轮巡检（unref——10min 节奏不持活进程） */
  function scheduleRenewTick(): void {
    if (stopped) return;
    renewTimer = setTimeout(() => {
      renewTimer = null;
      void renewTick();
    }, checkIntervalMs);
    renewTimer.unref?.();
  }

  /** 续期巡检：shouldRenew（core 单源）真值才换新。换新成功只更新内存
   * （存量连接不拆——D5 语义：access 到期只拦新连接，auth 首帧发帧时经
   * currentToken() 取新值）；401 = AK 失效 → 粘滞终局：停巡检 + 交调用方
   * 断开且不再重连；网络失败退避重试且不动连接 */
  async function renewTick(): Promise<void> {
    if (stopped || !access) return;
    if (!shouldRenew(access.expiresAt, access.maxAgeSec, Date.now())) {
      scheduleRenewTick();
      return;
    }
    try {
      const next = await requestAccess(config);
      // 停止/顶替竞态：迟到的换新不落地（新启动自带自己的首轮换发）
      if (stopped) return;
      access = next;
      retryAttempts = 0;
      Log.info("[server-face] relay access token 已续期");
      scheduleRenewTick();
    } catch (e) {
      if (stopped) return;
      if (e instanceof AkCredentialInvalidError) {
        doStop();
        options.onStaleInvalid?.();
        return;
      }
      retryAttempts += 1;
      const delay = akRetryDelayMs(retryBaseMs, retryAttempts);
      Log.warn(`[server-face] access 续期失败，${delay}ms 后重试`, e);
      renewTimer = setTimeout(() => {
        renewTimer = null;
        void renewTick();
      }, delay);
      renewTimer.unref?.();
    }
  }

  return {
    currentToken: () => access?.token ?? null,
    async ensureAccess(): Promise<void> {
      let attempt = 0;
      for (;;) {
        if (stopped) {
          throw new Error("AK 凭证通道已停止，放弃换取 access");
        }
        try {
          access = await requestAccess(config);
          Log.info("[server-face] 已换取 relay access token");
          return;
        } catch (e) {
          if (e instanceof AkCredentialInvalidError) throw e;
          attempt += 1;
          const delay = akRetryDelayMs(retryBaseMs, attempt);
          Log.warn(`[server-face] 换取 access 失败，${delay}ms 后重试`, e);
          await sleep(delay);
        }
      }
    },
    startRenewLoop(): void {
      if (stopped) return;
      clearRenewTimer();
      scheduleRenewTick();
    },
    stop: doStop,
  };
}
