/**
 * PG 检索层 e2e（可选，门控 SEARCH_E2E_PG_URL；未设则 SKIP）：
 * 真 server 子进程（注入 SEARCH_DB_URL）→ vectorChunk 直插中文样本
 * （带假向量，绕过 vectorize 的真 embedding 依赖——对齐 e2e-graph-smoke 的
 * seedHybridChunks 手法但写向 PG）→ hybridSearch keyword 模式命中/剔除断言
 * → 重跑同款 upsert（DELETE+INSERT 事务，语句形状同运行时 upsertChunksPg）
 * 幂等（collection 计数不翻倍）。semantic/hybrid 的向量 SQL 语义由单测钉板
 * （e2e 免真模型外呼），spec 已显式此取舍。
 *
 * 直插 SQL 内联自 search-pg.ts 同款（DDL/INSERT 占位序/计数语句），不
 * import server 内部模块——e2e 走进程边界；分词与 server 同源
 * （@tianshu/core 的 tokenize，经 worktree 包 dist 绝对路径装载——裸模块名
 * 会命中主树 node_modules 的陈旧 dist，见脚本内注释）。PG 由 docker compose
 * 起 search-pg（起法见 apps/tianshu-server/README.md PG 检索模式段；宿主
 * 5432 被占时用 compose override 映射空闲宿主端口，URL 随之指向该端口）。
 *
 * 运行：npm run test:e2e:graphPg（node 原生 strip-types，需 Node ≥ 23.6；
 * 文件名无 .test. 段不进 vitest 常规集；TIANSHU_E2E_SKIP_BUILD=1 可跳过
 * server 构建）
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const MIRROR_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const SERVER_DIR =
  process.env.TIANSHU_SERVER_DIR ??
  path.resolve(MIRROR_ROOT, "apps", "tianshu-server");
const SERVER_ENTRY = path.join(SERVER_DIR, "dist", "src", "main.js");
const E2E_CONFIG = path.join(SERVER_DIR, "dist", "config", "config.e2e.yml");
/** core 包 dist 的检索模块（tokenize 单源）：绕过 node_modules 解析——
 * worktree node_modules 软链指主树，主树 dist 未必含 retrieval（未重建），

 * 绝对路径恒指向脚本所在树的包产物，与 server 侧 overlay 同树同源 */
const CORE_RETRIEVAL = path.join(
  MIRROR_ROOT,
  "packages",
  "tianshu-core",
  "dist",
  "retrieval.js",
);

const PG_URL = process.env.SEARCH_E2E_PG_URL;
if (!PG_URL) {
  console.log("SKIP: SEARCH_E2E_PG_URL 未配置（docker compose up search-pg 后设置）");
  process.exit(0);
}

/** 检索面按 userId 过滤——server 图运行恒为伴生用户（COMPANION_USER_ID=1） */
const USER_ID = 1;
const COLLECTION = "e2e-pg-hybrid";
const TARGET_SOURCE = "容错设计手册";
const OFF_TOPIC_SOURCE = "旅行日记";
const SEED_MODEL = "e2e-pg-seed";
/** 假向量（keyword 路不消费 vector 列；仅保 INSERT 形状与运行时一致） */
const FAKE_VECTOR = [0.1, 0.2, 0.3];
const BOOT_TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_MS = 120_000;

const outcomes: Array<{ label: string; ok: boolean; detail: string }> = [];

function log(step: string, ...rest: unknown[]): void {
  console.log(
    `[e2e-graph-pg] ${new Date().toISOString().slice(11, 19)} ${step}`,
    ...rest,
  );
}

function pass(label: string, detail: string): void {
  outcomes.push({ label, ok: true, detail });
  console.log(`[e2e-graph-pg] PASS ${label} — ${detail}`);
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

/** 幂等建库（与 search-pg.ts PG_DDL 同款四语句，进程边界内联不走 import） */
const PG_DDL: string[] = [
  "CREATE EXTENSION IF NOT EXISTS vector",
  `CREATE TABLE IF NOT EXISTS vector_chunk (
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
  "CREATE INDEX IF NOT EXISTS vector_chunk_tsv_gin ON vector_chunk USING gin(text_tsv)",
  "CREATE INDEX IF NOT EXISTS vector_chunk_user_coll ON vector_chunk (user_id, collection)",
];

/** upsert INSERT（与运行时 buildUpsertInsertSql 同款：每块 8 参，$6 分词文本
 * 经 to_tsvector、$7 向量字面量 ::vector） */
function buildUpsertInsertSql(chunkCount: number): string {
  const rows = Array.from({ length: chunkCount }, (_, i) => {
    const b = i * 8;
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, to_tsvector('simple', $${b + 6}), $${b + 7}::vector, $${b + 8})`;
  });
  return `INSERT INTO vector_chunk(user_id, collection, source_name, seq, text, text_tsv, vector, model)
VALUES ${rows.join(", ")}`;
}

