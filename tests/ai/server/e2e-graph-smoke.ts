/**
 * 编排 E2E 冒烟（GA-T9，直连链路真模型）：capability graph 链路三段
 * ① graph：建两节点图（research → report）→ graph/run 202 → SSE 收
 *    graph.run.updated 至 succeeded 且带 output（事件序列含节点 progress）
 * ② automation：tickMs=200 经 NODE_ENV=e2e 的 config.e2e.yml（tianshu 段）
 *    快进调度——once 任务 runAt=+3s 到期触发 → SSE automation.changed +
 *    run 表落 triggerType=schedule/status=success（九端点无 run 查询面，
 *    run 表经 node:sqlite 只读直查——库址由 schema 字面量定死落
 *    tianshu-server 仓 prisma/local.db，e2e-smoke 同一事实面）
 * ③ webhook：实例间经 option 表预置注册（webhook 注册无 HTTP 端点——
 *    Ruling 13 service 级；reloadRegistrations 仅启动装载，故重启一次
 *    实例 2）→ POST /webhook/<token>（同步模板模式）→ 自定义模板渲染
 *    {{input.topic}}/{{nodes.report.output}} 原样文本往返 + run 表
 *    triggerType=webhook
 *
 * 复用 e2e-smoke.ts 手法：spawn dist/src/main.js + TIANSHU_HANDSHAKE 握手
 * 行 + 原生 fetch/SSE 手写解析（不复用 mirror transport——其依赖 electron
 * Log，纯 node 下即抛错）；真模型 env E2E_MODEL_* > mirror dev 库回退 >
 * SKIP（preflight Ruling 3）；模型端点不可达同样 SKIP（真模型不可得）。
 * 数据收敛：provider 按名 upsert 不删（幂等先例）；图/任务经端点删除，
 * graph/delete 触发 GA-T3 钩子连带清 webhook option 行；TIANSHU_DATA_ROOT
 * 指向临时目录隔离会话/回收站产物。
 *
 * 运行：npm run test:e2e:graph（node 原生 strip-types，需 Node ≥ 23.6；
 * 文件名无 .test. 段不进 vitest 常规集；TIANSHU_E2E_SKIP_BUILD=1 可跳过
 * server 构建）
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
/** run 表直查库（回归修复 2026-10-27：随 spawn 的 TIANSHU_DB_URL 动态
 * 指向临时库——此前字面量指仓内 prisma/local.db，server 库落点切临时
 * 库后直查全空；spawn 处就位） */
let SERVER_DB = path.join(SERVER_DIR, "prisma", "local.db");

const PROVIDER_NAME = "e2e-graph-smoke";
const GRAPH_NODE_SECOND = "report";
const ONCE_LEAD_MS = 3_000;
const BOOT_TIMEOUT_MS = 60_000;
const EVENT_TIMEOUT_MS = 20_000;
const RUN_TIMEOUT_MS = 120_000;

/** 断言锚点汇总（终局打印 + 退出码依据） */
const outcomes: Array<{ label: string; ok: boolean; detail: string }> = [];

function log(step: string, ...rest: unknown[]): void {
  console.log(
    `[e2e-graph] ${new Date().toISOString().slice(11, 19)} ${step}`,
    ...rest,
  );
}

