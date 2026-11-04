/**
 * e2e 基建单源（2026-10-31 五副本归一）：tests/ai/server 下五个 e2e 脚本
 * （e2e-smoke / e2e-graph-smoke / e2e-graph-search-pg / e2e-main-pg /
 * e2e-bridge-smoke）此前各自携带同构基建——spawnScan / DirectControl /
 * parseSseBlock 三件套五份全拷贝，握手行解析、getFreePort、停进程、
 * 包装体 call、事件限时等待、log/pass/fail 断言锚、resolveModel、路径
 * 常量、PG 检索 seed 语句等亦两到五份漂移。本文件是其唯一事实源：
 *
 * - spawnScan 取 e2e-smoke 最全变体（waitForLine 后续行等待）为基，
 *   吸收 e2e-bridge 的 stdoutTail 尾部观测——超集合体，不用者无感
 * - DirectControl 取 e2e-graph-smoke 最全变体（含 rawPost——webhook
 *   @Res() 原样响应面）；其余四脚本的副本均为其子集
 * - call 统一为「请求函数 + 可选 method（缺省 POST）」形态：e2e-smoke
 *   原以 ControlSession 对象传参，改为绑定 request 后传入（行为等价）；
 *   e2e-graph-search-pg / e2e-main-pg 原无 method 参（恒 POST），与缺省
 *   值一致
 * - PG 访问层（接口形状/DDL/upsert INSERT 语句）在 e2e-graph-search-pg
 *   与 e2e-main-pg 两份间逐字相等，按 (userId, collection, seedModel)
 *   参数化收敛为 createPgSeeder；分词 tokenize 仍由调用方注入（两脚本
 *   解析装载位策略不同，见各自头注释）
 * - resolveModel 为 e2e-smoke / e2e-graph-smoke 两份逐字相等件；告警
 *   log 由调用方注入以保持各脚本前缀不变
 *
 * 各文件仍保留其专属面：RelayControl（smoke）、probeEndpoint / run 表
 * 直查 / twoNodeGraphJson（graph-smoke）、waitForHealth / scalar
 * (main-pg)、fake model / RoundLedger（bridge）、ensureProviderModel
 * （smoke / graph / bridge 三份真实差异：provider 名 / model 名 /
 * baseUrl 每次刷新）。
 *
 * 约定：node 原生 strip-types 直跑（Node ≥ 23.6，npm run test:e2e:*），
 * 相对导入必须带 .ts 扩展名；文件名无 .test. 段不进 vitest 常规集。
 */
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// —— 路径与超时常量（五脚本同值单源；TIANSHU_SERVER_DIR 覆盖优先） ——

export const MIRROR_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
export const SERVER_DIR =
  process.env.TIANSHU_SERVER_DIR ??
  path.resolve(MIRROR_ROOT, "apps/tianshu-server");
export const SERVER_ENTRY = path.join(SERVER_DIR, "dist", "src", "main.js");
export const E2E_CONFIG = path.join(
  SERVER_DIR,
  "dist",
  "config",
  "config.e2e.yml",
);
export const BOOT_TIMEOUT_MS = 60_000;

// —— 协议形状（tianshu-server starter 包装体 + 控制协议事件） ——

/** starter 统一包装体（业务错 = HTTP 200 + success false / code 4xxx） */
export interface Envelope {
  success?: boolean;
  code?: string;
  data?: unknown;
  message?: string;
}

export interface ProtocolEvent {
  type: string;
  payload: Record<string, unknown>;
}

export interface RequestResult {
  status: number;
  body: Envelope | string | null;
}

/** 请求函数形态：DirectControl.request / RelayControl.request / 脚本内
 * `const request = (…) => control.request(…)` 闭包同构 */
export type RequestFn = (
  method: "GET" | "POST",
  reqPath: string,
  body?: unknown,
) => Promise<RequestResult>;

// —— 断言锚 + 包装体 call（前缀由各脚本传入，输出与归一前逐字一致） ——

export interface OutcomeRow {
  label: string;
  ok: boolean;
  detail: string;
}

