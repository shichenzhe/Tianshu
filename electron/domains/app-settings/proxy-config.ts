/**
 * 代理配置纯函数：参数校验/持久化键值转换/Electron session 配置映射、
 * 主进程 undici dispatcher 形态映射。不依赖 electron/undici，可直测。
 */
import { OPTION_NAMES } from "./option-store";

/** 代理模式：direct 直连 / system 跟随系统 / proxy 指定代理服务器 */
export type ProxyMode = "direct" | "system" | "proxy";

/** 归一后的代理参数（proxy 模式保证 host 非空、port 为合法端口） */
export interface ProxyParams {
  mode: ProxyMode;
  host?: string;
  port?: number;
}

/** 入参校验结果（error 为渲染层可直接映射的错误码） */
export type ProxyValidation =
  | { ok: true; params: ProxyParams }
  | { ok: false; error: "INVALID_PROXY_MODE" | "INVALID_PROXY_CONFIG" };

/** mode 合法值集合 */
const PROXY_MODES: ReadonlySet<string> = new Set(["direct", "system", "proxy"]);

/** 代理规则串：http://host:port（session.proxyRules 与 ProxyAgent uri 共用格式） */
export function toProxyRules(host: string, port: number): string {
  return `http://${host}:${port}`;
}

/** 入参校验与归一：mode 必须合法；proxy 模式必须有 host 且端口为 1-65535 整数 */
export function normalizeProxyParams(input: {
  mode: unknown;
  host?: unknown;
  port?: unknown;
}): ProxyValidation {
  if (typeof input.mode !== "string" || !PROXY_MODES.has(input.mode)) {
    return { ok: false, error: "INVALID_PROXY_MODE" };
  }
  if (input.mode !== "proxy") {
    return { ok: true, params: { mode: input.mode as ProxyMode } };
  }
  const host = typeof input.host === "string" ? input.host.trim() : "";
  const port = input.port;
  const hostOk = host !== "" && !/[\s/]/.test(host);
  const portOk =
    typeof port === "number" &&
    Number.isInteger(port) &&
    port > 0 &&
    port < 65536;
  if (!hostOk || !portOk) {
    return { ok: false, error: "INVALID_PROXY_CONFIG" };
  }
  return { ok: true, params: { mode: "proxy", host, port } };
}

/** mode 字符串归一：缺省/非法回退 system（Chromium 缺省即跟随系统） */
export function parseProxyMode(raw: string | undefined): ProxyMode {
  return raw !== undefined && PROXY_MODES.has(raw)
    ? (raw as ProxyMode)
    : "system";
}

/** 持久化键值对（option 表 name/value；direct/system 也写全三键清残留） */
export function proxyParamsToOptions(
  params: ProxyParams,
): Array<{ name: string; value: string }> {
  return [
    { name: OPTION_NAMES.proxyMode, value: params.mode },
    { name: OPTION_NAMES.proxyHost, value: params.host ?? "" },
    {
      name: OPTION_NAMES.proxyPort,
      value: params.port != null ? String(params.port) : "",
    },
  ];
}

/** 持久化映射读回参数：缺省 system；proxy 模式 host/port 畸形时降级 system */
export function proxyOptionsToParams(map: Map<string, string>): ProxyParams {
  const mode = parseProxyMode(map.get(OPTION_NAMES.proxyMode));
  if (mode !== "proxy") {
    return { mode };
  }
  const host = map.get(OPTION_NAMES.proxyHost) ?? "";
  const port = Number(map.get(OPTION_NAMES.proxyPort));
  const portOk = Number.isInteger(port) && port > 0 && port < 65536;
  if (host === "" || !portOk) {
    return { mode: "system" };
  }
  return { mode, host, port };
}

/** Electron session.setProxy 入参形态（渲染进程/内置页请求走此层） */
export type SessionProxyConfig =
  { mode: "direct" } | { mode: "system" } | { proxyRules: string };

/** direct/system 用 mode，proxy 用 proxyRules；host/port 缺失降级 system */
export function toSessionProxyConfig(params: ProxyParams): SessionProxyConfig {
  if (params.mode === "proxy" && params.host && params.port != null) {
    return { proxyRules: toProxyRules(params.host, params.port) };
  }
  return { mode: params.mode === "direct" ? "direct" : "system" };
}

/** undici 全局 dispatcher 形态：direct=普通 Agent / system=按环境变量 / proxy=代理 uri */
export type DispatcherSpec =
  { kind: "direct" } | { kind: "env" } | { kind: "proxy"; uri: string };

export function toDispatcherSpec(params: ProxyParams): DispatcherSpec {
  if (params.mode === "proxy" && params.host && params.port != null) {
    return { kind: "proxy", uri: toProxyRules(params.host, params.port) };
  }
  return params.mode === "direct" ? { kind: "direct" } : { kind: "env" };
}