function pass(label: string, detail: string): void {
  outcomes.push({ label, ok: true, detail });
  console.log(`[e2e-graph] PASS ${label} — ${detail}`);
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

// —— 模型解析：env 全配 > mirror dev 库回退（含端点可达探测）> SKIP ——

interface ModelChoice {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  source: string;
}

async function resolveModel(): Promise<ModelChoice | null> {
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
    log(
      "dev 库回退读取失败（视为未配置）:",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

/** 端点可达探测：任意 HTTP 响应（含 401/404）即视为端点活着（真模型可得） */
async function probeEndpoint(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.status < 500 || response.status >= 200;
  } catch {
    return false;
  }
}

// —— server 库直查（run 表断言；只读 + SQLITE_BUSY 重试） ——

interface RunRow {
  id: number;
  taskId: number | null;
  graphId: number | null;
  triggerType: string;
  status: string;
  finishedAt: string | null;
}

async function readRuns(
  whereSql: string,
  params: unknown[],
): Promise<RunRow[]> {
  const { DatabaseSync } = await import("node:sqlite");
  for (let attempt = 0; ; attempt += 1) {
    let db: import("node:sqlite").DatabaseSync | null = null;
    try {
      db = new DatabaseSync(SERVER_DB, { readOnly: true });
      return db
        .prepare(
          "SELECT id, taskId, graphId, triggerType, status, finishedAt FROM automationRun WHERE " +
            whereSql,
        )
        .all(...params) as RunRow[];
    } catch (e) {
      if (attempt >= 8) throw e;
      await delay(200);
    } finally {
      db?.close();
    }
  }
}

/** 轮询直至条件行出现（run 表终态等待） */
async function waitForRun(
  whereSql: string,
  params: unknown[],
  match: (rows: RunRow[]) => RunRow | null,
  timeoutMs: number,
  label: string,
): Promise<RunRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await readRuns(whereSql, params);
    const hit = match(rows);
    if (hit) return hit;
    if (Date.now() > deadline) {
      fail(label, `等 ${timeoutMs}ms 未出现（现有 ${rows.length} 行）`);
    }
    await delay(300);
  }
}

// —— 进程/端口基建（e2e-smoke 同款） ——

interface HandshakeInfo {
  port: number;
  token: string;
  instanceId: string;
}

interface ScannedProcess {
  child: ChildProcess;
  matched: string;
  stderrTail(): string;
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

// —— 编排载荷 ——

/** 两节点链图 JSON（research → report，第二节点模板引用上游 output） */
function twoNodeGraphJson(modelId: number): string {
  return JSON.stringify({
    version: 1,
    inputSchema: { topic: "string" },
    nodes: [
      {
        id: "research",
        name: "调研",
        kind: "llm",
        modelId,
        prompt: "请就主题「{{input.topic}}」回复一句话调研要点",
        tools: false,
        outputMode: "text",
      },
      {
        id: GRAPH_NODE_SECOND,
        name: "成文",
        kind: "llm",
        modelId,
        prompt: "请把「{{nodes.research.output}}」压缩成一句话结论",
        tools: false,
        outputMode: "text",
      },
    ],
    edges: [
      { from: "research", to: GRAPH_NODE_SECOND },
      { from: GRAPH_NODE_SECOND, to: "END" },
    ],
  });
}

/** provider 幂等落位（e2e-smoke 同款手法）：按名 upsert，返回模型行 id */
async function ensureProviderModel(
  control: DirectControl,
  model: ModelChoice,
): Promise<number> {
  const label = "provider 幂等落位";
  const first = (await call(
    control.request.bind(control),
    label,
    "provider/query",
  )) as {
    providers?: Array<{ id: number; name: string }>;
    models?: Array<{ id: number; providerId: number; modelId: string }>;
  };
  if (!first.providers?.some((p) => p.name === PROVIDER_NAME)) {
    await call(control.request.bind(control), label, "provider/save", {
      providers: [
        {
          name: PROVIDER_NAME,
          type: "openai-compatible",
          baseUrl: model.baseUrl,
          apiKey: model.apiKey,
          enabled: true,
        },
      ],
    });
  }
  const second = (await call(
    control.request.bind(control),
    label,
    "provider/query",
  )) as {
    providers?: Array<{ id: number; name: string }>;
    models?: Array<{ providerId: number; modelId: string }>;
  };
  const provider = second.providers?.find((p) => p.name === PROVIDER_NAME);
  if (!provider) fail(label, "upsert 后未回读到 provider 行");
  const modelRow = second.models?.find(
    (m) => m.providerId === provider.id && m.modelId === model.modelId,
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
          modelId: model.modelId,
          name: "e2e-graph-model",
          type: "llm",
          enabled: true,
        },
      ],
    },
  )) as {
    models?: Array<{ providerId: number; modelId: string; id: number }>;
  };
  const finalRow = saved.models?.find(
    (m) => m.providerId === provider.id && m.modelId === model.modelId,
  );
  if (!finalRow) fail(label, "保存后未回读到模型行");
  return finalRow.id;
}

