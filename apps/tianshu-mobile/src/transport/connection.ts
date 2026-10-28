import { ENDPOINTS, type RemoteInstanceInfo } from "@tianshu/protocol";
import { createDirectTransport } from "./direct-transport";
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
}

export type TestResult =
  | { ok: true; info: RemoteInstanceInfo }
  | { ok: false; reason: "invalid-config" | "invalid-token" | "unreachable" | "timeout" };

export function isValidConfig(c: ConnectionConfig): boolean {
  if (c.mode === "direct") return Boolean(c.baseUrl && c.token);
  return Boolean(c.relayUrl && c.relayToken && c.connectionId);
}

export function createTransport(c: ConnectionConfig): Transport {
  return c.mode === "direct"
    ? createDirectTransport({ baseUrl: c.baseUrl!, token: c.token! })
    : createRelayTransport({ relayUrl: c.relayUrl!, relayToken: c.relayToken!, connectionId: c.connectionId! });
}

export function classifyTestFailure(r: TransportRequestResult): Exclude<TestResult, { ok: true }>["reason"] {
  if (r.status === 401) return "invalid-token";
  const body = r.body as { code?: string } | null;
  if (r.status === 200 && body?.code === "4010") return "invalid-token";
  if (r.status === 0) return "timeout";
  return "unreachable";
}

/** 测试连接：临时 transport GET info，8s 超时，随后关闭 */
export async function testConnection(c: ConnectionConfig): Promise<TestResult> {
  if (!isValidConfig(c)) return { ok: false, reason: "invalid-config" };
  const t = createTransport(c);
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
