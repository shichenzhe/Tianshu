import { ENDPOINTS, type RemoteInstanceInfo } from "@tianshu/protocol";
import { createDirectTransport } from "./direct-transport";
import { akTriplePresent, resolveRelayAccessToken } from "./relay-ak";
import { createRelayTransport } from "./relay-transport";
import type { Transport, TransportRequestResult } from "./types";

export interface ConnectionConfig {
  id: string;
  name: string;
  mode: "direct" | "relay";
  baseUrl?: string;
  token?: string;
  relayUrl?: string;
  relayToken?: string;
  connectionId?: string;
  /** —— relay AK 凭证三要素（多租户，T16）：换发短效 access 连接——
   *  与 relayToken 并存时 static 优先（在场零 admin 请求）；三要素齐备
   *  才成 AK 模式，部分配置按无效处理（isValidConfig 门禁） */
  adminUrl?: string;
  akId?: string;
  akSecret?: string;
  /** relay e2e 模式（安全批 H）：auto（缺省）=握手无 ack 降级明文；
   *  required=拒降级直接断开。direct 连接忽略 */
  e2eMode?: "auto" | "required";
  /** 已存被控端 e2e 指纹（TOFU 首连空缺省；ack 不匹配即断 mitm-suspect） */
  fingerprint?: string;
}

export type TestResult =
  | { ok: true; info: RemoteInstanceInfo }
  | { ok: false; reason: "invalid-config" | "invalid-token" | "unreachable" | "timeout" };

export function isValidConfig(c: ConnectionConfig): boolean {
  if (c.mode === "direct") return Boolean(c.baseUrl && c.token);
  // relay：static relayToken 或 AK 三要素任一成凭证（部分 AK 配置无效）
  return Boolean(
    c.relayUrl && c.connectionId && (c.relayToken || akTriplePresent(c)),
  );
}

/** activate 层注入钩子（TOFU 指纹回填——store 写回 config 并持久化） */
export interface CreateTransportHooks {
  onFingerprintPinned?: (fingerprint: string) => void;
}

/**
 * relay 地址 scheme 校验（安全批 H；桌面批二 B7 同款判定）：
 * - wss:// 任意地址放行；
 * - ws:// 仅 loopback/私网**字面 IP** 放行（内网直连场景；域名一律视为
 *   公网——无 DNS 解析，与桌面侧一致）；
 * - 其余 scheme 拒。
 * 返回 true=放行；"public-plaintext"=公网明文拒绝；"invalid-scheme"=非 ws(s)。
 */
export function validateRelayUrlScheme(
  relayUrl: string,
): true | "public-plaintext" | "invalid-scheme" {
  if (!/^wss?:\/\//.test(relayUrl)) return "invalid-scheme";
  if (relayUrl.startsWith("wss://")) return true;
  let host = "";
  try {
    host = new URL(relayUrl).hostname.toLowerCase();
  } catch {
    return "invalid-scheme";
  }
  const isPrivateLiteral =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  return isPrivateLiteral ? true : "public-plaintext";
}

export function createTransport(
  c: ConnectionConfig,
  hooks?: CreateTransportHooks,
): Transport {
  return c.mode === "direct"
    ? createDirectTransport({ baseUrl: c.baseUrl!, token: c.token! })
    : createRelayTransport({
        relayUrl: c.relayUrl!,
        relayToken: c.relayToken!,
        connectionId: c.connectionId!,
        ...(c.e2eMode ? { e2eMode: c.e2eMode } : {}),
        ...(c.fingerprint ? { fingerprint: c.fingerprint } : {}),
        ...(hooks?.onFingerprintPinned
          ? { onFingerprintPinned: hooks.onFingerprintPinned }
          : {}),
      });
}

export function classifyTestFailure(r: TransportRequestResult): Exclude<TestResult, { ok: true }>["reason"] {
  if (r.status === 401) return "invalid-token";
  const body = r.body as { code?: string } | null;
  if (r.status === 200 && body?.code === "4010") return "invalid-token";
  if (r.status === 0) return "timeout";
  return "unreachable";
}

/** 测试连接：AK 模式先连接前换新（static 优先——relayToken 在场零 admin
 *  请求），临时 transport GET info，8s 超时，随后关闭。AK 失效（401）→
 *  invalid-token；无可用凭证（无存量+网络失败）→ unreachable */
export async function testConnection(c: ConnectionConfig): Promise<TestResult> {
  if (!isValidConfig(c)) return { ok: false, reason: "invalid-config" };
  let cfg = c;
  if (c.mode === "relay" && !c.relayToken) {
    const outcome = await resolveRelayAccessToken(c.id, {
      adminUrl: c.adminUrl!,
      akId: c.akId!,
      akSecret: c.akSecret!,
    });
    if (!outcome.ok) {
      return {
        ok: false,
        reason: outcome.reason === "invalid-ak" ? "invalid-token" : "unreachable",
      };
    }
    cfg = { ...c, relayToken: outcome.accessToken };
  }
  const t = createTransport(cfg);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      t.request("GET", ENDPOINTS.info),
      new Promise<TransportRequestResult>((r) => {
        timer = setTimeout(() => r({ status: 0, body: null }), 8_000);
      }),
    ]);
    const body = res.body as RemoteInstanceInfo & { success?: boolean; data?: RemoteInstanceInfo } | null;
    if (res.status === 200 && body?.success && body.data) {
      // username 缺省（旧被控端）归一 null——控制端按未知显示
      return {
        ok: true,
        info: { ...body.data, username: body.data.username ?? null },
      };
    }
    return { ok: false, reason: classifyTestFailure(res) };
  } catch {
    // direct 模式 request 会真 reject（fetch 连接层失败/非 JSON body 抛出），
    // race 会把异常直抛调用方——网络级失败归 unreachable（relay 的 request
    // 永不 reject，不受影响）
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(timer); // 请求先回即清 race 定时器，防 8s 悬挂
    t.close();
  }
}