/** 伴生用户工作空间就位（automation/save 必填 workspaceId；无端点可查——
 * 库直读，缺席则停机态预插一行） */
async function ensureWorkspace(): Promise<number> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(SERVER_DB);
  try {
    const row = db
      .prepare(
        "SELECT id FROM workspace WHERE userId = 1 ORDER BY id DESC LIMIT 1",
      )
      .get() as { id: number } | undefined;
    if (row) return row.id;
    db.prepare("INSERT INTO workspace (name, userId) VALUES (?, 1)").run(
      "e2e-graph-smoke",
    );
    const created = db.prepare("SELECT last_insert_rowid() id").get() as {
      id: number;
    };
    log("预插工作空间行", `id=${created.id}`);
    return created.id;
  } finally {
    db.close();
  }
}

// —— 阶段①②：单实例内跑完（graph 链 + 调度触发链） ——

interface PhaseOneResult {
  graphId: number;
  taskId: number;
}

async function runPhaseOne(
  model: ModelChoice,
  dataRoot: string,
): Promise<PhaseOneResult> {
  let child: ChildProcess | null = null;
  let control: DirectControl | null = null;
  const port = await getFreePort();
  fs.writeFileSync(
    E2E_CONFIG,
    `# e2e-graph-smoke 生成（运行完自动删除）\napp:\n  port: ${port}\ntianshu:\n  automation:\n    tickMs: 200\n`,
  );
  const request = (
    method: "GET" | "POST",
    reqPath: string,
    body?: unknown,
  ): Promise<RequestResult> =>
    (control as DirectControl).request(method, reqPath, body);
  try {
    const spawned = await spawnScan(
      process.execPath,
      [SERVER_ENTRY],
      /^TIANSHU_HANDSHAKE /,
      {
        NODE_ENV: "e2e",
        TIANSHU_TOKEN: "e2e-graph-token",
        TIANSHU_DATA_ROOT: dataRoot,

        // DB 真隔离（回归修复 2026-10-27，同 e2e-smoke）：TIANSHU_DB_URL 才是

        // 库落点 env——临时库首启 db push 全量建表，不再落仓内旧开发库

        TIANSHU_DB_URL: path.join(dataRoot, "database", "local.db"),
      },
    );
    SERVER_DB = path.join(dataRoot, "database", "local.db");
    child = spawned.child;
    const info = parseHandshake(spawned.matched);
    if (info.token !== "e2e-graph-token") {
      fail("实例 1 握手", "token 未按 env 回显");
    }
    if (info.port !== port) {
      fail("实例 1 握手", `端口回显 ${info.port} ≠ 配置 ${port}`);
    }
    pass(
      "实例 1 spawn+握手",
      `port=${info.port} instanceId=${info.instanceId}`,
    );

    control = new DirectControl(info.port, info.token);
    const wsId = await ensureWorkspace();
    const modelRowId = await ensureProviderModel(control, model);

    // capability 协商：Ruling 11——无头端广告 graph 能力
    const infoResp = (await call(
      request,
      "info 协商",
      "info",
      undefined,
      "GET",
    )) as { instanceId: string; capabilities: string[] };
    if (!infoResp.capabilities?.includes("graph")) {
      fail("info 协商", `capabilities 缺 graph：${JSON.stringify(infoResp)}`);
    }
    pass("capability 协商", `capabilities 含 graph（${infoResp.instanceId}）`);

    // ① 建图 → run → 事件序列至 succeeded
    const graph = (await call(request, "graph/save", "graph/save", {
      name: "e2e-graph-smoke 两节点图",
      graphJson: twoNodeGraphJson(modelRowId),
    })) as { id: number; version: number; nodeCount: number };
    if (graph.nodeCount !== 2) {
      fail("graph/save", `nodeCount 期望 2 实为 ${graph.nodeCount}`);
    }
    const runAccepted = (await call(request, "graph/run", "graph/run", {
      graphId: graph.id,
      inputs: { topic: "编排冒烟" },
    })) as { runId: number };
    const runId = runAccepted.runId;
    if (typeof runId !== "number") {
      fail("graph/run", `runId 非数：${JSON.stringify(runAccepted)}`);
    }
    log(`graph#${graph.id} run#${runId} 已受理（202）`);

    let finalState = "";
    let finalOutput = "";
    const progressNodes = new Set<string>();
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    while (finalState !== "succeeded" && finalState !== "failed") {
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
        progress?: { nodeId?: string; nodeStatus?: string };
      };
      if (payload.runId !== runId || payload.graphId !== graph.id) continue;
      if (payload.progress?.nodeId) progressNodes.add(payload.progress.nodeId);
      if (
        payload.state &&
        payload.state !== "running" &&
        payload.state !== "progress"
      ) {
        finalState = payload.state;
        finalOutput = payload.output ?? payload.error ?? "";
      }
    }
    if (finalState !== "succeeded") {
      fail("graph 执行", `终态 ${finalState}（${finalOutput.slice(0, 200)}）`);
    }
    if (!finalOutput.trim()) fail("graph 执行", "succeeded 事件 output 为空");
    if (
      !progressNodes.has("research") ||
      !progressNodes.has(GRAPH_NODE_SECOND)
    ) {
      fail("graph 执行", `节点 progress 缺失：${[...progressNodes].join(",")}`);
    }
    const graphRun = await waitForRun(
      "id = ?",
      [runId],
      (rows) => (rows[0]?.status === "success" ? rows[0] : null),
      EVENT_TIMEOUT_MS,
      "graph run 表终态",
    );
    pass(
      "① graph 全链",
      `run#${runId} 事件至 succeeded（progress 双节点）+ run 表 success；output「${finalOutput.slice(0, 40)}」finishedAt=${graphRun.finishedAt != null}`,
    );

    // ② once 任务到期触发（tickMs=200 快进）
    const task = (await call(request, "automation/save", "automation/save", {
      name: "e2e-graph-once",
      prompt: "请只回复 pong",
      workspaceId: wsId,
      modelId: modelRowId,
      schedule: {
        mode: "periodic",
        kind: "once",
        runAt: new Date(Date.now() + ONCE_LEAD_MS).toISOString(),
      },
      scheduleText: "E2E 一次性",
      missedPolicy: "skip",
    })) as { id: number; enabled: boolean; nextRunAt?: string };
    if (task.enabled !== true) {
      fail("automation/save", `enabled 期望 true 实为 ${task.enabled}`);
    }
    log(`task#${task.id} 已建（once runAt=+${ONCE_LEAD_MS}ms，tickMs=200）`);

    // 事件面：至少一条 automation.changed 指向该任务（save 即发 + tick 收口再发）
    let changedCount = 0;
    const eventDeadline = Date.now() + RUN_TIMEOUT_MS;
    const runRow = await (async () => {
      const runPromise = waitForRun(
        "taskId = ? AND triggerType = 'schedule'",
        [task.id],
        (rows) => (rows.some((r) => r.status === "success") ? rows[0] : null),
        RUN_TIMEOUT_MS,
        "automation 调度触发 run 表",
      );
      // 事件与 run 表并行等待：事件流持续收集计数
      void (async () => {
        try {
          for (;;) {
            const event = await nextEventIn(
              control,
              Math.max(1, eventDeadline - Date.now()),
              "automation.changed 事件",
            );
            if (
              event.type === "automation.changed" &&
              (event.payload as { taskId?: number }).taskId === task.id
            ) {
              changedCount += 1;
            }
          }
        } catch {
          /* 等待窗结束——run 表断言为权威 */
        }
      })();
      return runPromise;
    })();
    if (changedCount < 1) {
      fail(
        "automation 事件",
        "automation.changed 未到（run 表已成功——事件面缺失）",
      );
    }
    pass(
      "② automation 调度触发",
      `task#${task.id} run#${runRow.id} triggerType=schedule status=success` +
        `（automation.changed ×${changedCount}，finishedAt=${runRow.finishedAt != null}）`,
    );

    return { graphId: graph.id, taskId: task.id };
  } finally {
    control?.close();
    await stopChild(child);
  }
}