/** 条目级 upsert（DELETE+INSERT 事务——运行时 upsertChunksPg 同款形状；
 * 重跑同 (user_id, collection, source_name) 幂等） */
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
      "DELETE FROM vector_chunk WHERE user_id = $1 AND collection = $2 AND source_name = $3",
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

/** collection 计数（运行时 countCollectionPg 同款语句） */
async function countCollection(pool: PgPoolLike): Promise<number> {
  const result = await pool.query(
    "SELECT COUNT(*)::int AS n FROM vector_chunk WHERE user_id = $1 AND collection = $2",
    [USER_ID, COLLECTION],
  );
  return Number((result.rows[0] as { n: number }).n);
}

// —— 进程/端口/协议基建（e2e-graph-smoke 同款，裁剪至本脚本所需面） ——

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

/** 直连控制端：fetch + SSE 手写解析（e2e-smoke 同款，裁剪掉 rawPost） */
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

// —— 主流程 ——

async function main(): Promise<number> {
  log("PG 检索层 e2e 启动", `SEARCH_E2E_PG_URL=${PG_URL.replace(/:[^:@/]+@/, ":***@")}`);

  if (!fs.existsSync(CORE_RETRIEVAL)) {
    fail(
      "core 包分词模块",
      `${CORE_RETRIEVAL} 不存在——先重建共享包 dist（根 npm --prefix packages/tianshu-core run build）`,
    );
  }
  const { tokenize } = (await import(
    pathToFileURL(CORE_RETRIEVAL).href
  )) as { tokenize: (text: string) => string[] };
  if (typeof tokenize !== "function") {
    fail("core 包分词模块", "dist 导出缺 tokenize（陈旧产物？重建共享包 dist）");
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
        `[e2e-graph-pg] FAIL：构建失败\n${(build.stderr ?? "").slice(-2000)}`,
      );
      return 1;
    }
  }
  if (!fs.existsSync(SERVER_ENTRY)) {
    console.error(
      `[e2e-graph-pg] FAIL：无头端产物不存在 ${SERVER_ENTRY}（先在 tianshu-server 执行 npm run build）`,
    );
    return 1;
  }

  const { Pool } = (await import("pg")) as unknown as {
    Pool: new (opts: { connectionString: string }) => PgPoolLike;
  };
  const pool: PgPoolLike = new Pool({ connectionString: PG_URL });

  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-e2e-pg-"));
  let child: ChildProcess | null = null;
  let control: DirectControl | null = null;
  try {
    // 1. 直连 PG：清场 + 幂等建库（与运行时 PG_DDL 同款）
    await pool.query("DROP TABLE IF EXISTS vector_chunk");
    for (const ddl of PG_DDL) {
      await pool.query(ddl);
    }
    pass("PG 建库", "DROP 清场 + 扩展/表/GIN·复合索引四语句 DDL 就绪");

    // 2. 中文样本直插（目标条目两块均含「容错/设计」词元；无关条目零词元
    //    交集——FTS 真匹配而非全量透传的反证）
    const targetTexts = [
      "高可用架构在设计阶段须引入容错机制，故障隔离与优雅降级是容错设计的第一道防线。",
      "容错设计要求重试、熔断与幂等配合，避免局部故障在设计不当的链路上被放大为全局雪崩。",
    ];
    const offTopicTexts = ["今天的行程是京都的寺庙巡礼与宇治抹茶甜品，傍晚沿鸭川散步。"];
    await upsertSeed(pool, tokenize, TARGET_SOURCE, targetTexts);
    await upsertSeed(pool, tokenize, OFF_TOPIC_SOURCE, offTopicTexts);
    const seeded = await countCollection(pool);
    if (seeded !== 3) {
      fail("中文样本直插", `首播计数期望 3 实为 ${seeded}`);
    }
    pass("中文样本直插", `「${TARGET_SOURCE}」×2 +「${OFF_TOPIC_SOURCE}」×1，collection 计数 ${seeded}`);

    // 3. spawn server 子进程：主库指临时 SQLite（e2e-graph-smoke 的 SERVER_DB
    //    模式），检索库注入 SEARCH_DB_URL 指向真 PG
    const port = await getFreePort();
    fs.writeFileSync(
      E2E_CONFIG,
      `# e2e-graph-search-pg 生成（运行完自动删除）\napp:\n  port: ${port}\n`,
    );
    const spawned = await spawnScan(
      process.execPath,
      [SERVER_ENTRY],
      /^TIANSHU_HANDSHAKE /,
      {
        NODE_ENV: "e2e",
        TIANSHU_TOKEN: "e2e-graph-pg-token",
        TIANSHU_DATA_ROOT: dataRoot,
        TIANSHU_DB_URL: path.join(dataRoot, "database", "local.db"),
        SEARCH_DB_URL: PG_URL,
      },
    );
    child = spawned.child;
    const info = parseHandshake(spawned.matched);
    if (info.token !== "e2e-graph-pg-token" || info.port !== port) {
      fail(
        "server spawn+握手",
        `token/port 未按 env 回显（token=${info.token} port=${info.port} ≠ 配置 ${port}）`,
      );
    }
    pass(
      "server spawn+握手（SEARCH_DB_URL 注入）",
      `port=${info.port} instanceId=${info.instanceId}`,
    );

    control = new DirectControl(info.port, info.token);
    const request = (
      method: "GET" | "POST",
      reqPath: string,
      body?: unknown,
    ): Promise<RequestResult> =>
      (control as DirectControl).request(method, reqPath, body);

    // 4. hybridSearch keyword 图 → run → 事件至终态 → 命中/剔除断言
    const graph = (await call(request, "graph/save", "graph/save", {
      name: "e2e-graph-search-pg 混合检索图",
      graphJson: hybridSearchGraphJson(),
    })) as { id: number; nodeCount: number };
    if (graph.nodeCount !== 1) {
      fail("graph/save", `nodeCount 期望 1 实为 ${graph.nodeCount}`);
    }
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
        "hybridSearch keyword 中文命中",
        `输出未含「${TARGET_SOURCE}｜相关度」：${output.slice(0, 200)}`,
      );
    }
    if (output.includes(OFF_TOPIC_SOURCE)) {
      fail(
        "hybridSearch keyword 中文命中",
        `零词元交集条目「${OFF_TOPIC_SOURCE}」未被剔除（疑似全量透传）：${output.slice(0, 200)}`,
      );
    }
    pass(
      "hybridSearch keyword 中文命中",
      `run#${accepted.runId} succeeded；output「${output.slice(0, 60)}」`,
    );

    // 5. 幂等探针：重跑同款 upsert（同 user/collection/source_name）→ 计数不翻倍
    await upsertSeed(pool, tokenize, TARGET_SOURCE, targetTexts);
    await upsertSeed(pool, tokenize, OFF_TOPIC_SOURCE, offTopicTexts);
    const reseeded = await countCollection(pool);
    if (reseeded !== 3) {
      fail(
        "upsert 幂等",
        `重播后 collection 计数期望 3（不翻倍）实为 ${reseeded}`,
      );
    }
    pass("upsert 幂等", `同键重播后计数 ${seeded} → ${reseeded}（DELETE+INSERT 事务不翻倍）`);

    // 收敛：图删除（临时主库随之弃置）
    await call(request, "graph/delete 收敛", "graph/delete", { id: graph.id });

    // 6. PG 清理
    await pool.query("DROP TABLE IF EXISTS vector_chunk");
    pass("PG 清理", "vector_chunk 已 DROP");
  } finally {
    control?.close();
    await stopChild(child);
    await pool.end().catch(() => {});
    fs.rmSync(E2E_CONFIG, { force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }

  const failed = outcomes.filter((o) => !o.ok);
  console.log(
    `\n[e2e-graph-pg] 结果汇总：${outcomes.length - failed.length}/${outcomes.length} 断言组通过`,
  );
  for (const o of outcomes) {
    console.log(`  ${o.ok ? "PASS" : "FAIL"}  ${o.label} — ${o.detail}`);
  }
  return failed.length > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`[e2e-graph-pg] 阶段失败：${e instanceof Error ? e.message : e}`);
    const failed = outcomes.filter((o) => !o.ok);
    for (const o of failed) {
      console.log(`  FAIL  ${o.label} — ${o.detail}`);
    }
    process.exit(1);
  });
