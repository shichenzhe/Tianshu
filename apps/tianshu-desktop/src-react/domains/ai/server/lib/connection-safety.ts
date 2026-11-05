/**
 * 连接安全判定（批3B，design §5 项7/9）：纯函数，无 React/IPC 依赖。
 * - isPlainHttpRemote：http:// 承载且主机不在局域网白名单（回环/私网/
 *   链路本地）——明文直连警示徽标数据（token 与业务面全程明文，局域网
 *   外应 HTTPS；先例：relay E2E plaintext 徽标）
 * - isProtocolOutdated：被控端协议版本低于控制端基线——「建议升级」
 *   数据；缺省 = 老被控端未上报，不告警（增量兼容）
 */
import { PROTOCOL_VERSION } from "@tianshu/protocol";

/** 被控端协议版本过旧（低于控制端基线）；undefined/null=老被控端不告警 */
export function isProtocolOutdated(
  protocolVersion: number | undefined | null,
): boolean {
  return (
    typeof protocolVersion === "number" && protocolVersion < PROTOCOL_VERSION
  );
}

/** 局域网判定（保守白名单）：回环/私网/链路本地放行；非 IP 主机名与
 *  解析失败一律按非局域网（警示方向保守——宁可多警示不漏警示） */
function isLanHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127 || a === 10 || a === 0) return true; // 回环/10/8/未指定
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 169 && b === 254) return true; // 链路本地
    return false;
  }
  // IPv6：回环/未指定/链路本地（fe80::/10）/唯一本地（fc00::/7）；
  // ::ffff:x.y.z.w 为 v4 映射——按内嵌 v4 判
  if (host === "::1" || host === "::") return true;
  const mapped = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return isLanHost(mapped[1]);
  return /^(?:fe[89ab]|f[cd])[0-9a-f]*:/.test(host);
}

/** 明文直连判定：http:// 承载且主机不在局域网白名单（https/wss 恒安全
 *  态；URL 非法不警示——表单校验另行拦截） */
export function isPlainHttpRemote(
  baseUrl: string | undefined | null,
): boolean {
  if (!baseUrl) return false;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  return !isLanHost(url.hostname);
}