// —— 阶段③：webhook 注册预置 → 实例 2 重启装载 → 同步模板往返 ——

async function runPhaseTwo(
  dataRoot: string,
  phaseOne: PhaseOneResult,
): Promise<void> {
  // webhook 注册无 HTTP 端点（Ruling 13）——停机态直写 option 行（注册面
  // 形态 = WebhookService.registerWebhook 落库值），实例 2 启动装载
  const token = `e2e-graph-${Math.random().toString(36).slice(2, 14)}`;
  const registration = {
    token,
    responseTemplate: `topic={{input.topic}} report={{nodes.${GRAPH_NODE_SECOND}.output}}`,
    statusCode: 200,
    async: false,
  };
  const { DatabaseSync } = await import("node:sqlite");
  const seed = new DatabaseSync(SERVER_DB);
  try {
    seed
      .prepare("INSERT INTO option (type, name, value) VALUES (?, ?, ?)")
      .run(
        "webhook",
        `graph:${phaseOne.graphId}`,
        JSON.stringify(registration),
      );
  } finally {
    seed.close();
  }
  pass(
    "webhook 注册预置",
    `option 行 graph:${phaseOne.graphId}（同步模板模式）`,
  );

  let child: ChildProcess | null = null;
  let control: DirectControl | null = null;
  const port = await getFreePort();
  fs.writeFileSync(
    E2E_CONFIG,
    `# e2e-graph-smoke 生成（运行完自动删除）\napp:\n  port: ${port}\ntianshu:\n  automation:\n    tickMs: 200\n`,
  );
  try {
    const spawned = await spawnScan(
      process.execPath,
      [SERVER_ENTRY],
      /^TIANSHU_HANDSHAKE /,
      {
        NODE_ENV: "e2e",
        TIANSHU_TOKEN: "e2e-graph-token",
        TIANSHU_DATA_ROOT: dataRoot,

        // DB 真隔离（回归修复 2026-10-27，同 e2e-smoke）：TIANSHU_DB_URL 才是

        // 库落点 env——临时库首启 db push 全量建表，不再落仓内旧开发库

        TIANSHU_DB_URL: path.join(dataRoot, "database", "local.db"),
      },
    );
    SERVER_DB = path.join(dataRoot, "database", "local.db");
    child = spawned.child;
    const info = parseHandshake(spawned.matched);
    control = new DirectControl(info.port, info.token);
    log(`实例 2 已起（reloadRegistrations 装载 token）port=${info.port}`);

    // 未知 token 404 原样体（不经统一包装）
    const miss = await control.rawPost("/webhook/no-such-token", {}, 10_000);
    if (miss.status !== 404 || !miss.text.includes("invalid_token")) {
      fail(
        "webhook 未知 token",
        `期望 404 invalid_token 实为 ${miss.status} ${miss.text.slice(0, 120)}`,
      );
    }

    // 同步模板往返：POST → 真模型跑图 → 模板渲染原样文本返回
    const response = await control.rawPost(
      `/webhook/${token}`,
      { topic: "webhook冒烟" },
      RUN_TIMEOUT_MS + 30_000,
    );
    if (response.status !== 200) {
      fail(
        "webhook 同步往返",
        `期望 200 实为 ${response.status}：${response.text.slice(0, 200)}`,
      );
    }
    if (!response.contentType.includes("application/json")) {
      fail(
        "webhook 同步往返",
        `Content-Type 期望 application/json 实为 ${response.contentType}`,
      );
    }
    if (!/^topic=webhook冒烟 report=\S/.test(response.text)) {
      fail(
        "webhook 模板渲染",
        `模板往返体不符：${response.text.slice(0, 200)}`,
      );
    }
    const hookRun = await waitForRun(
      "graphId = ? AND triggerType = 'webhook'",
      [phaseOne.graphId],
      (rows) => (rows.some((r) => r.status === "success") ? rows[0] : null),
      EVENT_TIMEOUT_MS,
      "webhook run 表终态",
    );
    pass(
      "③ webhook 同步模板往返",
      `200 + 模板原样文本（${response.text.slice(0, 60)}…）+ run#${hookRun.id} triggerType=webhook status=success`,
    );

    // 收敛：任务/图经端点删除（graph/delete 钩子连带清 webhook option 行）
    await call(
      control.request.bind(control),
      "automation/delete 收敛",
      "automation/delete",
      {
        ids: [phaseOne.taskId],
      },
    );
    await call(
      control.request.bind(control),
      "graph/delete 收敛",
      "graph/delete",
      {
        id: phaseOne.graphId,
      },
    );
    const leftover = await readRuns("taskId = ? OR graphId = ?", [
      phaseOne.taskId,
      phaseOne.graphId,
    ]);
    if (leftover.length !== 0) {
      fail("清理收敛", `run 残留 ${leftover.length} 行（级联未生效）`);
    }
    const check = new DatabaseSync(SERVER_DB, { readOnly: true });
    try {
      const optionLeft = check
        .prepare("SELECT COUNT(*) n FROM option WHERE type = 'webhook'")
        .get() as { n: number };
      if (optionLeft.n !== 0) {
        fail("清理收敛", `webhook option 残留 ${optionLeft.n} 行`);
      }
    } finally {
      check.close();
    }
    pass("清理收敛", "任务/图/run 级联删除 + webhook option 钩子清理");
  } finally {
    control?.close();
    await stopChild(child);
  }
}

