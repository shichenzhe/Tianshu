// 控制端 relay AK 凭证换发——桌面控制端（relay 多租户 Task 17 / spec §5.4
// 消费侧）。与 server-face/renewable-credential.ts（T15 被控端常驻）分域
// 不互引：控制端是短连接语义（同 T16 移动端）——无常驻续期循环，每次
// 建连前就地收口 resolveRelayAccessToken：
// - 存量新鲜（shouldRenew 假、akId/adminUrl 未变）直用，零 admin 请求；
// - 缺失/剩<50%/换绑/换控制平面 → POST {adminUrl}/relay-admin/token（T12 契约：
//   Basic akId:akSecret → data 三元组）换新；
// - 换新瞬态失败（网络/非 401/信封畸形）且存量未过期 → 降级用存量照常连
//   （连接期内 relay 校验兜底）；
// - 401 按 data.reason 分支（四端同构）：disabled/expired/bad-secret /
//   无可用存量 → 失败面（调用方置连接 invalid-token 粘滞态——复用既有
//   凭证失效呈现面，save 重建自愈）；not-found（库重建窗口/akId 漂移
//   中间态）与 body 缺失/不可解析（代理质询、中间盒 401）按瞬态（降级
//   存量或 unavailable——下次请求/激活重建自愈）。
// shouldRenew 自 @tianshu/core 单源（主进程 alias 直引源码——本域
// relay-transport.ts 同款，桌面主进程可直引 core 无需双份）；access 内存
// 态不落盘（进程重启重换，与 T15 被控端口径一致）。
import Log from "../../commons/Log";
import { shouldRenew } from "@tianshu/core";

/** AK 凭证三要素（多租户：换发短效 access，与 static relayToken 并存时
 *  static 优先——调用方解析层短路） */
export interface RelayAkCredentials {
  /** relay-admin 基址（token 端点 = {adminUrl}/relay-admin/token） */
  adminUrl: string;
  akId: string;
  akSecret: string;
}

/** 换发所得 access 记录（内存态——T12 data 三元组 + 签发 akId/adminUrl） */
interface StoredRelayAccess {
  /** 签发该 access 的 akId（凭证换绑即作废——防旧租户 access 被新 AK 复用） */
  akId: string;
  /** 签发该 access 的 relay-admin 基址（换控制平面即作废——同 connId 同
   *  akId 换 adminUrl 后不复用旧 admin 签发的 access，重换覆盖旧档） */
  adminUrl: string;
  accessToken: string;
  /** 过期时刻（epoch ms——T12 契约 data.expiresAt） */
  expiresAt: number;
  maxAgeSec: number;
}

export type RelayAccessOutcome =
  | { ok: true; accessToken: string }
  | { ok: false; reason: "invalid-ak" | "unavailable"; message: string };

/** 三要素齐备判定（部分配置不成 AK 模式——缺一不半启动，T14 同纪律） */
export function akTriplePresent(c: {
  adminUrl?: string;
  akId?: string;
  akSecret?: string;
}): boolean {
  return Boolean(c.adminUrl && c.akId && c.akSecret);
}

/** 内存存量（进程级、连接 id 键控——bearer access 不落盘；连接删除经
 *  clearRelayAccess 清理不留过期凭证） */
const accessStore = new Map<string, StoredRelayAccess>();

/** 清除存量 access（连接删除时） */
export function clearRelayAccess(connId: string): void {
  accessStore.delete(connId);
}