export interface E2eReporter {
  /** 断言锚点汇总（终局打印 + 退出码依据） */
  readonly outcomes: OutcomeRow[];
  log(step: string, ...rest: unknown[]): void;
  pass(label: string, detail: string): void;
  fail(label: string, detail: string): never;
  /** 包装体展开判错（send/graph/run 的 202 同为 success 包装） */
  call(
    request: RequestFn,
    label: string,
    reqPath: string,
    body?: unknown,
    method?: "GET" | "POST",
  ): Promise<unknown>;
  /** 终局汇总打印（note 追加在汇总行尾）；返回失败断言数 */
  printSummary(note?: string): number;
}

export function createE2eReporter(prefix: string): E2eReporter {
  const outcomes: OutcomeRow[] = [];
  const log = (step: string, ...rest: unknown[]): void => {
    console.log(
      `[${prefix}] ${new Date().toISOString().slice(11, 19)} ${step}`,
      ...rest,
    );
  };
  const pass = (label: string, detail: string): void => {
    outcomes.push({ label, ok: true, detail });
    console.log(`[${prefix}] PASS ${label} — ${detail}`);
  };
  const fail = (label: string, detail: string): never => {
    outcomes.push({ label, ok: false, detail });
    throw new Error(`${label}: ${detail}`);
  };
  const callFn = async (
    request: RequestFn,
    label: string,
    reqPath: string,
    body?: unknown,
    method: "GET" | "POST" = "POST",
  ): Promise<unknown> => {
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
  };
  const printSummary = (note?: string): number => {
    const failed = outcomes.filter((o) => !o.ok);
    console.log(
      `\n[${prefix}] 结果汇总：${outcomes.length - failed.length}/${outcomes.length} 断言组通过${note ?? ""}`,
    );
    for (const o of outcomes) {
      console.log(`  ${o.ok ? "PASS" : "FAIL"}  ${o.label} — ${o.detail}`);
    }
    return failed.length;
  };
  return { outcomes, log, pass, fail, call: callFn, printSummary };
}

// —— 模型解析：env 全配 > mirror dev 库回退 > SKIP（e2e-smoke/graph 同款） ——

export interface ModelChoice {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  source: string;
}