// —— 入口 ——

async function main(): Promise<number> {
  log("tianshu-server 编排（graph/automation/webhook）E2E 冒烟启动");
  log(`server 仓：${SERVER_DIR}`);

  const model = await resolveModel();
  if (!model) {
    console.log(
      "[e2e-graph] SKIP：未配置 E2E_MODEL_BASE_URL/E2E_MODEL_API_KEY/" +
        "E2E_MODEL_MODEL，且 mirror dev 库无可用模型（preflight Ruling 3）" +
        "——不阻塞常规测试",
    );
    return 0;
  }
  if (!(await probeEndpoint(model.baseUrl))) {
    console.log(
      `[e2e-graph] SKIP：模型端点不可达 ${model.baseUrl}（来源 ${model.source}——真模型不可得，如实记录，不阻塞常规测试）`,
    );
    return 0;
  }
  log(`模型来源 ${model.source}：${model.modelId} @ ${model.baseUrl}`);

  if (!fs.existsSync(SERVER_ENTRY)) {
    console.error(
      `[e2e-graph] FAIL：无头端产物不存在 ${SERVER_ENTRY}（先在 tianshu-server 执行 npm run build）`,
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
        `[e2e-graph] FAIL：构建失败\n${(build.stderr ?? "").slice(-2000)}`,
      );
      return 1;
    }
  }

  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-e2e-graph-"));
  try {
    const phaseOne = await runPhaseOne(model, dataRoot);
    await runPhaseTwo(dataRoot, phaseOne);
  } catch (e) {
    console.error(
      `[e2e-graph] 阶段失败：${e instanceof Error ? e.message : e}`,
    );
  } finally {
    fs.rmSync(E2E_CONFIG, { force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }

  const failed = outcomes.filter((o) => !o.ok);
  console.log(
    `\n[e2e-graph] 结果汇总：${outcomes.length - failed.length}/${outcomes.length} 断言组通过` +
      "（provider/model 行按名幂等留存——e2e-smoke 先例）",
  );
  for (const o of outcomes) {
    console.log(`  ${o.ok ? "PASS" : "FAIL"}  ${o.label} — ${o.detail}`);
  }
  return failed.length > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("[e2e-graph] 未预期异常：", e);
    process.exit(1);
  });
