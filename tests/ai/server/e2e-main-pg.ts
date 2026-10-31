/**
 * 主库 PG e2e（可选，门控 MAIN_PG_E2E_URL；未设则 SKIP）：真 server 子进程以
 * TIANSHU_DB_URL=postgres://… 启动（PG 主库模式，SEARCH_DB_URL 显式置空钉死
 * 「检索跟随主库」路径）→ 首启自动 db push（派生 schema）建 23 张业务表 →
 * graph save/run 走 PG 主库（API 行为 + 直查 graphDefinition 行双证，另证
 * 无 SQLite 落库文件）→ hybridSearch keyword 同库检索命中「容错设计手册｜
 * 相关度」+「旅行日记」剔除（跟随规则 §4 实证）→ 重启两跳（two-boot，终审
 * F1）：停服复启（每次启动都跑 db push）健康仍 ok 且检索行保全——检索表
 * 限定 tianshu_search 独立 schema，db push 对其视而不见；限 public 旧形态
 * 下非空 vector_chunk 必被判 drift（退出 1）永久起不来 → 清理（子进程 +
 * 检索 schema DROP；业务表留给 PG 卷/由外部清理——检索单真源原则延续）。
 * SQLite 路径由既有 e2e/Jest 覆盖。
 *
 * spawn/env 注入/直插/断言手法对齐 e2e-graph-search-pg.ts；一处刻意偏差：
 * 分词模块解析改经 createRequire(SERVER_DIR) 的 require.resolve
 * ("@tianshu/core")——本仓 worktree 布局下共享包 dist 不在仓内且
 * node_modules 软链指主树，server 进程实际装载的就是该解析位（同树同源
 * 不变式更直接的实现）。
 *
 * PG 起法（compose main-pg 端口未发布，e2e 用一次性容器）：
 *   docker run -d --rm --name mainpg-e2e -e POSTGRES_USER=t \
 *     -e POSTGRES_PASSWORD=t -e POSTGRES_DB=m -p 55432:5432 \
 *     pgvector/pgvector:pg17
 *   MAIN_PG_E2E_URL=postgres://t:t@127.0.0.1:55432/m npm run test:e2e:mainPg
 *
 * 运行：npm run test:e2e:mainPg（node 原生 strip-types，需 Node ≥ 23.6；
 * 文件名无 .test. 段不进 vitest 常规集；TIANSHU_E2E_SKIP_BUILD=1 可跳过
 * server 构建）
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const MIRROR_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const SERVER_DIR =
  process.env.TIANSHU_SERVER_DIR ??
  path.resolve(MIRROR_ROOT, "apps", "tianshu-server");
const SERVER_ENTRY = path.join(SERVER_DIR, "dist", "src", "main.js");
const E2E_CONFIG = path.join(SERVER_DIR, "dist", "config", "config.e2e.yml");
/** PG 生成物（prisma:generate:pg 产出，git-ignored）双落点：src 原位 +
 * dist 拷贝位（facade 编译产物 require('../../generated/prisma-pg') 解析处） */
const PG_CLIENT_SRC = path.join(SERVER_DIR, "src", "generated");
const PG_CLIENT_DIST = path.join(SERVER_DIR, "dist", "src", "generated");

const PG_URL = process.env.MAIN_PG_E2E_URL;
if (!PG_URL) {
  console.log(
    "SKIP: MAIN_PG_E2E_URL 未配置（docker compose --profile main-pg 起库后设置）",
  );
  process.exit(0);
}

/** 检索面按 userId 过滤——server 图运行恒为伴生用户（COMPANION_USER_ID=1） */
const USER_ID = 1;
const COLLECTION = "e2e-main-pg-hybrid";
const TARGET_SOURCE = "容错设计手册";
const OFF_TOPIC_SOURCE = "旅行日记";
const SEED_MODEL = "e2e-main-pg-seed";
/** 假向量（keyword 路不消费 vector 列；仅保 INSERT 形状与运行时一致） */
const FAKE_VECTOR = [0.1, 0.2, 0.3];
/** 派生 schema 的业务表数（23 model，db push 建表单源钉死；探针库实测） */
const EXPECTED_TABLES = 23;
const BOOT_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 120_000;