/** 换发请求 IO（fetch/超时可注入；缺省走全局 fetch + 30s） */
export interface RelayAkIo {
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** 401 粘滞凭证失效 reason 集（四端同构分类）：T12 data.reason 命中才是
 * AK 凭证失效粘滞终局；not-found（库重建窗口/akId 配置漂移中间态——
 * 恢复后可自愈）与 body 缺失/不可解析（代理质询、中间盒 401）按瞬态
 * 处理——粘滞会误报"凭证失效"并封死健康连接的重建面 */
const AK_INVALID_401_REASONS = new Set(["disabled", "expired", "bad-secret"]);

/** 401 信封 → 粘滞凭证失效判定（data.reason ∈ 粘滞集；无 body/未知
 * reason → false 按瞬态） */
function isAkInvalid401(payload: unknown): boolean {
  const reason = (
    payload as { data?: { reason?: unknown } } | null
  )?.data?.reason;
  return typeof reason === "string" && AK_INVALID_401_REASONS.has(reason);
}

type RequestOutcome =
  | { ok: true; record: StoredRelayAccess }
  | { ok: false; reason: "invalid-ak" | "transient"; message: string };

/** 单次换发（T12 契约）：POST {adminUrl}/relay-admin/token + Basic 头；
 * 401 按 data.reason 分支（四端同构）：disabled/expired/bad-secret =
 * AK 失效粘滞终局（告警日志单点在此发出）；not-found（库重建窗口/
 * akId 漂移中间态）与 body 缺失/不可解析（代理质询、中间盒 401）按
 * 瞬态；网络/超时/非 401 异常状态/信封畸形同样瞬态（调用方降级存量
 * 或失败收口） */
async function requestAccess(
  creds: RelayAkCredentials,
  io?: RelayAkIo,
): Promise<RequestOutcome> {
  const doFetch: typeof fetch =
    io?.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const authorization = `Basic ${Buffer.from(
    `${creds.akId}:${creds.akSecret}`,
  ).toString("base64")}`;
  let response: Response;
  try {
    response = await doFetch(
      `${creds.adminUrl.replace(/\/+$/, "")}/relay-admin/token`,
      {
        method: "POST",
        headers: { authorization },
        signal: AbortSignal.timeout(
          io?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        ),
      },
    );
  } catch (e) {
    return {
      ok: false,
      reason: "transient",
      message: `token 端点不可达（${creds.adminUrl}）: ${String(e)}`,
    };
  }
  if (response.status === 401) {
    const payload = await response.json().catch(() => null);
    if (isAkInvalid401(payload)) {
      Log.error(
        "[server] relay AK 凭证失效（disabled/expired/bad-secret），需换发后重配",
      );
      return {
        ok: false,
        reason: "invalid-ak",
        message: "AK 凭证失效（401）——请在连接配置中更新 AK 三要素",
      };
    }
    // not-found 或无 body（代理质询/中间盒）——瞬态：降级存量或收口
    // unavailable（下次请求/激活重建自愈），不落 invalid-ak 粘滞
    return {
      ok: false,
      reason: "transient",
      message:
        "token 端点 401（not-found 或无 body——代理质询/中间盒），按瞬态处理",
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: "transient",
      message: `token 端点异常状态 ${response.status}`,
    };
  }
  const payload = (await response
    .json()
    .catch(() => null)) as { data?: Partial<StoredRelayAccess> } | null;
  const data = payload?.data;
  if (
    !data ||
    typeof data.accessToken !== "string" ||
    !data.accessToken ||
    typeof data.expiresAt !== "number" ||
    typeof data.maxAgeSec !== "number"
  ) {
    return {
      ok: false,
      reason: "transient",
      message: "token 端点响应形状非法（缺 data 三元组）",
    };
  }
  return {
    ok: true,
    record: {
      akId: creds.akId,
      adminUrl: creds.adminUrl,
      accessToken: data.accessToken,
      expiresAt: data.expiresAt,
      maxAgeSec: data.maxAgeSec,
    },
  };
}

/**
 * 建连前 access 收口（短连接语义：调用方在每次建连前调用，无常驻循环）。
 * 顶替竞态防线：存量记录随记 akId/adminUrl——换发迟到落地只写本 akId/
 * adminUrl 名下，换绑/换控制平面后的下次解析视旧存量为无（T15 fix-round
 * 教训在本端的等价收口）。
 */
export async function resolveRelayAccessToken(
  connId: string,
  creds: RelayAkCredentials,
  io?: RelayAkIo,
): Promise<RelayAccessOutcome> {
  const now = Date.now();
  const stored = accessStore.get(connId) ?? null;
  // akId 或 adminUrl 不匹配的存量视同没有（换绑/换控制平面后旧 admin 签发
  // 的 access 不可复用——需向当前 admin 重新换发）
  const usable =
    stored !== null &&
    stored.akId === creds.akId &&
    stored.adminUrl === creds.adminUrl
      ? stored
      : null;
  if (usable !== null && !shouldRenew(usable.expiresAt, usable.maxAgeSec, now)) {
    return { ok: true, accessToken: usable.accessToken };
  }
  const renewed = await requestAccess(creds, io);
  if (renewed.ok) {
    accessStore.set(connId, renewed.record);
    Log.info("[server] 已换取 relay access token（AK 凭证）");
    return { ok: true, accessToken: renewed.record.accessToken };
  }
  if (renewed.reason === "invalid-ak") {
    return { ok: false, reason: renewed.reason, message: renewed.message };
  }
  if (usable !== null && usable.expiresAt > now) {
    Log.warn(
      "[server] access 换新失败，降级用未过期存量连接",
      renewed.message,
    );
    return { ok: true, accessToken: usable.accessToken };
  }
  return {
    ok: false,
    reason: "unavailable",
    message: `无可用 relay 凭证（换新失败且无未过期存量）: ${renewed.message}`,
  };
}
