// relay AK 凭证换发——移动端控制端（relay 多租户，T16）。
// **shouldRenew 双份移植声明**（先例 src/transport/e2e-crypto.ts、
// src/logic/plan-view.ts：@tianshu/core 带 langChain peer 依赖不宜进
// metro bundle，纯函数双份落本目录）：原实现
// packages/tianshu-core/src/relay-credential.ts（四端共享单源——server
// relay-client / 桌面 server-face / 本端 / 桌面控制端 transport）。
// 语义由 relay-transport-renew.test.ts 对原实现交叉向量锁定，
// 改任一侧的阈值语义必须双侧同步评审。
//
// 与 T14/T15（常驻端）的差异：移动端短连接无常驻续期循环——每次连接前
// 就地收口（resolveRelayAccessToken）：剩 >50% 直用零 admin 请求；缺失、
// 剩 <50% 或换绑/换控制平面换新；换新瞬态失败且存量未过期降级照常连；401 / 无可用凭证
// 报失效（调用方呈 invalid-token 粘滞态——复用 relay close 4001 语义面，
// 连接页提示重贴 AK）。
import * as SecureStore from "expo-secure-store";
// base64 复用 ./b64 单份——不经 e2e-crypto（expo-crypto 链会扩散到本模块
// 的全部消费方：wire.test 等轻量图不 mock expo-crypto）
import { bytesToB64 } from "./b64";

/** relay AK 凭证三要素（多租户：短效 access 换发，与 static relayToken 并存时 static 优先） */
export interface RelayAkCredentials {
  adminUrl: string;
  akId: string;
  akSecret: string;
}

/** 本地缓存的 access 记录（SecureStore 持久化形态——bearer 凭证不落 AsyncStorage） */
export interface StoredRelayAccess {
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
  | { ok: false; reason: "invalid-ak" | "unavailable" };

/**
 * 剩余寿命 < 半个 maxAge 即应续期（spec §5.4：剩 <50% 触发）。
 * 严格小于：恰剩 50% 不续；已过期（剩余 ≤ 0）必续。
 */
export function shouldRenew(
  expiresAtMs: number,
  maxAgeSec: number,
  nowMs: number,
): boolean {
  return expiresAtMs - nowMs < maxAgeSec * 500;
}

/** 三要素齐备判定（部分配置不成 AK 模式——T14「缺一 null 不半启动」同纪律） */
export function akTriplePresent(c: {
  adminUrl?: string;
  akId?: string;
  akSecret?: string;
}): boolean {
  return Boolean(c.adminUrl && c.akId && c.akSecret);
}

/** Basic 头（手写 base64：RN 无 Buffer，./b64 字节级实现复用） */
function basicAuthHeader(akId: string, akSecret: string): string {
  return `Basic ${bytesToB64(new TextEncoder().encode(`${akId}:${akSecret}`))}`;
}

// —— SecureStore 持久化（access 是 bearer 凭证，钥匙串口径同连接 token） ——

const accessKeyFor = (connId: string) => `tianshu-mobile.relay-access.${connId}`;

/** 读取存量 access（坏档/形状不符按无存量对待）。
 *  adminUrl 有意不做形状校验：旧版档案缺该字段时由此放行，由 usable 的
 *  全等判定（undefined !== string）自然作废重换——迁移即自愈，无需搬档 */
export async function loadRelayAccess(
  connId: string,
): Promise<StoredRelayAccess | null> {
  const raw = await SecureStore.getItemAsync(accessKeyFor(connId)).catch(
    () => null,
  );
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredRelayAccess>;
    if (
      typeof parsed.akId !== "string" ||
      typeof parsed.accessToken !== "string" ||
      typeof parsed.expiresAt !== "number" ||
      typeof parsed.maxAgeSec !== "number"
    ) {
      return null;
    }
    return parsed as StoredRelayAccess;
  } catch {
    return null;
  }
}

async function saveRelayAccess(
  connId: string,
  rec: StoredRelayAccess,
): Promise<void> {
  // 写失败静默：不影响本次连接（下次连接重换）
  await SecureStore.setItemAsync(
    accessKeyFor(connId),
    JSON.stringify(rec),
  ).catch(() => undefined);
}

/** 清除存量 access（连接删除/凭证换绑时——不留孤儿密钥） */
export async function clearRelayAccess(connId: string): Promise<void> {
  await SecureStore.deleteItemAsync(accessKeyFor(connId)).catch(
    () => undefined,
  );
}

/** 换发请求 IO（fetch/超时可注入；缺省走 RN 全局 fetch + 30s） */
export interface RelayAkIo {
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

type RequestOutcome =
  | { ok: true; record: StoredRelayAccess }
  | { ok: false; reason: "invalid-ak" }
  | { ok: false; reason: "transient" };

/** 单次换发（T12 契约）：POST {adminUrl}/relay-admin/token + Basic 头；
 * 401 = AK 失效（disabled/expired）；网络错/非 401/信封畸形按瞬态 */
async function requestAccess(
  creds: RelayAkCredentials,
  io?: RelayAkIo,
): Promise<RequestOutcome> {
  const doFetch: typeof fetch =
    io?.fetch ?? ((input, init) => globalThis.fetch(input, init));
  // admin 挂死不卡连接节奏（abort 后按瞬态降级/失效收口）
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    io?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );
  try {
    const res = await doFetch(
      `${creds.adminUrl.replace(/\/+$/, "")}/relay-admin/token`,
      {
        method: "POST",
        headers: { Authorization: basicAuthHeader(creds.akId, creds.akSecret) },
        signal: controller.signal,
      },
    );
    if (res.status === 401) return { ok: false, reason: "invalid-ak" };
    if (!res.ok) return { ok: false, reason: "transient" };
    const body = (await res.json().catch(() => null)) as {
      data?: Partial<StoredRelayAccess>;
    } | null;
    const data = body?.data;
    if (
      !data ||
      typeof data.accessToken !== "string" ||
      typeof data.expiresAt !== "number" ||
      typeof data.maxAgeSec !== "number"
    ) {
      return { ok: false, reason: "transient" }; // 信封畸形按瞬态
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
  } catch {
    return { ok: false, reason: "transient" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 连接前 access 收口（短连接语义：调用方在每次建连前调用，无常驻循环）：
 * - 存量新鲜（且 akId/adminUrl 未变）→ 直用，零 admin 请求；
 * - 缺失/该换（shouldRenew）/换绑/换控制平面 → 换新并回写 SecureStore；
 * - 换新 401 → invalid-ak（调用方呈 invalid-token 态提示重贴 AK）；
 * - 换新瞬态失败且存量未过期 → 降级用存量（连接期内 relay 校验兜底）；
 * - 无可用存量 → unavailable（不能无凭证连接）。
 */
export async function resolveRelayAccessToken(
  connId: string,
  creds: RelayAkCredentials,
  io?: RelayAkIo,
): Promise<RelayAccessOutcome> {
  const now = Date.now();
  const stored = await loadRelayAccess(connId);
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
    await saveRelayAccess(connId, renewed.record);
    return { ok: true, accessToken: renewed.record.accessToken };
  }
  if (renewed.reason === "invalid-ak") return renewed;
  if (usable !== null && usable.expiresAt > now) {
    return { ok: true, accessToken: usable.accessToken };
  }
  return { ok: false, reason: "unavailable" };
}
