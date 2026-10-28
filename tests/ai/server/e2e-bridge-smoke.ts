/**
 * 桌面工具桥 E2E 冒烟（TB-T3，直连链路 fake model）：无头端 chat 循环遇
 * 桥工具（browser 四件）→ tool.request 事件 → 控制端脚本 respond →
 * 工具结果回喂模型 → 会话完成——桥 wire 契约（spec §2.1/§2.2/§3）全链
 * 直证。
 *
 * 与 e2e-graph-smoke 的关键差异：模型面不依赖真模型（无 E2E_MODEL_* /
 * dev 库回退/SKIP 链）——本脚本自起一个本地 OpenAI 兼容 SSE 假端点
 * （node:http），脚本化返回 browser_snapshot/browser_click 的
 * tool_calls，provider 落库指向它；桥链路断言全部确定性可达，故本
 * 冒烟恒可跑（无 SKIP 分支；server dist 缺失仍按先例 FAIL 提示构建）。
 *
 * 断言组：
 * ① read 桥链：send（脚本 browser_snapshot）→ SSE tool.request
 *   （requestId/sessionId/tool/args 四字段）→ POST tool/respond
 *   {ok:true,output} → 2000 {responded:true}；chunk 流收 tool-update
 *   ready→running→done（output 含 respond 文本）+ text-delta + finish +
 *   session.updated；假模型第二次请求 messages 含 role:"tool" 且内容为
 *   respond 输出（回喂闭环）
 * ② respond 一次性：同 requestId 重复 respond → 4005（不可重放）
 * ③ write 桥链：send（脚本 browser_click）→ tool.request（write 工具
 *   豁免 server 本机 write 门禁直证——default accessMode 下照发）→
 *   respond {ok:false,error:"denied by user"} → chunk tool-update 终态
 *   error 且 output 含拒绝文案（「错误:」前缀回喂语义）→ finish
 *
 * 复用 e2e-graph-smoke 手法：spawn dist/src/main.js + TIANSHU_HANDSHAKE
 * 握手行 + 原生 fetch/SSE 手写解析（不复用 mirror transport——其依赖
 * electron Log，纯 node 下即抛错）。数据收敛：provider/model 按名幂等
 * 留存（先例）；会话经端点删除；TIANSHU_DATA_ROOT 临时目录隔离技能面。
 *
 * 运行：npm run test:e2e:bridge（node 原生 strip-types，需 Node ≥ 23.6；
 * 文件名无 .test. 段不进 vitest 常规集；TIANSHU_E2E_SKIP_BUILD=1 可跳过
 * server 构建）
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const MIRROR_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const SERVER_DIR =
  process.env.TIANSHU_SERVER_DIR ??
  path.resolve(MIRROR_ROOT, "apps/tianshu-server");
const SERVER_ENTRY = path.join(SERVER_DIR, "dist", "src", "main.js");
const E2E_CONFIG = path.join(SERVER_DIR, "dist", "config", "config.e2e.yml");

const PROVIDER_NAME = "e2e-bridge-smoke";
const BOOT_TIMEOUT_MS = 60_000;
/** 单断言组事件等待上限（fake 模型即时回，10s 冗余充足） */
const EVENT_TIMEOUT_MS = 20_000;

/** 断言锚点汇总（终局打印 + 退出码依据） */
const outcomes: Array<{ label: string; ok: boolean; detail: string }> = [];

function log(step: string, ...rest: unknown[]): void {
  console.log(
    `[e2e-bridge] ${new Date().toISOString().slice(11, 19)} ${step}`,
    ...rest,
  );
}

function pass(label: string, detail: string): void {
  outcomes.push({ label, ok: true, detail });
  console.log(`[e2e-bridge] PASS ${label} — ${detail}`);
}

function fail(label: string, detail: string): never {
  outcomes.push({ label, ok: false, detail });
  throw new Error(`${label}: ${detail}`);
}

// —— 协议形状（starter 包装体 + 控制协议事件；e2e-smoke 同款） ——

interface Envelope {
  success?: boolean;
  code?: string;
  data?: unknown;
  message?: string;
}

interface ProtocolEvent {
  type: string;
  payload: Record<string, unknown>;
}

interface RequestResult {
  status: number;
  body: Envelope | string | null;
}

