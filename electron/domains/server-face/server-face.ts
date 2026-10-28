// 被控面 HTTP 服务面（server-face spec §6.1 / T12）：node:http 承载
// 直连控制端——GET /info、GET /event（SSE）、POST session/*（路由表分发）。
// 默认关（option 表 type="app" name="serverFace" JSON {enabled,port,token,
// host,relayUrl,relayToken}，缺省 0.0.0.0——被控面消费者是远程控制端，
// 本机进程走 IPC 不经 HTTP 面，仅本机监听无人可连；与 tianshu-server
// DEFAULT_LISTEN_HOSTNAME 同口径）；token 未配置即拒绝启动
// （不裸奔）；鉴权 Bearer 与 ?token= 双口径（EventSource 不能带 header，
// 与 tianshu-server token guard 同口径）。
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import prisma from "../../commons/prisma-client";
import Log from "../../commons/Log";
import { handleRoute } from "./routes";
import { ensureTapBridge, onFaceEvent, type FaceEvent } from "./face-events";
import { FACE_CAPABILITIES, FACE_INSTANCE_ID } from "./face-info";

const OPTION_TYPE = "app";
const OPTION_NAME = "serverFace";
const DEFAULT_FACE_PORT = 18_411;
const DEFAULT_HOST = "0.0.0.0";

/**
 * relay E2E 模式（spec 2026-10-18-relay-e2e §2.4 降级语义，E2E-T2）：
 * - auto（缺省）：收到 e2e-hello 即握手密文承载；控制端不握手则明文兼容
 * - required：拒绝明文业务帧（断开——旧控制端不降级）
 * - off：忽略 e2e-hello（完全旧版行为）
 */
export type FaceE2eMode = "auto" | "required" | "off";
const E2E_MODES: readonly FaceE2eMode[] = ["auto", "required", "off"];
/** SSE 心跳间隔（T7 同款 25s：注释行防中间层空闲超时断连） */
const HEARTBEAT_INTERVAL_MS = 25_000;
/** 请求体上限（blocks 历史等大载荷防护） */
// 16MB：图片上传 base64（3MB 图 ≈ 4MB+ JSON）——原 4MB 上限正好卡死
// 常规图片（真机实测「上传失败」根因）。relay 链路仍受 4MiB 帧上限
// 约束（E2E 信封层），直连 face 不经 relay 不受限
const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** 服务面配置（option 表持久化形态） */
export interface ServerFaceConfig {
  enabled: boolean;
  port: number;
  token: string;
  host: string;
  /** relay 客户端（配了 url+token 才随启用拉起） */
  relayUrl?: string;
  relayToken?: string;
  /** relay E2E 模式（缺省 auto；见 FaceE2eMode） */
  e2e?: FaceE2eMode;
}

const DEFAULT_CONFIG: ServerFaceConfig = {
  enabled: false,
  port: DEFAULT_FACE_PORT,
  token: "",
  host: DEFAULT_HOST,
};