/** onLog 注入各脚本前缀的 log（dev 库回退读取失败的告警行） */
export async function resolveModel(
  onLog: (step: string, ...rest: unknown[]) => void,
): Promise<ModelChoice | null> {
  const baseUrl = process.env.E2E_MODEL_BASE_URL;
  const apiKey = process.env.E2E_MODEL_API_KEY;
  const modelId = process.env.E2E_MODEL_MODEL;
  if (baseUrl && apiKey && modelId) {
    return { baseUrl, apiKey, modelId, source: "env E2E_MODEL_*" };
  }
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const dbPath = path.join(
      os.homedir(),
      ".tianshu",
      "dev",
      "database",
      "local.db",
    );
    if (!fs.existsSync(dbPath)) return null;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const provider = db
        .prepare(
          "SELECT id, baseUrl, apiKey FROM provider WHERE enabled = 1 AND apiKey IS NOT NULL AND baseUrl IS NOT NULL ORDER BY id LIMIT 1",
        )
        .get() as { id: number; baseUrl: string; apiKey: string } | undefined;
      if (!provider) return null;
      const model = db
        .prepare(
          "SELECT modelId FROM model WHERE providerId = ? AND enabled = 1 AND type = 'llm' ORDER BY id LIMIT 1",
        )
        .get(provider.id) as { modelId: string } | undefined;
      if (!model) return null;
      return {
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        modelId: model.modelId,
        source: `mirror dev 库 provider#${provider.id}`,
      };
    } finally {
      db.close();
    }
  } catch (e) {
    onLog(
      "dev 库回退读取失败（视为未配置）:",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

// —— 进程/端口基建 ——

export interface HandshakeInfo {
  port: number;
  token: string;
  instanceId: string;
}

export interface ScannedProcess {
  child: ChildProcess;
  /** 命中 waitFor 的首行原文（握手行/端口回显行） */
  matched: string;
  /** 后续 stdout 行等待（relay 客户端注册确认等；进程退出后挂起由调用方限时） */
  waitForLine(match: RegExp): Promise<string>;
  stderrTail(): string;
  /** stdout 尾部原文（bridge 冒烟失败路径打印用；其余脚本不用） */
  stdoutTail(): string;
}

/** spawn 并扫 stdout：waitFor 首次命中即 resolve，后续行仍喂 waitForLine */
export function spawnScan(
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
    const lineWaiters: Array<{
      match: RegExp;
      resolve: (line: string) => void;
    }> = [];
    const timer = setTimeout(() => {
      destroyChild(child);
      reject(
        new Error(
          `等待 ${String(waitFor)} 超时（${BOOT_TIMEOUT_MS}ms）；stderr 尾部：${stderr.slice(-500)}`,
        ),
      );
    }, BOOT_TIMEOUT_MS);
    const handleLine = (line: string): void => {
      for (let i = lineWaiters.length - 1; i >= 0; i -= 1) {
        if (lineWaiters[i].match.test(line)) {
          lineWaiters[i].resolve(line);
          lineWaiters.splice(i, 1);
        }
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutTail = (stdoutTail + chunk).slice(-4000);
      buffer += chunk;
      let boundary = buffer.indexOf("\n");
      while (boundary !== -1) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        handleLine(line);
        if (waitFor.test(line)) {
          clearTimeout(timer);
          resolve({
            child,
            matched: line,
            waitForLine: (match: RegExp) =>
              new Promise<string>((lineResolve) => {
                lineWaiters.push({ match, resolve: lineResolve });
              }),
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

export function destroyChild(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGKILL");
}

/** 优雅停：SIGTERM 等退出（3s），超窗 SIGKILL 兜底 */
export async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.kill("SIGTERM");
  await Promise.race([exited, delay(3000)]);
  destroyChild(child);
}

export function getFreePort(): Promise<number> {
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
export function parseHandshake(line: string): HandshakeInfo {
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

// —— 直连控制端：fetch + SSE 手写解析（DirectTransport wire 同口径；不复用
//    mirror transport——其依赖 electron Log，纯 node 下即抛错） ——

export class DirectControl {
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
        /* 非 JSON 原文透传（webhook 模板原样文本即此路） */
      }
    }
    return { status: response.status, body: parsed };
  }

  /** 原样响应（webhook @Res() 直发不经统一包装）：status/headers/text */
  async rawPost(
    reqPath: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<{ status: number; contentType: string; text: string }> {
    const response = await fetch(`${this.base}/${reqPath.replace(/^\//, "")}`, {
      method: "POST",
      headers: { ...this.headers, "content-type": "application/json" },
      body: JSON.stringify(body ?? null),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      text: await response.text(),
    };
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

  /** SSE 建流并逐帧入队（\n\n 分帧、注释行忽略、多 data 行拼接） */
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
export function parseSseBlock(block: string): ProtocolEvent | null {
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

/** 限时取下一事件（DirectControl / ControlSession 等事件源通用） */
export async function nextEventIn(
  control: { nextEvent(): Promise<ProtocolEvent> },
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

/** 单节点 hybridSearch 图 JSON（keyword 模式零模型门槛，中文 BM25/FTS
 * 冒烟；collection 由调用方传入——各脚本的隔离集合名不同） */
export function hybridSearchGraphJson(collection: string): string {
  return JSON.stringify({
    version: 1,
    inputSchema: {},
    nodes: [
      {
        id: "hs1",
        kind: "hybridSearch",
        name: "混合检索",
        searchQuery: "容错 设计",
        collection,
        mode: "keyword",
        topK: 3,
      },
    ],
    edges: [{ from: "hs1", to: "END" }],
  });
}

// —— PG 检索 seed 基建（e2e-graph-search-pg / e2e-main-pg 共用；pg 驱动经
//    root node_modules 解析，结构类型对齐 search-pg.ts 惯例） ——

export interface PgQueryResult {
  rows: unknown[];
}
export interface PgClientLike {
  query(sql: string, values?: unknown[]): Promise<PgQueryResult>;
  release(): void;
}
export interface PgPoolLike {
  query(sql: string, values?: unknown[]): Promise<PgQueryResult>;
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

/** 幂等建库（与 search-pg.ts PG_DDL 同款五语句——schema/扩展/表/GIN/复合
 * 索引，表限定 tianshu_search 独立 schema；进程边界内联不走 import） */
export const PG_DDL: string[] = [
  "CREATE SCHEMA IF NOT EXISTS tianshu_search",
  "CREATE EXTENSION IF NOT EXISTS vector",
  `CREATE TABLE IF NOT EXISTS tianshu_search.vector_chunk (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  collection TEXT NOT NULL,
  source_name TEXT NOT NULL,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  text_tsv tsvector NOT NULL,
  vector vector,
  model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
  "CREATE INDEX IF NOT EXISTS vector_chunk_tsv_gin ON tianshu_search.vector_chunk USING gin(text_tsv)",
  "CREATE INDEX IF NOT EXISTS vector_chunk_user_coll ON tianshu_search.vector_chunk (user_id, collection)",
];

/** 检索表清场（幂等；schema 级连清——表/索引随 schema 一并回收） */
export const DROP_SEARCH_SQL = "DROP SCHEMA IF EXISTS tianshu_search CASCADE";

/** upsert INSERT（与运行时 buildUpsertInsertSql 同款：每块 8 参，$6 分词文本
 * 经 to_tsvector、$7 向量字面量 ::vector） */
export function buildUpsertInsertSql(chunkCount: number): string {
  const rows = Array.from({ length: chunkCount }, (_, i) => {
    const b = i * 8;
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, to_tsvector('simple', $${b + 6}), $${b + 7}::vector, $${b + 8})`;
  });
  return `INSERT INTO tianshu_search.vector_chunk(user_id, collection, source_name, seq, text, text_tsv, vector, model)
VALUES ${rows.join(", ")}`;
}

export interface PgSeederOptions {
  /** 检索面按 userId 过滤——server 图运行恒为伴生用户（COMPANION_USER_ID=1） */
  userId: number;
  /** 各脚本的隔离集合名（e2e-pg-hybrid / e2e-main-pg-hybrid） */
  collection: string;
  /** seed 行 model 标记（排查用） */
  seedModel: string;
  /** 假向量（keyword 路不消费 vector 列；仅保 INSERT 形状与运行时一致） */
  fakeVector?: number[];
}

export interface PgSeeder {
  /** 条目级 upsert（DELETE+INSERT 事务——运行时 upsertChunksPg 同款形状；
   * 重跑同 (user_id, collection, source_name) 幂等） */
  upsertSeed(
    pool: PgPoolLike,
    tokenize: (text: string) => string[],
    sourceName: string,
    texts: string[],
  ): Promise<void>;
  /** collection 计数（运行时 countCollectionPg 同款语句） */
  countCollection(pool: PgPoolLike): Promise<number>;
}

export function createPgSeeder(opts: PgSeederOptions): PgSeeder {
  const fakeVector = opts.fakeVector ?? [0.1, 0.2, 0.3];
  const upsertSeed = async (
    pool: PgPoolLike,
    tokenize: (text: string) => string[],
    sourceName: string,
    texts: string[],
  ): Promise<void> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "DELETE FROM tianshu_search.vector_chunk WHERE user_id = $1 AND collection = $2 AND source_name = $3",
        [opts.userId, opts.collection, sourceName],
      );
      if (texts.length > 0) {
        await client.query(
          buildUpsertInsertSql(texts.length),
          texts.flatMap((text, seq) => [
            opts.userId,
            opts.collection,
            sourceName,
            seq,
            text,
            tokenize(text).join(" "),
            JSON.stringify(fakeVector),
            opts.seedModel,
          ]),
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };
  const countCollection = async (pool: PgPoolLike): Promise<number> => {
    const result = await pool.query(
      "SELECT COUNT(*)::int AS n FROM tianshu_search.vector_chunk WHERE user_id = $1 AND collection = $2",
      [opts.userId, opts.collection],
    );
    return Number((result.rows[0] as { n: number }).n);
  };
  return { upsertSeed, countCollection };
}
