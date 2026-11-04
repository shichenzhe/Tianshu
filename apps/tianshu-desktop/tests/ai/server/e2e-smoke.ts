/**
 * 双链路 E2E 冒烟（T19，spec §9）：直连与中继两条真实链路各走一轮
 * 「provider 落位 → 建 session → 订阅事件 → send → 流式回传 → abort
 * 幂等 → 删会话」。
 *
 * - 直连链路：spawn tianshu-server（TIANSHU_TOKEN=e2e）→ 扫 stdout 握手行
 *   → 原生 fetch + 手写 SSE 解析按协议直连（/info 协商、/event 订阅、
 *   session/provider 端点）；断言 SSE 首帧 server.connected
 * - 中继链路：起 relay（--port 0 --token）→ tianshu-server 以
 *   TIANSHU_RELAY_URL/TIANSHU_RELAY_TOKEN 起 headless relay 客户端（被控端，
 *   main.ts env 路径）→ 控制侧 ws role=client open 帧（connectionId=被控端
 *   instanceId）配对 → req/res 帧承载请求 + event 帧收流（relay 无 SSE，
 *   server.connected 语义由控制侧 GET /info 承担——RelayTransport 同款契约）
 * - 不复用 mirror electron/domains/server 的 DirectTransport/RelayTransport：
 *   其依赖 electron/commons 的 Log（顶层 import electron 取 app.isPackaged，
 *   纯 node 下即抛错），本脚本跑在 node——按协议原生实现（wire 口径与
 *   transport 实现一致：Bearer 鉴权、SSE 帧解析、relay 帧配对）
 * - 真实模型：E2E_MODEL_BASE_URL / E2E_MODEL_API_KEY / E2E_MODEL_MODEL env
 *   全配才用 env；否则回退读 mirror dev 库（~/.tianshu/dev/database/
 *   local.db，只读）第一个启用 provider + 启用 llm 模型；两者皆无 →
 *   SKIP 打印退出 0（preflight Ruling 3）
 * - 数据隔离：TIANSHU_DATA_ROOT 指向临时目录（chat 沙箱/回收站等不落真实
 *   数据根，完事递归删除）。注意 Prisma SQLite 库址在 schema 内写死
 *   （prisma/local.db，非 env 可重定向）——DB 落 tianshu-server 仓，脚本以
 *   「会话删除 + provider 按名 upsert」收敛不留增量行
 * - 随机端口：写 dist/config/config.e2e.yml（app.port）+ NODE_ENV=e2e
 *   触发 configuration.ts 的环境 yml 合并加载，完事删除（并发跑会互踩该
 *   文件，冒烟脚本单实例假设）
 *
 * 运行：npm run test:e2e:server（node 原生 strip-types，需 Node ≥ 23.6；
 * 文件名无 .test. 段不进 vitest 常规集）
 *
 * 基建单源：spawnScan / DirectControl / parseSseBlock / 握手解析 /
 * getFreePort / 停进程 / 包装体 call / resolveModel / 断言锚等自
 * e2e-helpers.ts 导入（2026-10-31 五副本归一，血统见其头注释）；本脚本
 * 保留 RelayControl 与 ControlSession 抽象（两链路统一面）。
 */
import { spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import {
  BOOT_TIMEOUT_MS,
  E2E_CONFIG,
  SERVER_DIR,
  SERVER_ENTRY,
  createE2eReporter,
  type Envelope,
  type ModelChoice,
  DirectControl,
  type ProtocolEvent,
  type RequestResult,
  getFreePort,
  nextEventIn,
  parseHandshake,
  resolveModel,
  spawnScan,
  stopChild,
} from "./e2e-helpers.ts";

/** 控制端统一面：两链路对冒烟流程无感 */
interface ControlSession {
  request(
    method: "GET" | "POST",
    reqPath: string,
    body?: unknown,
  ): Promise<RequestResult>;
  /** 下一协议事件（server.connected/message.chunk/session.*）；流关闭抛错 */
  nextEvent(): Promise<ProtocolEvent>;
  close(): void;
}

const RELAY_ENTRY = path.join(
  SERVER_DIR,
  "dist",
  "src",
  "relay",
  "relay-main.js",
);

const PROVIDER_NAME = "e2e-smoke";
const SEND_PROMPT = "请只回复 pong";
const STREAM_TIMEOUT_MS = 120_000;
const EVENT_TIMEOUT_MS = 15_000;

const reporter = createE2eReporter("e2e");
const { log, pass, call, printSummary } = reporter;

/** 断言失败即抛——函数声明形态保 never 控制流分析（reporter 解构件不保） */
function fail(label: string, detail: string): never {
  return reporter.fail(label, detail);
}

/** 中继控制端：ws role=client + req/res 帧配对 + event 帧外推 */
class RelayControl implements ControlSession {
  private readonly ws: WebSocket;
  private readonly pending = new Map<
    number,
    {
      resolve: (result: RequestResult) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly queue: ProtocolEvent[] = [];
  private wake: (() => void) | null = null;
  private nextId = 1;
  private closed = false;
  private readonly opened: Promise<void>;

  constructor(relayUrl: string, relayToken: string, connectionId: string) {
    const joiner = relayUrl.includes("?") ? "&" : "?";
    this.ws = new WebSocket(
      `${relayUrl}${joiner}role=client&token=${encodeURIComponent(relayToken)}`,
    );
    this.ws.on("message", (raw) => this.onFrame(String(raw)));
    this.opened = new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => {
        this.ws.send(JSON.stringify({ kind: "open", connectionId }));
        resolve();
      });
      this.ws.once("error", (e) => reject(e));
    });
    this.ws.on("error", () => {
      /* close 收口：pending 拒绝在 close 帧/close() 处理 */
    });
  }

  async request(
    method: "GET" | "POST",
    reqPath: string,
    body?: unknown,
  ): Promise<RequestResult> {
    await this.opened;
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("relay ws 未就绪/已关闭");
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<RequestResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(
          JSON.stringify({
            kind: "req",
            id,
            method,
            path: reqPath,
            body: body ?? null,
          }),
        );
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  async nextEvent(): Promise<ProtocolEvent> {
    for (;;) {
      if (this.queue.length) return this.queue.shift() as ProtocolEvent;
      if (this.closed) throw new Error("relay 控制端已关闭");
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }

  close(): void {
    this.closed = true;
    this.wake?.();
    this.rejectPending(new Error("relay 控制端已关闭"));
    this.ws.close(1000, "e2e-done");
  }

  private rejectPending(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  private onFrame(raw: string): void {
    let frame: {
      kind?: string;
      id?: number;
      status?: number;
      body?: unknown;
      type?: string;
      payload?: Record<string, unknown>;
      reason?: string;
    };
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (frame.kind === "res" && typeof frame.id === "number") {
      this.pending.get(frame.id)?.resolve({
        status: frame.status ?? 0,
        body: (frame.body ?? null) as Envelope | string | null,
      });
      this.pending.delete(frame.id);
      return;
    }
    if (frame.kind === "event" && typeof frame.type === "string") {
      this.queue.push({ type: frame.type, payload: frame.payload ?? {} });
      this.wake?.();
      return;
    }
    if (frame.kind === "close") {
      this.rejectPending(new Error(`relay close 帧：${frame.reason ?? "?"}`));
    }
  }
}

// —— 冒烟主流程（两链路共用断言）——

interface ProviderBundle {
  providers?: Array<{
    id: number;
    name: string;
  }>;
  models?: Array<{
    id: number;
    providerId: number;
    modelId: string;
  }>;
}

/** provider 幂等落位：按名 upsert（重复运行不留增量行），返回模型行 id */
async function ensureProviderModel(
  control: ControlSession,
  model: ModelChoice,
): Promise<number> {
  const label = "provider 幂等落位";
  const first = (await call(
    control.request.bind(control),
    label,
    "provider/query",
  )) as ProviderBundle;
  const existing = first.providers?.find((p) => p.name === PROVIDER_NAME);
  if (!existing) {
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
  )) as ProviderBundle;
  const provider = second.providers?.find((p) => p.name === PROVIDER_NAME);
  if (!provider) fail(label, "upsert 后未回读到 provider 行");
  const modelRow = second.models?.find(
    (m) => m.providerId === provider.id && m.modelId === model.modelId,
  );
  const saved = (await call(control.request.bind(control), label, "provider/save", {
    models: [
      {
        ...(modelRow ? { id: modelRow.id } : {}),
        providerId: provider.id,
        modelId: model.modelId,
        name: "e2e-smoke-model",
        type: "llm",
        enabled: true,
      },
    ],
  })) as ProviderBundle;
  const finalRow = saved.models?.find(
    (m) => m.providerId === provider.id && m.modelId === model.modelId,
  );
  if (!finalRow) fail(label, "保存后未回读到模型行");
  return finalRow.id;
}

/**
 * 单链路冒烟流程。connectedFrame：直连链路多断言一条「SSE 首帧
 * server.connected」；中继链路无 SSE（身份经 /info，RelayTransport
 * 同款契约），不发该帧。
 */
async function runSmokeFlow(
  label: string,
  control: ControlSession,
  model: ModelChoice,
  connectedFrame: boolean,
): Promise<void> {
  // /info 协商：直连真实 HTTP；中继经 req 帧派发到同一端点
  const info = (await call(
    control.request.bind(control),
    `${label}/info`,
    "info",
    undefined,
    "GET",
  )) as {
    instanceId: string;
    capabilities: string[];
  };
  if (!info.capabilities?.includes("chat")) {
    fail(`${label}/info`, `capabilities 缺 chat：${JSON.stringify(info)}`);
  }
  pass(`${label}/info 协商`, `instanceId=${info.instanceId}`);

  if (connectedFrame) {
    const first = await nextEventIn(
      control,
      EVENT_TIMEOUT_MS,
      `${label} SSE 首帧`,
    );
    if (
      first.type !== "server.connected" ||
      first.payload.instanceId !== info.instanceId
    ) {
      fail(
        `${label} SSE 首帧`,
        `期望 server.connected(${info.instanceId}) 实为 ${first.type} ${JSON.stringify(first.payload).slice(0, 120)}`,
      );
    }
    pass(`${label} SSE 首帧`, "server.connected 与 /info instanceId 一致");
  }

  const modelRowId = await ensureProviderModel(control, model);
  const session = (await call(
    control.request.bind(control),
    `${label}/session/create`,
    "session/create",
    {
      title: "e2e-smoke",
      currentModelId: modelRowId,
    },
  )) as { id: number; workspaceId?: number };
  log(`${label} session#${session.id} 已建（model 行 ${modelRowId}）`);

  // —— files 面冒烟（FA-T4）：负路径（默认空间无 directoryPath）+
  // uploadImage 正路径（后续 send 带图端到端落块）——
  {
    const listResult = await control.request("POST", "files/list", {
      workspaceId: session.workspaceId ?? 0,
    });
    const listEnvelope = listResult.body as {
      success?: boolean;
      data?: unknown;
    };
    // 默认空间可能带 directoryPath（无头端建空间口径）——清单值不定，
    // 断言端点连通与形状；稳定负路径走 read 越界（FILES_PATH_ESCAPE）
    if (listEnvelope?.success !== true || !Array.isArray(listEnvelope.data)) {
      fail(
        `${label}/files/list`,
        `期望成功信封+数组实为 ${JSON.stringify(listResult.body).slice(0, 200)}`,
      );
    }
    const readEscape = await control.request("POST", "files/read", {
      workspaceId: session.workspaceId ?? 0,
      path: "../escape.txt",
    });
    const readEnvelope = readEscape.body as {
      success?: boolean;
      code?: string;
    };
    if (
      readEnvelope?.success !== false ||
      readEnvelope.code !== "FILES_PATH_ESCAPE"
    ) {
      fail(
        `${label}/files/read 越界`,
        `期望 FILES_PATH_ESCAPE 实为 ${JSON.stringify(readEscape.body).slice(0, 200)}`,
      );
    }
    pass(`${label}/files 面`, "list 连通+read 越界 FILES_PATH_ESCAPE 稳定码");
  }
  const upload = (await call(
    control.request.bind(control),
    `${label}/files/uploadImage`,
    "files/uploadImage",
    {
      name: "e2e-图.png",
      base64: Buffer.from("e2e-image-bytes").toString("base64"),
    },
  )) as { imagePath: string };
  if (!/^attachments\/[^/]+\/e2e-图\.png$/.test(upload.imagePath ?? "")) {
    fail(
      `${label}/files/uploadImage`,
      `imagePath 形态异常：${JSON.stringify(upload)}`,
    );
  }
  pass(`${label}/files/uploadImage`, `imagePath=${upload.imagePath}`);

  const sessionId: number | null = session.id;
  try {
    const accepted = (await call(
      control.request.bind(control),
      `${label}/session/send`,
      "session/send",
      // FA-T4：send 携 images（uploadImage 返回的数据根相对路径）——
      // 端到端验证 ImageBlock 落库（流收尾后 getById 断言）
      { sessionId, content: SEND_PROMPT, images: [upload.imagePath] },
    )) as { accepted: boolean };
    if (accepted?.accepted !== true) {
      fail(
        `${label}/session/send`,
        `受理载荷异常：${JSON.stringify(accepted)}`,
      );
    }

    let deltas = 0;
    let finish = false;
    let updated = false;
    let text = "";
    let streamError: string | null = null;
    const deadline = Date.now() + STREAM_TIMEOUT_MS;
    while (!finish || !updated) {
      if (streamError) break;
      const event = await nextEventIn(
        control,
        Math.max(1, deadline - Date.now()),
        `${label} 流式事件`,
      );
      if (event.type === "message.chunk") {
        const payload = event.payload as {
          sessionId?: number;
          chunk?: {
            type?: string;
            text?: string;
            errorCode?: string;
            message?: string;
          };
        };
        if (payload.sessionId !== sessionId || !payload.chunk) continue;
        if (payload.chunk.type === "text-delta") {
          deltas += 1;
          text += payload.chunk.text ?? "";
        } else if (payload.chunk.type === "reasoning-delta") {
          deltas += 1;
        } else if (payload.chunk.type === "finish") {
          finish = true;
        } else if (payload.chunk.type === "error") {
          streamError = `chunk.error ${payload.chunk.errorCode}: ${payload.chunk.message}`;
        }
      } else if (event.type === "session.updated") {
        if ((event.payload as { id?: number }).id === sessionId) updated = true;
      } else if (event.type === "session.error") {
        const payload = event.payload as {
          sessionId?: number;
          code?: string;
          message?: string;
        };
        if (payload.sessionId === sessionId) {
          streamError = `session.error ${payload.code}: ${payload.message}`;
        }
      }
    }
    if (streamError) fail(`${label} 流式`, streamError);
    if (deltas < 1)
      fail(`${label} 流式断言`, `增量 chunk ≥1 失败（delta=${deltas}）`);
    if (!finish) fail(`${label} 流式断言`, "finish 缺失");
    if (!updated) fail(`${label} 流式断言`, "session.updated 缺失");
    pass(
      label,
      `send→${deltas} 增量+finish+session.updated，回显「${text.slice(0, 60)}」`,
    );

    // FA-T4：send 带 images 的端到端落块断言（user 消息 blocks 含
    // image 块——imagePath 原样、mime 按扩展名派生）
    {
      const detail = (await call(
        control.request.bind(control),
        `${label}/session/getById`,
        "session/getById",
        { id: sessionId },
      )) as {
        messages?: Array<{ role: string; blocks: string }>;
      };
      const userMsg = (detail.messages ?? []).find((m) => m.role === "user");
      const imageBlocks = userMsg
        ? (
            JSON.parse(userMsg.blocks) as Array<{
              type: string;
              imagePath?: string;
            }>
          ).filter((b) => b.type === "image")
        : [];
      if (
        imageBlocks.length !== 1 ||
        imageBlocks[0].imagePath !== upload.imagePath
      ) {
        fail(
          `${label}/send images 落块`,
          `期望 1 个 image 块(${upload.imagePath}) 实为 ${JSON.stringify(imageBlocks)}`,
        );
      }
      pass(`${label}/send images 落块`, `imagePath=${upload.imagePath}`);
    }

    // abort 幂等：流已收尾后再 abort 应无错且 {aborted:false}
    const abortResult = (await call(
      control.request.bind(control),
      `${label}/session/abort`,
      "session/abort",
      { sessionId },
    )) as { aborted: boolean };
    if (abortResult?.aborted !== false) {
      fail(
        `${label} abort 幂等`,
        `期望 {aborted:false} 实为 ${JSON.stringify(abortResult)}`,
      );
    }
    pass(`${label} abort 幂等`, "finish 后 abort 返回 {aborted:false}");
  } finally {
    if (sessionId !== null) {
      try {
        await call(control.request.bind(control), `${label}/session/delete`, "session/delete", {
          id: sessionId,
        });
        log(`${label} session#${sessionId} 已清理`);
      } catch (e) {
        log(
          `${label} session#${sessionId} 清理失败：`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }
}

// —— 链路装配 ——

async function runDirect(model: ModelChoice): Promise<void> {
  const label = "直连链路";
  const dataRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tianshu-e2e-direct-"),
  );
  let child: ChildProcess | null = null;
  const control: { current: DirectControl | null } = { current: null };
  try {
    const port = await getFreePort();
    fs.writeFileSync(
      E2E_CONFIG,
      `# e2e-smoke 生成（运行完自动删除）\napp:\n  port: ${port}\n`,
    );
    const spawned = await spawnScan(
      process.execPath,
      [SERVER_ENTRY],
      /^TIANSHU_HANDSHAKE /,
      {
        NODE_ENV: "e2e",
        TIANSHU_TOKEN: "e2e-token",
        TIANSHU_HANDSHAKE_TOKEN: "1",
        TIANSHU_DATA_ROOT: dataRoot,

        // DB 真隔离（回归修复 2026-10-27）：库落点 env 是 TIANSHU_DB_URL——

        // 此前只传 DATA_ROOT 致库落仓内 prisma/local.db（旧 schema，P1 加列

        // 后 session/create 即炸且脏写开发库）；临时库不存在 → 首启 db push

        // 全量建表（schema 单一事实源）

        TIANSHU_DB_URL: path.join(dataRoot, "database", "local.db"),
      },
    );
    child = spawned.child;
    const info = parseHandshake(spawned.matched);
    if (info.token !== "e2e-token")
      fail(`${label} 握手`, "token 未按 env 回显");
    pass(
      `${label} spawn+握手`,
      `port=${info.port} instanceId=${info.instanceId}`,
    );
    if (info.port !== port)
      fail(`${label} 握手`, `端口回显 ${info.port} ≠ 配置 ${port}`);

    const direct = new DirectControl(info.port, info.token);
    control.current = direct;
    await runSmokeFlow(label, direct, model, true);
  } finally {
    control.current?.close();
    await stopChild(child);
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

async function runRelay(model: ModelChoice): Promise<void> {
  const label = "中继链路";
  const relayToken = `relay-e2e-${Date.now().toString(36)}`;
  let relayChild: ChildProcess | null = null;
  let serverChild: ChildProcess | null = null;
  let control: RelayControl | null = null;
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-e2e-relay-"));
  try {
    const relay = await spawnScan(
      process.execPath,
      [RELAY_ENTRY, "--port", "0", "--token", relayToken],
      /\[relay\] listening on port \d+/,
      {},
    );
    relayChild = relay.child;
    const relayPort = Number(relay.matched.match(/port (\d+)/)?.[1] ?? 0);
    if (!relayPort) fail(`${label} relay`, "端口回显解析失败");
    const relayUrl = `ws://127.0.0.1:${relayPort}/ws`;
    pass(`${label} relay 起动`, `port=${relayPort}`);

    const port = await getFreePort();
    fs.writeFileSync(
      E2E_CONFIG,
      `# e2e-smoke 生成（运行完自动删除）\napp:\n  port: ${port}\n`,
    );
    const server = await spawnScan(
      process.execPath,
      [SERVER_ENTRY],
      /^TIANSHU_HANDSHAKE /,
      {
        NODE_ENV: "e2e",
        TIANSHU_TOKEN: "e2e-token",
        TIANSHU_HANDSHAKE_TOKEN: "1",
        TIANSHU_DATA_ROOT: dataRoot,

        // DB 真隔离（回归修复 2026-10-27）：库落点 env 是 TIANSHU_DB_URL——

        // 此前只传 DATA_ROOT 致库落仓内 prisma/local.db（旧 schema，P1 加列

        // 后 session/create 即炸且脏写开发库）；临时库不存在 → 首启 db push

        // 全量建表（schema 单一事实源）

        TIANSHU_DB_URL: path.join(dataRoot, "database", "local.db"),
        TIANSHU_RELAY_URL: relayUrl,
        TIANSHU_RELAY_TOKEN: relayToken,
      },
    );
    serverChild = server.child;
    const info = parseHandshake(server.matched);
    pass(
      `${label} 被控端握手`,
      `port=${info.port} instanceId=${info.instanceId}`,
    );

    // headless relay 客户端注册确认（connectionId = instanceId）
    const registeredLine = await Promise.race([
      server.waitForLine(/已连接并注册/),
      delay(BOOT_TIMEOUT_MS).then(() => ""),
    ]);
    if (!registeredLine) fail(`${label} relay 客户端`, "注册确认行超时未出现");
    pass(`${label} relay 注册`, registeredLine.trim().slice(0, 80));

    control = new RelayControl(relayUrl, relayToken, info.instanceId);
    await runSmokeFlow(label, control, model, false);
  } finally {
    control?.close();
    await stopChild(serverChild);
    await stopChild(relayChild);
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

// —— 入口 ——

async function main(): Promise<number> {
  log("tianshu-server 双链路 E2E 冒烟启动");
  log(`server 仓：${SERVER_DIR}`);

  const model = await resolveModel(log);
  if (!model) {
    console.log(
      "[e2e] SKIP：未配置 E2E_MODEL_BASE_URL/E2E_MODEL_API_KEY/E2E_MODEL_MODEL，" +
        "且 mirror dev 库无可用模型（preflight Ruling 3）——不阻塞常规测试",
    );
    return 0;
  }
  log(`模型来源 ${model.source}：${model.modelId} @ ${model.baseUrl}`);

  if (!fs.existsSync(SERVER_ENTRY)) {
    console.error(
      `[e2e] FAIL：无头端产物不存在 ${SERVER_ENTRY}（先在 tianshu-server 执行 npm run build）`,
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
        `[e2e] FAIL：构建失败\n${(build.stderr ?? "").slice(-2000)}`,
      );
      return 1;
    }
  }

  try {
    await runDirect(model);
  } catch (e) {
    console.error(`[e2e] 直连链路失败：${e instanceof Error ? e.message : e}`);
  }
  try {
    await runRelay(model);
  } catch (e) {
    console.error(`[e2e] 中继链路失败：${e instanceof Error ? e.message : e}`);
  }

  fs.rmSync(E2E_CONFIG, { force: true });
  return printSummary() > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("[e2e] 未预期异常：", e);
    process.exit(1);
  });
