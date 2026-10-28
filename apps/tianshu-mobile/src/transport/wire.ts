import { activeTransport } from "../store/connections.store";
import type { Transport, TransportRequestResult } from "./types";

/**
 * 统一 wire 请求出口（T15 组件层共用）：与 sessions/stream store 内私有
 * request 同判 body.success（HTTP 200 亦可能业务错——server-face 契约），
 * 差异在业务错保留 code（"4040" 审批已应答/图片不存在等，调用方需区分
 * 提示文案）。transport 参数留作单测注入，缺省取活动连接。
 */
export type WireResult =
  | { ok: true; data: unknown }
  | { ok: false; code: string; message: string; status?: number };

/** 端点缺失判定（AR 批）：被控端未实现该路由时 HTTP 404 无业务体——
 *  transport status 透出后调用方可与网络错误区分（隐藏视图 vs 可重试） */
export function isEndpointMissing(result: WireResult): boolean {
  return !result.ok && result.status === 404;
}

export async function wireRequest(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  transport: Transport | null = activeTransport(),
): Promise<WireResult> {
  if (!transport) return { ok: false, code: "", message: "" };
  try {
    const result: TransportRequestResult = await transport.request(
      method,
      path,
      body,
    );
    if (typeof result.body !== "object" || result.body === null) {
      return { ok: false, code: "", message: "", status: result.status };
    }
    const b = result.body as {
      success?: unknown;
      data?: unknown;
      code?: unknown;
      message?: unknown;
    };
    if (b.success !== true) {
      return {
        ok: false,
        code: typeof b.code === "string" ? b.code : "",
        message: typeof b.message === "string" ? b.message : "",
        status: result.status,
      };
    }
    return { ok: true, data: b.data ?? null };
  } catch {
    // 网络层异常（direct 模式 fetch reject / relay 超时 status 0 无 body）
    return { ok: false, code: "", message: "" };
  }
}
