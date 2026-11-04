// 直连承载（T13）：fetch + SSE 手写流解析 + 指数退避重连（1s 起、30s 封顶）。
// - request：POST/GET → starter 包装体原样透传 {status,body}（判错在上层
//   查 body.success——transport.ts 头注释契约）；15s AbortSignal.timeout
//   兜死挂请求（spec §13 项 3——超时抛含「超时/TIMEOUT」可判错误；
//   仅限 request，与 SSE 建流/长流无关）
// - SSE：GET /event（手写流解析无 EventSource 限制，Bearer 头鉴权）；重连
//   后重新 GET 自然全量流——首帧 server.connected 重发，控制端无需增量补齐
// - 静默死链：idleTimeoutMs（默认 60s）无入站字节即判死主动重连（被控端
//   SSE 25s `: ping` 心跳设计下 60s 无字节 = 死链；与 T14 relay 活性同款）
// - 运行面：Electron 44 主进程 Node 24 全局 fetch/ReadableStream（实测可用，
//   无需 node:http 兜底）；测试 Node 26 同口径。零新增运行时依赖
import Log from "../../commons/Log";
import type { ServerEvent } from "./protocol";
import { TransportBase, type TransportRequestResult } from "./transport";

const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export interface DirectTransportOptions {
  /** 被控端基址（http://host:port，尾斜杠归一） */
  baseUrl: string;
  token: string;
  /** SSE 无入站字节判死窗口（默认 60s；测试注入缩短） */
  idleTimeoutMs?: number;
  /** 重连退避基数/封顶（默认 1s / 30s） */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** 单次 request 整体超时窗（默认 15s；测试注入缩短。与 SSE 流无关） */
  requestTimeoutMs?: number;
}

/** AbortSignal.timeout 中止名（Node 24/26 实测 DOMException.name） */
function isTimeoutAbort(e: unknown): boolean {
  return (
    e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")
  );
}

export class DirectTransport extends TransportBase {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly idleTimeoutMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly requestTimeoutMs: number;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private sseAbort: AbortController | null = null;
  private closedByUser = false;

  constructor(options: DirectTransportOptions) {
    super();
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.headers = { authorization: `Bearer ${options.token}` };
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    void this.connectSse();
  }

  async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<TransportRequestResult> {
    if (this.closedByUser) throw new Error("transport 已关闭，拒绝请求");
    try {
      const response = await fetch(
        `${this.baseUrl}/${path.replace(/^\//, "")}`,
        {
          method,
          headers: {
            ...this.headers,
            ...(method === "POST"
              ? { "content-type": "application/json" }
              : {}),
          },
          body: method === "POST" ? JSON.stringify(body ?? null) : undefined,
          // spec §13 项 3：request 独立超时窗（SSE 建流另持 sseAbort，互不影响）
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        },
      );
      return { status: response.status, body: await parseJsonBody(response) };
    } catch (e) {
      if (isTimeoutAbort(e)) {
        throw new Error(
          `direct request 超时 TIMEOUT（${this.requestTimeoutMs}ms）：${path}`,
          { cause: e },
        );
      }
      throw e;
    }
  }

  close(): void {
    this.closedByUser = true;
    this.clearIdleWatchdog();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.sseAbort?.abort();
    this.sseAbort = null;
    this.setState("closed");
  }

  /** 单次建流：resolve=流自然结束；异常/判死统一走 scheduleReconnect */
  private async connectSse(): Promise<void> {
    if (this.closedByUser) return;
    const abort = new AbortController();
    this.sseAbort = abort;
    try {
      const response = await fetch(`${this.baseUrl}/event`, {
        headers: this.headers,
        signal: abort.signal,
      });
      if (!response.ok || !response.body) {
        // 401（token 错）等非 200 同样进退避重连（配置纠正后自愈）
        throw new Error(`SSE 建流失败 status=${response.status}`);
      }
      this.attempts = 0;
      this.setState("connected");
      await this.readSseStream(response.body);
    } catch (e) {
      if (this.closedByUser) return;
      Log.warn("direct SSE 断流，进入重连退避", e);
    }
    if (!this.closedByUser) this.scheduleReconnect();
  }

  private async readSseStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    this.armIdleWatchdog();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(
        /\r\n/g,
        "\n",
      );
      this.armIdleWatchdog();
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        this.dispatchSseBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    }
  }

  /** 单帧分发：注释行（`: ping`）忽略；多 data 行按 SSE 规范 \n 拼接 */
  private dispatchSseBlock(block: string): void {
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      const colonAt = line.indexOf(":");
      const field = colonAt === -1 ? line : line.slice(0, colonAt);
      let value = colonAt === -1 ? "" : line.slice(colonAt + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") eventName = value;
      else if (field === "data") dataLines.push(value);
    }
    if (!dataLines.length) return;
    try {
      this.emitEvent({
        type: eventName,
        payload: JSON.parse(dataLines.join("\n")),
      } as ServerEvent);
    } catch (e) {
      Log.warn("direct SSE 帧负载不是合法 JSON，已丢弃", e);
    }
  }

  /** 入站字节即活性：每收到 chunk 重置；超窗无字节 abort 触发重连 */
  private armIdleWatchdog(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      Log.warn("direct SSE 静默超时，判死重连");
      this.sseAbort?.abort();
    }, this.idleTimeoutMs);
  }

  private clearIdleWatchdog(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleReconnect(): void {
    this.clearIdleWatchdog();
    this.setState("reconnecting");
    if (this.reconnectTimer) return;
    const delay = Math.min(
      this.reconnectBaseMs * 2 ** this.attempts,
      this.reconnectMaxMs,
    );
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectSse();
    }, delay);
    Log.info("direct transport 将在", `${delay}ms 后重连`);
  }
}

/** 响应体 JSON 解析（空体/非 JSON 容错：null / 原文透传） */
async function parseJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