const outcomes: Array<{ label: string; ok: boolean; detail: string }> = [];

function log(step: string, ...rest: unknown[]): void {
  console.log(
    `[e2e-main-pg] ${new Date().toISOString().slice(11, 19)} ${step}`,
    ...rest,
  );
}

function pass(label: string, detail: string): void {
  outcomes.push({ label, ok: true, detail });
  console.log(`[e2e-main-pg] PASS ${label} — ${detail}`);
}

function fail(label: string, detail: string): never {
  outcomes.push({ label, ok: false, detail });
  throw new Error(`${label}: ${detail}`);
}

// —— PG 访问层（pg 驱动经 root node_modules 解析；结构类型对齐 search-pg.ts 惯例） ——

interface PgQueryResult {
  rows: unknown[];
}
interface PgClientLike {
  query(sql: string, values?: unknown[]): Promise<PgQueryResult>;
  release(): void;
}
interface PgPoolLike {
  query(sql: string, values?: unknown[]): Promise<PgQueryResult>;
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

/** 幂等建库（与 search-pg.ts PG_DDL 同款五语句——schema/扩展/表/GIN/复合
 * 索引，表限定 tianshu_search 独立 schema；进程边界内联不走 import） */
const PG_DDL: string[] = [
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
const DROP_SEARCH_SQL =
  "DROP SCHEMA IF EXISTS tianshu_search CASCADE";

/** upsert INSERT（与运行时 buildUpsertInsertSql 同款：每块 8 参，$6 分词文本
 * 经 to_tsvector、$7 向量字面量 ::vector） */
function buildUpsertInsertSql(chunkCount: number): string {
  const rows = Array.from({ length: chunkCount }, (_, i) => {
    const b = i * 8;
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, to_tsvector('simple', $${b + 6}), $${b + 7}::vector, $${b + 8})`;
  });
  return `INSERT INTO tianshu_search.vector_chunk(user_id, collection, source_name, seq, text, text_tsv, vector, model)
VALUES ${rows.join(", ")}`;
}

/** 条目级 upsert（DELETE+INSERT 事务——运行时 upsertChunksPg 同款形状） */
async function upsertSeed(
  pool: PgPoolLike,
  tokenize: (text: string) => string[],
  sourceName: string,
  texts: string[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM tianshu_search.vector_chunk WHERE user_id = $1 AND collection = $2 AND source_name = $3",
      [USER_ID, COLLECTION, sourceName],
    );
    if (texts.length > 0) {
      await client.query(
        buildUpsertInsertSql(texts.length),
        texts.flatMap((text, seq) => [
          USER_ID,
          COLLECTION,
          sourceName,
          seq,
          text,
          tokenize(text).join(" "),
          JSON.stringify(FAKE_VECTOR),
          SEED_MODEL,
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
}

/** 单值查询（COUNT 等） */
async function scalar(
  pool: PgPoolLike,
  sql: string,
  values?: unknown[],
): Promise<number> {
  const result = await pool.query(sql, values);
  return Number((result.rows[0] as { n: number }).n);
}

// —— 进程/端口/协议基建（e2e-graph-search-pg 同款，裁剪至本脚本所需面） ——

interface HandshakeInfo {
  port: number;
  token: string;
  instanceId: string;
}

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

function spawnScan(
  command: string,
  args: string[],
  waitFor: RegExp,
  extraEnv: Record<string, string>,
): Promise<{ child: ChildProcess; matched: string; stderrTail: () => string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...extraEnv },
      cwd: SERVER_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
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
      buffer += chunk;
      let boundary = buffer.indexOf("\n");
      while (boundary !== -1) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        if (waitFor.test(line)) {
          clearTimeout(timer);
          resolve({ child, matched: line, stderrTail: () => stderr });
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

/** 包装体展开判错（graph/run 的 202 同为 success 包装） */
async function call(
  request: (
    method: "GET" | "POST",
    reqPath: string,
    body?: unknown,
  ) => Promise<RequestResult>,
  label: string,
  reqPath: string,
  body?: unknown,
): Promise<unknown> {
  const result = await request("POST", reqPath, body);
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

/** 直连控制端：fetch + SSE 手写解析（e2e-smoke 同款） */
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

/** 单节点 hybridSearch 图 JSON（keyword 模式零模型门槛，中文 FTS 断言） */
function hybridSearchGraphJson(): string {
  return JSON.stringify({
    version: 1,
    inputSchema: {},
    nodes: [
      {
        id: "hs1",
        kind: "hybridSearch",
        name: "混合检索",
        searchQuery: "容错 设计",
        collection: COLLECTION,
        mode: "keyword",
        topK: 3,
      },
    ],
    edges: [{ from: "hs1", to: "END" }],
  });
}

/** 健康探测（带重试）：握手行后仍容忍 db push 尾延/网络抖动，30s 内
 * status=ok 才放行（T5 停留竞态的 e2e 侧兜底）。/actuator/health 在
 * ResponseInterceptor 排除表——terminus 原生 {status:"ok"}；StaticTokenGuard
 * 不豁免 @Public，须带 Bearer。 */
async function waitForHealth(
  request: (
    method: "GET" | "POST",
    reqPath: string,
    body?: unknown,
  ) => Promise<RequestResult>,
): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let last = "（未探测）";
  for (;;) {
    try {
      const result = await request("GET", "/actuator/health");
      const parsed =
        typeof result.body === "object" && result.body !== null
          ? (result.body as { status?: unknown; data?: { status?: unknown } })
          : null;
      last = `HTTP ${result.status} body=${JSON.stringify(result.body).slice(0, 200)}`;
      if (
        result.status === 200 &&
        (parsed?.status === "ok" || parsed?.data?.status === "ok")
      ) {
        return;
      }
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (Date.now() >= deadline) {
      fail("健康探测", `${HEALTH_TIMEOUT_MS}ms 内未就绪：${last}`);
    }
    await delay(1000);
  }
}

// —— 主流程 ——

async function main(): Promise<number> {
  log(
    "主库 PG e2e 启动",
    `MAIN_PG_E2E_URL=${PG_URL.replace(/:[^:@/]+@/, ":***@")}`,
  );

  // 分词单源：从 SERVER_DIR 解析 @tianshu/core 实际装载位（spawn 的 server
  // 进程同一棵解析树——同树同源不变式；worktree packages dist 不存在时解析
  // 落 node_modules 软链的主树 dist，与 server 运行时一致）
  const requireFromServer = createRequire(SERVER_DIR);
  let coreDir: string;
  try {
    coreDir = path.dirname(requireFromServer.resolve("@tianshu/core"));
  } catch {
    fail(
      "core 包分词模块",
      "无法从 apps/tianshu-server 解析 @tianshu/core（先跑 server 侧 npm run sync:core 重建共享包 dist）",
    );
  }
  const CORE_RETRIEVAL = path.join(coreDir, "retrieval.js");
  if (!fs.existsSync(CORE_RETRIEVAL)) {
    fail(
      "core 包分词模块",
      `${CORE_RETRIEVAL} 不存在——先重建共享包 dist（server 侧 npm run sync:core）`,
    );
  }
  const { tokenize } = (await import(pathToFileURL(CORE_RETRIEVAL))) as {
    tokenize: (text: string) => string[];
  };
  if (typeof tokenize !== "function") {
    fail(
      "core 包分词模块",
      "dist 导出缺 tokenize（陈旧产物？重建共享包 dist）",
    );
  }
  log(`分词单源：${CORE_RETRIEVAL}`);

  if (!fs.existsSync(path.join(PG_CLIENT_SRC, "prisma-pg"))) {
    fail(
      "PG 生成物",
      `${PG_CLIENT_SRC}/prisma-pg 不存在——先在 apps/tianshu-server 执行 npm run prisma:generate:pg`,
    );
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
        `[e2e-main-pg] FAIL：构建失败\n${(build.stderr ?? "").slice(-2000)}`,
      );
      return 1;
    }
  }
  if (!fs.existsSync(SERVER_ENTRY)) {
    console.error(
      `[e2e-main-pg] FAIL：无头端产物不存在 ${SERVER_ENTRY}（先在 tianshu-server 执行 npm run build）`,
    );
    return 1;
  }
  // PG 生成物随行：nest build 经 nest-cli assets 自动拷 src/generated →
  // dist/src/generated（终审 F3；dist/src/generated 是 facade require 的解析
  // 位）。自拷兜底保留——TIANSHU_E2E_SKIP_BUILD 配旧 dist 时 assets 可能缺席
  if (!fs.existsSync(PG_CLIENT_DIST)) {
    fs.cpSync(PG_CLIENT_SRC, PG_CLIENT_DIST, { recursive: true });
    log(
      `PG 生成物拷贝：src/generated → dist/src/generated（${PG_CLIENT_DIST}）`,
    );
  }

  const { Pool } = (await import("pg")) as unknown as {
    Pool: new (opts: { connectionString: string }) => PgPoolLike;
  };
  const pool: PgPoolLike = new Pool({ connectionString: PG_URL });

  const dataRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tianshu-e2e-mainpg-"),
  );
  let child: ChildProcess | null = null;
  let control: DirectControl | null = null;
  try {
    // 1. PG 可达性预检（容器 initdb 竞态兜底：SELECT 1 重试至多 30s）+
    //    检索 schema 清场（幂等 DROP CASCADE；主库业务表不清——首启建库由
    //    server 自证）
    const pgDeadline = Date.now() + HEALTH_TIMEOUT_MS;
    for (;;) {
      try {
        await pool.query("SELECT 1");
        break;
      } catch (e) {
        if (Date.now() >= pgDeadline) {
          fail(
            "PG 可达性",
            `${HEALTH_TIMEOUT_MS}ms 内连接失败：${e instanceof Error ? e.message : String(e)}`,
          );
        }
        await delay(1000);
      }
    }
    await pool.query(DROP_SEARCH_SQL);
    pass(
      "PG 预检",
      "连接可达 + 检索 schema tianshu_search 清场（DROP CASCADE）",
    );

    // 2. spawn server 子进程：主库指真 PG（TIANSHU_DB_URL=postgres://…），
    //    SEARCH_DB_URL 显式置空——钉死「检索跟随主库」分支（§4）
    const port = await getFreePort();
    fs.writeFileSync(
      E2E_CONFIG,
      `# e2e-main-pg 生成（运行完自动删除）\napp:\n  port: ${port}\n`,
    );
    const spawned = await spawnScan(
      process.execPath,
      [SERVER_ENTRY],
      /^TIANSHU_HANDSHAKE /,
      {
        NODE_ENV: "e2e",
        TIANSHU_TOKEN: "e2e-main-pg-token",
        TIANSHU_DATA_ROOT: dataRoot,
        TIANSHU_DB_URL: PG_URL,
        SEARCH_DB_URL: "",
      },
    );
    child = spawned.child;
    const info = parseHandshake(spawned.matched);
    if (info.token !== "e2e-main-pg-token" || info.port !== port) {
      fail(
        "server spawn+握手",
        `token/port 未按 env 回显（token=${info.token} port=${info.port} ≠ 配置 ${port}）`,
      );
    }
    pass(
      "server spawn+握手（PG 主库模式）",
      `port=${info.port} instanceId=${info.instanceId}`,
    );

    control = new DirectControl(info.port, info.token);
    const request = (
      method: "GET" | "POST",
      reqPath: string,
      body?: unknown,
    ): Promise<RequestResult> =>
      (control as DirectControl).request(method, reqPath, body);

    // 3. 健康（带重试）+ 首启建库实证：boot 自动 db push（派生 schema）
    //    → 23 张业务表 + graphDefinition 在位（直查 information_schema）
    await waitForHealth(request);
    const tables = await scalar(
      pool,
      "SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    if (tables !== EXPECTED_TABLES) {
      const names = await pool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
      );
      fail(
        "首启建库（boot db push）",
        `业务表数期望 ${EXPECTED_TABLES} 实为 ${tables}：${names.rows.map((r) => (r as { table_name: string }).table_name).join(",")}`,
      );
    }
    const graphTable = await scalar(
      pool,
      `SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'graphDefinition'`,
    );
    if (graphTable !== 1) {
      fail("首启建库（boot db push）", "graphDefinition 表不在 PG 中");
    }
    pass(
      "首启建库（boot db push）+ 健康",
      `/actuator/health ok；public 业务表 ${tables} 张，graphDefinition 在位`,
    );

    // 4. graph save 走 PG 主库：API 受理 + 直查 "graphDefinition" 行双证
    //    （camelCase 物理名须引号），另证引擎确未落 SQLite 文件
    const graph = (await call(request, "graph/save", "graph/save", {
      name: "e2e-main-pg 同库检索图",
      graphJson: hybridSearchGraphJson(),
    })) as { id: number; nodeCount: number };
    if (graph.nodeCount !== 1) {
      fail("graph/save", `nodeCount 期望 1 实为 ${graph.nodeCount}`);
    }
    const graphRows = await scalar(
      pool,
      `SELECT COUNT(*)::int AS n FROM "graphDefinition" WHERE id = $1`,
      [graph.id],
    );
    if (graphRows !== 1) {
      fail(
        "graph/save 落 PG",
        `API 受理 id=${graph.id} 但 PG "graphDefinition" 行数 ${graphRows} ≠ 1`,
      );
    }
    const sqlitePath = path.join(dataRoot, "database", "local.db");
    if (fs.existsSync(sqlitePath)) {
      fail("graph/save 落 PG", `引擎误落 SQLite：${sqlitePath} 存在`);
    }
    pass(
      "graph/save 走 PG 主库",
      `id=${graph.id} nodeCount=1；PG 行在位；无 SQLite 落库文件`,
    );

    // 5. 检索跟随：tianshu_search.vector_chunk 直插同库（search-pg 同款
    //    seed）→ hybridSearch keyword run → 命中/剔除断言
    const targetTexts = [
      "高可用架构在设计阶段须引入容错机制，故障隔离与优雅降级是容错设计的第一道防线。",
      "容错设计要求重试、熔断与幂等配合，避免局部故障在设计不当的链路上被放大为全局雪崩。",
    ];
    const offTopicTexts = [
      "今天的行程是京都的寺庙巡礼与宇治抹茶甜品，傍晚沿鸭川散步。",
    ];
    for (const ddl of PG_DDL) {
      await pool.query(ddl);
    }
    await upsertSeed(pool, tokenize, TARGET_SOURCE, targetTexts);
    await upsertSeed(pool, tokenize, OFF_TOPIC_SOURCE, offTopicTexts);
    const seeded = await scalar(
      pool,
      "SELECT COUNT(*)::int AS n FROM tianshu_search.vector_chunk WHERE user_id = $1 AND collection = $2",
      [USER_ID, COLLECTION],
    );
    if (seeded !== 3) {
      fail("检索表同库 seed", `首播计数期望 3 实为 ${seeded}`);
    }
    pass(
      "检索表同库 seed",
      `tianshu_search.vector_chunk（主库同库）「${TARGET_SOURCE}」×2 +「${OFF_TOPIC_SOURCE}」×1`,
    );

    const accepted = (await call(request, "graph/run", "graph/run", {
      graphId: graph.id,
      inputs: {},
    })) as { runId: number };
    log(`graph#${graph.id} run#${accepted.runId} 已受理（keyword）`);

    let state = "";
    let output = "";
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    while (state !== "succeeded" && state !== "failed") {
      const event = await nextEventIn(
        control,
        Math.max(1, deadline - Date.now()),
        "graph.run.updated 事件",
      );
      if (event.type !== "graph.run.updated") continue;
      const payload = event.payload as {
        runId?: number;
        graphId?: number;
        state?: string;
        output?: string;
        error?: string;
      };
      if (payload.runId !== accepted.runId || payload.graphId !== graph.id) {
        continue;
      }
      if (
        payload.state &&
        payload.state !== "running" &&
        payload.state !== "progress"
      ) {
        state = payload.state;
        output = payload.output ?? payload.error ?? "";
      }
    }
    if (state !== "succeeded") {
      fail("hybridSearch 执行", `终态 ${state}（${output.slice(0, 200)}）`);
    }
    if (!output.includes(TARGET_SOURCE) || !output.includes("相关度")) {
      fail(
        "hybridSearch keyword 中文命中（跟随主库）",
        `输出未含「${TARGET_SOURCE}｜相关度」：${output.slice(0, 200)}`,
      );
    }
    if (output.includes(OFF_TOPIC_SOURCE)) {
      fail(
        "hybridSearch keyword 中文命中（跟随主库）",
        `零词元交集条目「${OFF_TOPIC_SOURCE}」未被剔除（疑似全量透传）：${output.slice(0, 200)}`,
      );
    }
    pass(
      "hybridSearch keyword 中文命中（跟随主库）",
      `SEARCH_DB_URL 空 → 主库同库检索；run#${accepted.runId} succeeded；output「${output.slice(0, 60)}」`,
    );

    // 6. 重启两跳（two-boot，终审 F1 断言组）：检索表已有数据 → 停服 →
    //    复启（ensureDatabasePg 每次启动都跑 db push）→ 健康仍 ok 且检索
    //    行保全。检索表限 tianshu_search 独立 schema，db push（只管 public
    //    业务面）对其视而不见；若仍落 public，非空 vector_chunk 会被判
    //    drift（db push 拒绝 drop 非空表、退出 1）→ 第二次 boot 必炸。
    control?.close();
    control = null;
    await stopChild(child);
    child = null;
    const respawned = await spawnScan(
      process.execPath,
      [SERVER_ENTRY],
      /^TIANSHU_HANDSHAKE /,
      {
        NODE_ENV: "e2e",
        TIANSHU_TOKEN: "e2e-main-pg-token",
        TIANSHU_DATA_ROOT: dataRoot,
        TIANSHU_DB_URL: PG_URL,
        SEARCH_DB_URL: "",
      },
    );
    child = respawned.child;
    const info2 = parseHandshake(respawned.matched);
    if (info2.token !== "e2e-main-pg-token" || info2.port !== port) {
      fail(
        "重启握手（two-boot）",
        `token/port 未按 env 回显（token=${info2.token} port=${info2.port} ≠ 配置 ${port}）`,
      );
    }
    control = new DirectControl(info2.port, info2.token);
    await waitForHealth(request);
    const survived = await scalar(
      pool,
      "SELECT COUNT(*)::int AS n FROM tianshu_search.vector_chunk WHERE user_id = $1 AND collection = $2",
      [USER_ID, COLLECTION],
    );
    if (survived !== 3) {
      fail(
        "重启两跳：检索行保全",
        `第二次 boot 后计数期望 3 实为 ${survived}（检索表疑似被 db push 判 drift 清除）`,
      );
    }
    const tablesAfterReboot = await scalar(
      pool,
      "SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    if (tablesAfterReboot !== EXPECTED_TABLES) {
      fail(
        "重启两跳：业务表幂等",
        `第二次 boot 后 public 业务表期望 ${EXPECTED_TABLES} 实为 ${tablesAfterReboot}`,
      );
    }
    pass(
      "重启两跳（two-boot）",
      `第二次 boot 健康 ok；tianshu_search.vector_chunk 检索行 ${survived} 保全；public 业务表 ${tablesAfterReboot} 张（db push 复跑幂等）`,
    );

    // 7. 清理：检索 schema DROP CASCADE（主库业务表留给 PG 卷/外部清理——
    //    一次性容器随销毁；收敛段在 finally 保失败路径同样回收）
    await pool.query(DROP_SEARCH_SQL);
    pass("PG 清理", "tianshu_search schema 已 DROP（业务表留存，随容器/卷销毁）");
  } finally {
    control?.close();
    await stopChild(child);
    await pool.query(DROP_SEARCH_SQL).catch(() => {});
    await pool.end().catch(() => {});
    fs.rmSync(E2E_CONFIG, { force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }

  const failed = outcomes.filter((o) => !o.ok);
  console.log(
    `\n[e2e-main-pg] 结果汇总：${outcomes.length - failed.length}/${outcomes.length} 断言组通过`,
  );
  for (const o of outcomes) {
    console.log(`  ${o.ok ? "PASS" : "FAIL"}  ${o.label} — ${o.detail}`);
  }
  return failed.length > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(
      `[e2e-main-pg] 阶段失败：${e instanceof Error ? e.message : e}`,
    );
    const failed = outcomes.filter((o) => !o.ok);
    for (const o of failed) {
      console.log(`  FAIL  ${o.label} — ${o.detail}`);
    }
    process.exit(1);
  });