/** 包装体展开判错（session/send 的 202 同为 success 包装） */
async function call(
  request: (
    method: "GET" | "POST",
    reqPath: string,
    body?: unknown,
  ) => Promise<RequestResult>,
  label: string,
  reqPath: string,
  body?: unknown,
  method: "GET" | "POST" = "POST",
): Promise<unknown> {
  const result = await request(method, reqPath, body);
  if (result.status === 401) {
    fail(label, "HTTP 401（静态 token 未通过）");
  }
  const envelope = result.body as Envelope;
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    envelope.success !== true
  ) {
    fail(
      label,
      `HTTP ${result.status} body=${JSON.stringify(result.body).slice(0, 300)}`,
    );
  }
  return envelope.data;
}

// —— fake model：本地 OpenAI 兼容 SSE 假端点（脚本化 tool_calls/文本） ——

/** 一次模型调用的脚本化回合：tool（桥调用）或 text（终答） */
interface FakeTurn {
  kind: "tool" | "text";
  name?: string;
  args?: Record<string, unknown>;
  text?: string;
}

interface FakeModelCall {
  body: {
    stream?: boolean;
    stream_options?: { include_usage?: boolean };
    messages?: Array<Record<string, unknown>>;
  };
}

const CHAT_COMPLETIONS_PATH = "/chat/completions";

/** 终答缺省文案（脚本耗尽后兜底——不影响断言，仅保证链路可收敛） */
const DEFAULT_TEXT = "桥冒烟默认终答";

class FakeModelServer {
  /** 回合队列（FIFO）：每次 /chat/completions 消费一幕 */
  readonly turns: FakeTurn[] = [];
  /** 请求观测账本（断言回喂闭环） */
  readonly calls: FakeModelCall[] = [];
  readonly server: http.Server;

  constructor() {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server.address() as net.AddressInfo;
        resolve(address.port);
      });
    });
  }

  close(): void {
    this.server.close();
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (
      req.method !== "POST" ||
      req.url?.split("?")[0] !== CHAT_COMPLETIONS_PATH
    ) {
      log(`fake model 非预期请求：${req.method} ${req.url}`);
      res.writeHead(404, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "fake model 仅实现 POST /chat/completions" },
        }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: FakeModelCall["body"] = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      /* 空体/畸形体按缺省回合收敛 */
    }
    this.calls.push({ body });
    const turn = this.turns.shift() ?? { kind: "text", text: DEFAULT_TEXT };
    log(
      `fake model 请求 #${this.calls.length}（${turn.kind}${turn.name ? `:${turn.name}` : ""}，messages=${body.messages?.length ?? 0}）`,
    );
    if (body.stream === false) {
      this.serveJson(res, turn, body);
    } else {
      this.serveSse(res, turn, body);
    }
  }

  /** 非流式分支（防御：SDK 偶发 non-stream 调用形态） */
  private serveJson(
    res: http.ServerResponse,
    turn: FakeTurn,
    body: FakeModelCall["body"],
  ): void {
    const message =
      turn.kind === "tool"
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: fakeCallId(turn),
                type: "function",
                function: {
                  name: turn.name,
                  arguments: JSON.stringify(turn.args ?? {}),
                },
              },
            ],
          }
        : { role: "assistant", content: turn.text ?? DEFAULT_TEXT };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-e2e-bridge",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "e2e-bridge-fake",
        choices: [
          {
            index: 0,
            message,
            finish_reason: turn.kind === "tool" ? "tool_calls" : "stop",
          },
        ],
        usage: usage(body),
      }),
    );
  }

  /** 流式分支（主路径：chat 循环经 streamEvents 驱动 SDK stream 调用） */
  private serveSse(
    res: http.ServerResponse,
    turn: FakeTurn,
    body: FakeModelCall["body"],
  ): void {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    const base = {
      id: "chatcmpl-e2e-bridge",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "e2e-bridge-fake",
    };
    const write = (payload: Record<string, unknown>): void => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    write({
      ...base,
      choices: [
        {
          index: 0,
          delta:
            turn.kind === "tool"
              ? {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: fakeCallId(turn),
                      type: "function",
                      function: {
                        name: turn.name,
                        arguments: JSON.stringify(turn.args ?? {}),
                      },
                    },
                  ],
                }
              : { role: "assistant", content: turn.text ?? DEFAULT_TEXT },
          finish_reason: null,
        },
      ],
    });
    write({
      ...base,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: turn.kind === "tool" ? "tool_calls" : "stop",
        },
      ],
    });
    if (body.stream_options?.include_usage) {
      write({ ...base, choices: [], usage: usage(body) });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

function fakeCallId(turn: FakeTurn): string {
  return `call_e2e_${turn.name ?? "text"}_${Date.now() % 100000}`;
}

function usage(body: FakeModelCall["body"]): Record<string, number> {
  void body;
  return { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
}

// —— 进程/端口基建（e2e-graph-smoke 同款） ——

interface HandshakeInfo {
  port: number;
  token: string;
  instanceId: string;
}

interface ScannedProcess {
  child: ChildProcess;
  matched: string;
  stderrTail(): string;
  stdoutTail(): string;
}

function spawnScan(
  command: string,
  args: string[],
  waitFor: RegExp,
  extraEnv: Record<string, string>,
): Promise<ScannedProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...extraEnv },
      cwd: SERVER_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    let stdoutTail = "";
    const timer = setTimeout(() => {
      destroyChild(child);
      reject(
        new Error(
          `等待 ${String(waitFor)} 超时（${BOOT_TIMEOUT_MS}ms）；stderr 尾部：${stderr.slice(-500)}`,
        ),
      );
    }, BOOT_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutTail = (stdoutTail + chunk).slice(-4000);
      buffer += chunk;
      let boundary = buffer.indexOf("\n");
      while (boundary !== -1) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        if (waitFor.test(line)) {
          clearTimeout(timer);
          resolve({
            child,
            matched: line,
            stderrTail: () => stderr,
            stdoutTail: () => stdoutTail,
          });
        }
        boundary = buffer.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`spawn ${command} 失败: ${e.message}`));
    });
  });
}

