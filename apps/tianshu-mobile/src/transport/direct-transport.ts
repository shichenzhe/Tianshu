import { fetch } from "expo/fetch";
import type { ServerEvent } from "@tianshu/protocol";
import { createSseParser } from "./sse-parser";
import { nextBackoffMs } from "./backoff";
import {
  Emitter,
  type Transport,
  type TransportRequestResult,
  type TransportState,
} from "./types";

export interface DirectConfig {
  baseUrl: string;
  token: string;
}

export function createDirectTransport(config: DirectConfig): Transport {
  const events = new Emitter<ServerEvent>();
  const states = new Emitter<TransportState>();
  let state: TransportState = "idle";
  let closed = false;
  let attempt = 0;
  let lastByteAt = 0;
  let livenessTimer: ReturnType<typeof setInterval> | null = null;
  let closeSignal: AbortController | null = null;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const setState = (s: TransportState) => {
    state = s;
    states.emit(s);
  };
  const headers = () => ({
    Authorization: `Bearer ${config.token}`,
  });
  const clearLiveness = () => {
    if (livenessTimer) {
      clearInterval(livenessTimer);
      livenessTimer = null;
    }
  };

  async function request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<TransportRequestResult> {
    // 手动 AbortController + 完成即清（不用 AbortSignal.timeout：后者倒计时
    // 与 fetch 生命周期解耦，响应后仍会到期 abort——expo/fetch 对「已完成
    // fetch 的 signal 事后 abort」存在内部 promise 链无 handler 路径，真机
    // LogBox 报 Uncaught (in promise) AbortError）
    const timeoutAbort = new AbortController();
    const timer = setTimeout(() => timeoutAbort.abort(), 15_000);
    try {
      const res = await fetch(`${config.baseUrl}/${path.replace(/^\//, "")}`, {
        method,
        headers: {
          ...headers(),
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: timeoutAbort.signal,
      });
      return { status: res.status, body: await res.json() };
    } finally {
      clearTimeout(timer);
    }
  }

  async function startEventStream(): Promise<void> {
    if (closed) return;
    setState(state === "idle" ? "connecting" : "reconnecting");
    // 建流 fetch 与后续活跃长流共持同一 abort signal：close() 一发全杀
    const abort = new AbortController();
    closeSignal = abort;
    try {
      // SSE 事件端点 "/event"（GET 资源不在 ENDPOINTS 表，spec §4.1 注记）
      const res = await fetch(
        `${config.baseUrl}/event?token=${encodeURIComponent(config.token)}`,
        {
          headers: headers(),
          signal: abort.signal,
        },
      );
      if (closed) return; // 建流在途被 close()：勿再动状态机（防 closed 倒退）
      if (res.status === 401) {
        clearLiveness();
        setState("invalid-token"); // 粘滞：停止重连，等用户改配置
        return;
      }
      if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
      setState("connected");
      attempt = 0;
      lastByteAt = Date.now();
      // 60s 无入站字节判死（mirror 同款）：cancel reader 触发重连。
      // 续命刷新在读循环字节级——心跳 `: ping` 是注释行无 data 帧，
      // parser 不派发，帧级刷新会误杀健康空闲连接（connected 每分钟抖动）
      clearLiveness();
      livenessTimer = setInterval(() => {
        if (Date.now() - lastByteAt > 60_000) {
          clearLiveness();
          void activeReader?.cancel();
        }
      }, 5_000);
      const parser = createSseParser((frame) => {
        try {
          if (frame.event === undefined) throw new Error("SSE 帧缺 event 字段");
          events.emit({
            type: frame.event!,
            payload: JSON.parse(frame.data),
          } as ServerEvent);
        } catch {
          // 无 event 字段/非业务帧（理论上服务端不发）：丢弃不崩连接
        }
      });
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      activeReader = reader;
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        lastByteAt = Date.now(); // 入站字节即活性（单一刷新点：含心跳/注释/半包残字节）
        parser(decoder.decode(value, { stream: true }));
      }
      throw new Error("SSE ended"); // 服务端正常关流也走重连
    } catch {
      if (closed) return;
      clearLiveness();
      const delay = nextBackoffMs(attempt++);
      setTimeout(startEventStream, delay);
    }
  }

  void startEventStream();

  return {
    request,
    onEvent: (cb) => events.on(cb),
    onState: (cb) => states.on(cb),
    close() {
      closed = true;
      clearLiveness();
      // abort/cancel 均显式吞错：testConnection 关闭在途建流/读取时，expo/
      // fetch 与 reader.cancel 的 AbortError rejection 若无人接即真机红屏
      // （Uncaught (in promise) AbortError，LogBox 定位到本帧）
      const signal = closeSignal;
      closeSignal = null;
      const reader = activeReader;
      activeReader = null;
      try {
        signal?.abort();
      } catch {
        // 个别实现 abort() 同步抛（signal 已 settle 等）——关闭路径静默
      }
      reader?.cancel().catch(() => undefined);
      setState("closed");
    },
  };
}