function parseConfigValue(value: string): ServerFaceConfig {
  try {
    const parsed = (JSON.parse(value) ?? {}) as Partial<ServerFaceConfig>;
    return {
      enabled: parsed.enabled === true,
      // 0 = 随机端口（测试与避冲突语义）；非法/缺省回落默认端口
      port:
        Number.isInteger(parsed.port) &&
        (parsed.port as number) >= 0 &&
        (parsed.port as number) < 65_536
          ? (parsed.port as number)
          : DEFAULT_FACE_PORT,
      token: typeof parsed.token === "string" ? parsed.token : "",
      // 两档现形翻转：显式回环保留，缺省/非法值回落默认（全网卡）
      host: parsed.host === "127.0.0.1" ? "127.0.0.1" : DEFAULT_HOST,
      ...(typeof parsed.relayUrl === "string" && parsed.relayUrl
        ? { relayUrl: parsed.relayUrl }
        : {}),
      ...(typeof parsed.relayToken === "string" && parsed.relayToken
        ? { relayToken: parsed.relayToken }
        : {}),
      ...(E2E_MODES.includes(parsed.e2e as FaceE2eMode)
        ? { e2e: parsed.e2e as FaceE2eMode }
        : {}),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function readServerFaceConfig(): Promise<ServerFaceConfig> {
  const row = await prisma.option.findFirst({
    where: { type: OPTION_TYPE, name: OPTION_NAME },
  });
  return row ? parseConfigValue(row.value) : { ...DEFAULT_CONFIG };
}

/** 配置落库（findFirst 定位 + update/create；type="app" 行 userId 恒 NULL） */
export async function saveServerFaceConfig(
  next: ServerFaceConfig,
): Promise<void> {
  const value = JSON.stringify(next);
  const row = await prisma.option.findFirst({
    where: { type: OPTION_TYPE, name: OPTION_NAME },
    select: { id: true },
  });
  if (row) {
    await prisma.option.update({ where: { id: row.id }, data: { value } });
  } else {
    await prisma.option.create({
      data: { type: OPTION_TYPE, name: OPTION_NAME, value },
    });
  }
}

/** SSE 帧编码（T7 event.controller 同款）：`event: <type>\ndata: <json>\n\n`；
 * payload 经 JSON.stringify（日期字段调用方先 ISO 字符串化，SSE/REST 一致） */
export type SseEvent =
  | FaceEvent
  | {
      type: "server.connected";
      payload: { instanceId: string; capabilities: string[] };
    };

export function encodeSseFrame(event: SseEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}

let server: http.Server | null = null;
let runningPort = 0;
let runningHost = DEFAULT_HOST;

export interface ServerFaceState {
  running: boolean;
  port: number;
  host: string;
}

export function getServerFaceState(): ServerFaceState {
  return { running: server !== null, port: runningPort, host: runningHost };
}

/** 启动服务面（幂等；override 供测试/启动期显式传参覆盖 option 读值）。
 * 未启用为空操作；已启用但未配 token 拒绝启动（不裸奔——控制端无法鉴权，
 * 本地 127.0.0.1 也不放行明文面）。端口 0 = 随机（测试/默认避冲突语义） */
export async function ensureServerFace(
  override?: Partial<ServerFaceConfig>,
): Promise<number> {
  const config = { ...(await readServerFaceConfig()), ...override };
  if (!config.enabled) {
    if (server) await stopServerFace();
    return 0;
  }
  if (!config.token) {
    throw new Error("serverFace 未配置 token，拒绝启动（不裸奔）");
  }
  ensureTapBridge();
  if (server) {
    if (runningPort === config.port && runningHost === config.host) {
      return runningPort;
    }
    await stopServerFace();
  }
  const started = http.createServer(handleFaceRequest);
  const port = await new Promise<number>((resolve, reject) => {
    started.once("error", reject);
    started.listen(config.port, config.host, () => {
      started.off("error", reject);
      const address = started.address();
      resolve(
        typeof address === "object" && address ? address.port : config.port,
      );
    });
  });
  server = started;
  runningPort = port;
  runningHost = config.host;
  Log.info("serverFace listening", `${config.host}:${port}`);
  return port;
}

export async function stopServerFace(): Promise<void> {
  if (!server) return;
  const current = server;
  server = null;
  runningPort = 0;
  // closeAllConnections：close 只停听不停 keep-alive/SSE 挂起连接（webhook
  // server 先例），SSE 连接靠此即时断开触发各自 cleanup
  current.closeAllConnections?.();
  await new Promise<void>((resolve) => current.close(() => resolve()));
}

/** token 恒时比较（长度不等先短路，不泄露比较耗时信息） */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function authorized(
  req: http.IncomingMessage,
  url: URL,
  expectedToken: string,
): Promise<boolean> {
  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const queryToken = url.searchParams.get("token") ?? "";
  const presented = bearer || queryToken;
  return presented !== "" && tokenMatches(presented, expectedToken);
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** 读 JSON 请求体（上限 4MiB；超限/坏 JSON → 400/413 starter 形态包装） */
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("BODY_TOO_LARGE"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(
          chunks.length
            ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
            : null,
        );
      } catch {
        reject(new Error("BAD_JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** GET /event SSE 出口（T7 event.controller 同款编码与生命周期）：
 * 首帧 server.connected {instanceId, capabilities}；其后转发 face 事件
 * 总线；25s `: ping` 心跳；断连退订 + 停心跳；转发回调 try/catch 自包裹
 * （连接级故障只殃及本连接，不打断 send 生产链） */
function streamSse(res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    // 禁 nginx 等反代的响应缓冲（SSE 逐帧直达）
    "X-Accel-Buffering": "no",
  });
  let closed = false;
  let unsubscribe: () => void = () => undefined;
  const writable = () => !closed && !res.destroyed && !res.writableEnded;
  const heartbeat = setInterval(() => {
    try {
      if (writable()) res.write(": ping\n\n");
    } catch {
      cleanup();
    }
  }, HEARTBEAT_INTERVAL_MS);
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  unsubscribe = onFaceEvent((event) => {
    try {
      if (writable()) res.write(encodeSseFrame(event));
    } catch (e) {
      Log.warn("serverFace SSE 帧转发失败，退订本连接", e);
      cleanup();
    }
  });
  res.on("close", cleanup);
  res.on("error", cleanup);
  res.write(
    encodeSseFrame({
      type: "server.connected",
      payload: {
        instanceId: FACE_INSTANCE_ID,
        capabilities: [...FACE_CAPABILITIES],
      },
    }),
  );
}

function handleFaceRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "face"}`);
    try {
      const config = await readServerFaceConfig();
      if (!(await authorized(req, url, config.token))) {
        sendJson(res, 401, {
          code: "4010",
          success: false,
          data: null,
          message: "未认证",
        });
        return;
      }
      // SSE：连接级事件流（仅 GET /event；鉴权已过）
      if (req.method === "GET" && url.pathname === "/event") {
        streamSse(res);
        return;
      }
      if (req.method === "GET") {
        const result = await handleRoute("GET", url.pathname, null);
        sendJson(res, result.status, result.body);
        return;
      }
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const result = await handleRoute("POST", url.pathname, body);
        sendJson(res, result.status, result.body);
        return;
      }
      sendJson(res, 405, {
        code: "4050",
        success: false,
        data: null,
        message: "方法不允许",
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message === "BODY_TOO_LARGE") {
        sendJson(res, 413, {
          code: "5000",
          success: false,
          data: null,
          message,
        });
      } else if (message === "BAD_JSON") {
        sendJson(res, 400, {
          code: "5000",
          success: false,
          data: null,
          message: "请求体不是合法 JSON",
        });
      } else {
        Log.error("serverFace 请求处理失败", e);
        sendJson(res, 500, {
          code: "5000",
          success: false,
          data: null,
          message: "内部错误",
        });
      }
    }
  })();
}