function destroyChild(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGKILL");
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.kill("SIGTERM");
  await Promise.race([exited, delay(3000)]);
  destroyChild(child);
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}

/** 握手行解析：TIANSHU_HANDSHAKE {"port":..,"token":..,"instanceId":..} */
function parseHandshake(line: string): HandshakeInfo {
  const prefix = "TIANSHU_HANDSHAKE ";
  const trimmed = line.trim();
  const parsed = JSON.parse(
    trimmed.slice(trimmed.indexOf(prefix) + prefix.length),
  ) as { port?: unknown; token?: unknown; instanceId?: unknown };
  if (
    typeof parsed.port !== "number" ||
    typeof parsed.token !== "string" ||
    typeof parsed.instanceId !== "string"
  ) {
    throw new Error(`握手行字段不全：${trimmed}`);
  }
  return {
    port: parsed.port,
    token: parsed.token,
    instanceId: parsed.instanceId,
  };
}

// —— 直连控制端：fetch + SSE 手写解析（e2e-smoke 同款） ——

class DirectControl {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly sseAbort = new AbortController();
  private readonly queue: ProtocolEvent[] = [];
  private wake: (() => void) | null = null;
  private failure: unknown = null;
  private closed = false;

  constructor(port: number, token: string) {
    this.base = `http://127.0.0.1:${port}`;
    this.headers = { authorization: `Bearer ${token}` };
    void this.pumpSse();
  }

  async request(
    method: "GET" | "POST",
    reqPath: string,
    body?: unknown,
  ): Promise<RequestResult> {
    const response = await fetch(`${this.base}/${reqPath.replace(/^\//, "")}`, {
      method,
      headers: {
        ...this.headers,
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      body: method === "POST" ? JSON.stringify(body ?? null) : undefined,
    });
    const text = await response.text();
    let parsed: Envelope | string | null = text;
    if (text) {
      try {
        parsed = JSON.parse(text) as Envelope;
      } catch {
        /* 非 JSON 原文透传 */
      }
    }
    return { status: response.status, body: parsed };
  }

  async nextEvent(): Promise<ProtocolEvent> {
    for (;;) {
      if (this.queue.length) return this.queue.shift() as ProtocolEvent;
      if (this.failure) throw this.failure;
      if (this.closed) throw new Error("SSE 流已关闭");
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }

  close(): void {
    this.closed = true;
    this.sseAbort.abort();
    this.wake?.();
  }

  private async pumpSse(): Promise<void> {
    try {
      const response = await fetch(`${this.base}/event`, {
        headers: this.headers,
        signal: this.sseAbort.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`SSE 建流失败 status=${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) throw new Error("SSE 流意外结束");
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(
          /\r\n/g,
          "\n",
        );
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          const event = parseSseBlock(block);
          if (event) this.queue.push(event);
        }
        this.wake?.();
      }
    } catch (e) {
      if (!this.closed) {
        this.failure = e;
        this.wake?.();
      }
    }
  }
}

/** 单 SSE 块 → 协议事件（坏 JSON 丢弃） */
function parseSseBlock(block: string): ProtocolEvent | null {
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
  if (!dataLines.length) return null;
  try {
    return {
      type: eventName,
      payload: JSON.parse(dataLines.join("\n")) as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

/** 限时取下一事件 */
async function nextEventIn(
  control: DirectControl,
  timeoutMs: number,
  label: string,
): Promise<ProtocolEvent> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      control.nextEvent(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}: 等 ${timeoutMs}ms 无事件`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// —— provider 幂等落位（e2e-graph-smoke 手法+每次 baseUrl 刷新）：按名 upsert ——

async function ensureProviderModel(
  control: DirectControl,
  baseUrl: string,
): Promise<number> {
  const label = "provider 幂等落位";
  const first = (await call(
    control.request.bind(control),
    label,
    "provider/query",
  )) as {
    providers?: Array<{ id: number; name: string }>;
  };
  const existing = first.providers?.find((p) => p.name === PROVIDER_NAME);
  // fake model 端口每次运行不同：带 id upsert 刷新 baseUrl（仅建不刷会指向
  // 上次运行已销毁的端口——e2e-graph-smoke 真 baseUrl 恒定无此坑）
  await call(control.request.bind(control), label, "provider/save", {
    providers: [
      {
        ...(existing ? { id: existing.id } : {}),
        name: PROVIDER_NAME,
        type: "openai-compatible",
        baseUrl,
        apiKey: "e2e-bridge-fake-key",
        enabled: true,
      },
    ],
  });
  const second = (await call(
    control.request.bind(control),
    label,
    "provider/query",
  )) as {
    providers?: Array<{ id: number; name: string }>;
    models?: Array<{ id: number; providerId: number; modelId: string }>;
  };
  const provider = second.providers?.find((p) => p.name === PROVIDER_NAME);
  if (!provider) fail(label, "upsert 后未回读到 provider 行");
  const modelRow = second.models?.find(
    (m) => m.providerId === provider.id && m.modelId === "e2e-bridge-fake",
  );
  const saved = (await call(
    control.request.bind(control),
    label,
    "provider/save",
    {
      models: [
        {
          ...(modelRow ? { id: modelRow.id } : {}),
          providerId: provider.id,
          modelId: "e2e-bridge-fake",
          name: "e2e-bridge-fake-model",
          type: "llm",
          enabled: true,
        },
      ],
    },
  )) as {
    models?: Array<{ id: number; providerId: number; modelId: string }>;
  };
  const finalRow = saved.models?.find(
    (m) => m.providerId === provider.id && m.modelId === "e2e-bridge-fake",
  );
  if (!finalRow) fail(label, "保存后未回读到模型行");
  return finalRow.id;
}

// —— 桥链路观测：chunk 账本 + tool.request 等待 ——

interface ToolUpdateChunk {
  toolCallId?: string;
  toolName?: string;
  state?: string;
  output?: string;
}

/** 一轮桥调用的 chunk 流账本（会话过滤后） */
class RoundLedger {
  ready = false;
  running = false;
  done: ToolUpdateChunk | null = null;
  textDeltas = 0;
  text = "";
  finish = false;
  updated = false;
  streamError: string | null = null;
}

/**
 * 一轮桥调用的单事件泵：同时记账 chunk 流（ready/running/done/text/finish/
 * session.updated）并捕获本会话首个 tool.request——捕获瞬间回调 respond
 * （SSE 队列在 POST 期间继续积压，事件不丢），随后继续泵至 finish+updated。
 * 回调内可自行断言 respond 包装体（fail 即整轮失败）。
 */
async function runBridgeRound(
  control: DirectControl,
  sessionId: number,
  label: string,
  respond: (requestId: string) => Promise<void>,
): Promise<{ ledger: RoundLedger; request: Record<string, unknown> }> {
  const ledger = new RoundLedger();
  let captured: Record<string, unknown> | null = null;
  const deadline = Date.now() + EVENT_TIMEOUT_MS;
  while (!(ledger.finish && ledger.updated)) {
    if (ledger.streamError) fail(label, ledger.streamError);
    const event = await nextEventIn(
      control,
      Math.max(1, deadline - Date.now()),
      `${label} 事件`,
    );
    if (event.type === "tool.request") {
      const payload = event.payload;
      if (
        (payload as { sessionId?: number }).sessionId === sessionId &&
        captured === null
      ) {
        captured = payload;
        await respond(String(payload.requestId));
      }
      continue;
    }
    if (event.type === "message.chunk") {
      const payload = event.payload as {
        sessionId?: number;
        chunk?: {
          type?: string;
          text?: string;
          errorCode?: string;
          message?: string;
        } & ToolUpdateChunk;
      };
      if (payload.sessionId !== sessionId || !payload.chunk) continue;
      const chunk = payload.chunk;
      if (chunk.type === "text-delta") {
        ledger.textDeltas += 1;
        ledger.text += chunk.text ?? "";
      } else if (chunk.type === "tool-update") {
        if (chunk.state === "ready") ledger.ready = true;
        if (chunk.state === "running") ledger.running = true;
        if (chunk.state === "done" || chunk.state === "error") {
          ledger.done = chunk;
        }
      } else if (chunk.type === "finish") {
        ledger.finish = true;
      } else if (chunk.type === "error") {
        ledger.streamError = `chunk.error ${chunk.errorCode}: ${chunk.message}`;
      }
    } else if (event.type === "session.updated") {
      if ((event.payload as { id?: number }).id === sessionId) {
        ledger.updated = true;
      }
    } else if (event.type === "session.error") {
      const payload = event.payload as {
        sessionId?: number;
        code?: string;
        message?: string;
      };
      if (payload.sessionId === sessionId) {
        ledger.streamError = `session.error ${payload.code}: ${payload.message}`;
      }
    }
  }
  if (captured === null) {
    fail(label, "finish 已到但 tool.request 未出现（桥调用未发起）");
  }
  return { ledger, request: captured };
}

// —— 主流程 ——

async function main(): Promise<number> {
  log("tianshu-server 桌面工具桥 E2E 冒烟启动（fake model，无 SKIP 分支）");
  log(`server 仓：${SERVER_DIR}`);

  if (!fs.existsSync(SERVER_ENTRY)) {
    console.error(
      `[e2e-bridge] FAIL：无头端产物不存在 ${SERVER_ENTRY}（先在 tianshu-server 执行 npm run build）`,
    );
    return 1;
  }
  if (!process.env.TIANSHU_E2E_SKIP_BUILD) {
    log("构建 tianshu-server（TIANSHU_E2E_SKIP_BUILD=1 可跳过）…");
    const build = spawnSync("npm", ["run", "build"], {
      cwd: SERVER_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    if (build.status !== 0) {
      console.error(
        `[e2e-bridge] FAIL：构建失败\n${(build.stderr ?? "").slice(-2000)}`,
      );
      return 1;
    }
  }

  const fake = new FakeModelServer();
  const fakePort = await fake.listen();
  log(`fake model 已起：http://127.0.0.1:${fakePort}/chat/completions`);

  const dataRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tianshu-e2e-bridge-"),
  );
  const port = await getFreePort();
  fs.writeFileSync(
    E2E_CONFIG,
    `# e2e-bridge-smoke 生成（运行完自动删除）\napp:\n  port: ${port}\n`,
  );

  let child: ChildProcess | null = null;
  let control: DirectControl | null = null;
  let scanned: ScannedProcess | null = null;
  try {
    const spawned = await spawnScan(
      process.execPath,
      [SERVER_ENTRY],
      /^TIANSHU_HANDSHAKE /,
      {
        NODE_ENV: "e2e",
        TIANSHU_TOKEN: "e2e-bridge-token",
        TIANSHU_DATA_ROOT: dataRoot,
      },
    );
    child = spawned.child;
    scanned = spawned;
    const info = parseHandshake(spawned.matched);
    if (info.token !== "e2e-bridge-token") {
      fail("spawn+握手", "token 未按 env 回显");
    }
    if (info.port !== port) {
      fail("spawn+握手", `端口回显 ${info.port} ≠ 配置 ${port}`);
    }
    pass("spawn+握手", `port=${info.port} instanceId=${info.instanceId}`);

    control = new DirectControl(info.port, info.token);
    const modelRowId = await ensureProviderModel(
      control,
      `http://127.0.0.1:${fakePort}`,
    );
    log(`模型行 ${modelRowId} → fake model`);

    const session = (await call(
      control.request.bind(control),
      "session/create",
      "session/create",
      { title: "e2e-bridge-smoke", currentModelId: modelRowId },
    )) as { id: number };
    const sessionId = session.id;
    log(`session#${sessionId} 已建`);

    // —— ① read 桥链（browser_snapshot → respond ok:true） ——
    fake.calls.length = 0;
    fake.turns.push({ kind: "tool", name: "browser_snapshot", args: {} });
    const sendAccepted = (await call(
      control.request.bind(control),
      "① session/send",
      "session/send",
      { sessionId, content: "请读取当前浏览器页快照" },
    )) as { accepted: boolean };
    if (sendAccepted?.accepted !== true) {
      fail("① session/send", `受理载荷异常：${JSON.stringify(sendAccepted)}`);
    }

    const bridgeOutput = "标题: 示例页\n\n[可交互元素]\n（无）";
    const round1 = await runBridgeRound(
      control,
      sessionId,
      "① 桥链",
      async (requestId) => {
        const respond = (await control.request("POST", "tool/respond", {
          requestId,
          result: { ok: true, output: bridgeOutput },
        })) as RequestResult;
        const envelope = respond.body as Envelope;
        const data = envelope?.data as { responded?: boolean } | undefined;
        if (
          respond.status !== 200 ||
          envelope?.success !== true ||
          data?.responded !== true
        ) {
          fail(
            "① tool/respond",
            `期望 2000 {responded:true} 实为 HTTP ${respond.status} ${JSON.stringify(respond.body).slice(0, 200)}`,
          );
        }
      },
    );
    const requestPayload = round1.request;
    const requestId = requestPayload.requestId;
    if (typeof requestId !== "string" || !requestId) {
      fail(
        "① tool.request",
        `requestId 缺失：${JSON.stringify(requestPayload)}`,
      );
    }
    if (requestPayload.tool !== "browser_snapshot") {
      fail(
        "① tool.request",
        `tool 期望 browser_snapshot 实为 ${String(requestPayload.tool)}`,
      );
    }
    if (JSON.stringify(requestPayload.args ?? null) !== "{}") {
      fail(
        "① tool.request",
        `快照 args 期望空对象实为 ${JSON.stringify(requestPayload.args)}`,
      );
    }
    const ledger1 = round1.ledger;
    if (!ledger1.ready || !ledger1.running) {
      fail(
        "① 桥链 chunk 断言",
        `ready/running 缺失（ready=${ledger1.ready} running=${ledger1.running}）`,
      );
    }
    if (ledger1.done?.state !== "done") {
      fail(
        "① 桥链 chunk 断言",
        `工具终态期望 done 实为 ${String(ledger1.done?.state)}（output=${JSON.stringify(ledger1.done?.output ?? null).slice(0, 120)}）`,
      );
    }
    if (!ledger1.done.output?.includes("示例页")) {
      fail(
        "① 桥链 chunk 断言",
        "done chunk output 未含 respond 文本（回喂断裂）",
      );
    }
    if (ledger1.textDeltas < 1)
      fail("① 桥链 chunk 断言", "终答 text-delta 缺失");
    const toolMessage = fake.calls
      .slice(1)
      .flatMap((c) => c.body.messages ?? [])
      .find((m) => m.role === "tool");
    if (!toolMessage || !String(toolMessage.content ?? "").includes("示例页")) {
      fail(
        "① 回喂闭环",
        `第二次模型请求缺 role:tool 消息（calls=${fake.calls.length}）`,
      );
    }
    pass(
      "① read 桥链",
      `browser_snapshot tool.request（requestId=${String(requestId).slice(0, 8)}… args={}）→ respond ok:true →` +
        ` done chunk（「${String(ledger1.done.output).slice(0, 24)}…」）+ ${ledger1.textDeltas} text-delta + finish；工具结果已回喂模型`,
    );

    // —— ② respond 一次性（同 requestId 重放 → 4005） ——
    const replay = (await control.request("POST", "tool/respond", {
      requestId,
      result: { ok: true, output: "重放" },
    })) as RequestResult;
    const replayEnvelope = replay.body as Envelope;
    if (replayEnvelope?.code !== "4005" || replayEnvelope?.success !== false) {
      fail(
        "② respond 一次性",
        `期望 4005 实为 ${String(replayEnvelope?.code)} ${JSON.stringify(replay.body).slice(0, 200)}`,
      );
    }
    pass("② respond 一次性", "同 requestId 重放 → 4005（requestId 不可重放）");

    // —— ③ write 桥链（browser_click → respond denied） ——
    fake.turns.push({ kind: "tool", name: "browser_click", args: { idx: 1 } });
    await call(
      control.request.bind(control),
      "③ session/send",
      "session/send",
      {
        sessionId,
        content: "请点击快照序号 1 的元素",
      },
    );
    const round3 = await runBridgeRound(
      control,
      sessionId,
      "③ 桥链",
      async (requestId) => {
        await control.request("POST", "tool/respond", {
          requestId,
          result: { ok: false, error: "denied by user" },
        });
      },
    );
    const clickArgs = round3.request.args as { idx?: unknown } | undefined;
    if (round3.request.tool !== "browser_click") {
      fail(
        "③ tool.request",
        `tool 期望 browser_click 实为 ${String(round3.request.tool)}`,
      );
    }
    if (clickArgs?.idx !== 1) {
      fail(
        "③ tool.request",
        `args.idx 期望 1 实为 ${JSON.stringify(clickArgs)}`,
      );
    }
    const ledger3 = round3.ledger;
    if (ledger3.streamError) fail("③ 桥链", ledger3.streamError);
    if (ledger3.done?.state !== "error") {
      fail(
        "③ 桥链 chunk 断言",
        `拒绝终态期望 error 实为 ${String(ledger3.done?.state)}（output=${JSON.stringify(ledger3.done?.output ?? null).slice(0, 120)}）`,
      );
    }
    if (!ledger3.done.output?.includes("denied by user")) {
      fail("③ 桥链 chunk 断言", "拒绝 output 未含 denied by user");
    }
    if (!ledger3.finish) fail("③ 桥链 chunk 断言", "finish 缺失");
    pass(
      "③ write 桥链",
      `browser_click tool.request（idx=1，write 豁免本机门禁照发）→ respond denied → error chunk（「${String(ledger3.done.output).slice(0, 24)}…」）+ finish`,
    );

    // —— 收敛：会话删除（端点级） ——
    await call(
      control.request.bind(control),
      "session/delete 收敛",
      "session/delete",
      {
        id: sessionId,
      },
    );
    pass(
      "清理收敛",
      `session#${sessionId} 已删（provider/model 行按名幂等留存——先例）`,
    );
  } catch (e) {
    console.error(
      `[e2e-bridge] 阶段失败：${e instanceof Error ? e.message : e}`,
    );
    if (scanned) {
      console.error(
        `[e2e-bridge] server stdout 尾部：\n${scanned.stdoutTail().slice(-2000)}`,
      );
      console.error(
        `[e2e-bridge] server stderr 尾部：\n${scanned.stderrTail().slice(-1000)}`,
      );
    }
  } finally {
    control?.close();
    await stopChild(child);
    fake.close();
    fs.rmSync(E2E_CONFIG, { force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }

  const failed = outcomes.filter((o) => !o.ok);
  console.log(
    `\n[e2e-bridge] 结果汇总：${outcomes.length - failed.length}/${outcomes.length} 断言组通过`,
  );
  for (const o of outcomes) {
    console.log(`  ${o.ok ? "PASS" : "FAIL"}  ${o.label} — ${o.detail}`);
  }
  return failed.length > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("[e2e-bridge] 未预期异常：", e);
    process.exit(1);
  });
