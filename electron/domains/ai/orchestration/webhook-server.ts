// electron/domains/ai/orchestration/webhook-server.ts
/**
 * 入站 webhook 触发：本地 HTTP server（仅监听 127.0.0.1，默认端口
 * 27400，option `webhook.port` 可配）。每图随机 token（option 表
 * `webhook:<graphId>` 存 JSON {token, responseTemplate, statusCode, async}，
 * 兼容读旧版裸 token 值）。POST /webhook/<token>：
 * - 同步模式（默认）：挂起至完成（120s 上限），自定义模板（经
 *   renderNodePrompt 渲染 {{nodes.x.output}}/{{input.y}}）或默认
 *   {status, output} JSON，按配置状态码返回。
 * - 异步模式：立即 202 + {jobId, statusUrl}；GET /webhook/<token>/jobs/<id>
 *   轮询——内存存完整结果，重启后回落 run 表状态（output 不落库）。
 * JSON body 顶层字符串值 → inputs。workspace 取该用户最新一个。
 */
import http from "node:http";
import { randomBytes } from "node:crypto";
import prisma from "../../../commons/prisma-client";
import Log from "../../../commons/Log";
import { createBoundedMap } from "../../../commons/bounded-map";
import { renderNodePrompt } from "./graph-prompt";
import type { GraphRow } from "./graph-executor";

const DEFAULT_PORT = 27_400;
const WEBHOOK_OPTION_TYPE = "webhook";
const SYNC_TIMEOUT_MS = 120_000;

/** 注册配置（option value 序列化形态；旧版裸 token 兼容读） */
export interface WebhookConfig {
  token: string;
  /** 响应体模板（{{nodes.x.output}}/{{input.y}}）；空 = 默认 JSON */
  responseTemplate: string;
  /** 响应状态码（默认 200；异步模式固定 202 由框架决定） */
  statusCode: number;
  /** 异步 job 模式 */
  async: boolean;
  /** 图级完全访问（对齐任务 accessMode=full）：开启后本图 webhook 触发
   * 时代码/文件写入节点放行执行——webhook 无任务载体，授权挂注册上；
   * 默认 false（外部 token 可达面不给全权，名单放行解释器仍可救） */
  fullAccess?: boolean;
}

interface Registration extends WebhookConfig {
  graphId: number;
  userId: number;
}

/** 异步 job 结果保留上限：外部高频触发下内存不无界（插入序 FIFO 逐出最旧） */
const JOB_RESULTS_MAX = 200;

/** 异步 job 结果（内存；重启后 GET 回落 run 表状态，output 置空并标注） */
const jobResults = createBoundedMap<
  number,
  { status: "success" | "failed"; output: string }
>(JOB_RESULTS_MAX);

let server: http.Server | null = null;
let port = DEFAULT_PORT;
const registrations = new Map<string, Registration>(); // token → reg

/** 工具禁用闭包（先例 setEventBusDisabledTools）：Application 注入实时
 * 读安全配置，webhook 触发的运行与调度/手动/事件触发同一过滤口径 */
let readDisabledTools: () => string[] = () => [];
export function setWebhookDisabledTools(fn: () => string[]): void {
  readDisabledTools = fn;
}

/** 在途运行注册表（runId → {abort, graphId}）：stopWebhookServer/注销
 * 或删除图时统一中止（先例 graphTestInflight；执行完成即移除） */
const activeRuns = new Map<
  number,
  { abort: AbortController; graphId: number }
>();

async function loadPort(): Promise<number> {
  const row = await prisma.option.findFirst({
    where: { type: "app", name: "webhook.port" },
  });
  const parsed = row ? Number(row.value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536
    ? parsed
    : DEFAULT_PORT;
}

/** option 行值 → 注册配置（旧版裸 token 兼容读） */
function parseConfigValue(value: string): WebhookConfig {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { token?: unknown }).token === "string"
    ) {
      const cfg = parsed as WebhookConfig;
      return {
        token: cfg.token,
        responseTemplate:
          typeof cfg.responseTemplate === "string" ? cfg.responseTemplate : "",
        statusCode:
          Number.isInteger(cfg.statusCode) &&
          cfg.statusCode >= 100 &&
          cfg.statusCode < 600
            ? cfg.statusCode
            : 200,
        async: cfg.async === true,
        fullAccess: cfg.fullAccess === true,
      };
    }
  } catch {
    // 旧版裸 token
  }
  return { token: value, responseTemplate: "", statusCode: 200, async: false };
}

export async function ensureWebhookServer(): Promise<number> {
  const nextPort = await loadPort();
  if (server && port === nextPort) {
    return port;
  }
  if (server) {
    await stopWebhookServer();
  }
  port = nextPort;
  await reloadRegistrations();
  server = http.createServer(handleRequest);
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(port, "127.0.0.1", () => resolve());
  });
  Log.info("webhook server listening", `127.0.0.1:${port}`);
  return port;
}

/** 当前生效端口（纯读不拉起 server：运行中取运行端口，未起读配置
 *  回落默认）——设置面板展示用 */
export async function getWebhookPort(): Promise<number> {
  return server ? port : loadPort();
}

/** 全局端口设置（设置面板）：写 option `webhook.port` 后立即重绑——
 * 端口被占（EADDRINUSE 等）则回滚 option 与 server 原端口并抛错，
 * 调用方把占用信息反馈给用户；URL 随新端口变化，外部调用方需更新 */
export async function setWebhookPort(nextPort: number): Promise<number> {
  if (!Number.isInteger(nextPort) || nextPort <= 0 || nextPort >= 65_536) {
    throw new Error("端口须为 1-65535 的整数");
  }
  const previous = await loadPort();
  if (previous === nextPort && server) {
    return nextPort;
  }
  await prisma.option.upsert({
    where: {
      type_name_userId: { type: "app", name: "webhook.port", userId: 0 },
    },
    create: {
      type: "app",
      name: "webhook.port",
      value: String(nextPort),
      userId: 0,
    },
    update: { value: String(nextPort) },
  });
  try {
    return await ensureWebhookServer();
  } catch (e) {
    // 回滚：option 恢复原值并把 server 绑回原端口（原端口也可能已
    // 被他人占用——尽力而为，失败仅告警不掩盖主因）
    await prisma.option.upsert({
      where: {
        type_name_userId: { type: "app", name: "webhook.port", userId: 0 },
      },
      create: {
        type: "app",
        name: "webhook.port",
        value: String(previous),
        userId: 0,
      },
      update: { value: String(previous) },
    });
    try {
      await ensureWebhookServer();
    } catch (restoreError) {
      Log.warn("webhook port rollback failed", String(restoreError));
    }
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`端口 ${nextPort} 绑定失败（可能被占用）: ${message}`, {
      cause: e,
    });
  }
}

export async function stopWebhookServer(): Promise<void> {
  // 先中止在途运行（悬挂请求随连接断开收敛），再关 listener
  for (const run of activeRuns.values()) {
    run.abort.abort();
  }
  activeRuns.clear();
  if (!server) {
    return;
  }
  const current = server;
  server = null;
  // closeAllConnections：close 只停听不停 keep-alive 挂起连接，复用旧连接
  // 的请求会吃 ECONNRESET——关停时一并断开（Node 18.2+）
  current.closeAllConnections?.();
  await new Promise<void>((resolve) => current.close(() => resolve()));
}

/** 注册/重注册（开启或改配置时生成新 token 旧 token 失效） */
export async function registerWebhook(
  graphId: number,
  userId: number,
  config?: Partial<
    Pick<
      WebhookConfig,
      "responseTemplate" | "statusCode" | "async" | "fullAccess"
    >
  >,
): Promise<string> {
  const token = randomBytes(24).toString("hex");
  const full: WebhookConfig = {
    token,
    responseTemplate: config?.responseTemplate ?? "",
    statusCode: config?.statusCode ?? 200,
    async: config?.async ?? false,
    fullAccess: config?.fullAccess ?? false,
  };
  const name = `graph:${graphId}`;
  await prisma.option.upsert({
    where: { type_name_userId: { type: WEBHOOK_OPTION_TYPE, name, userId } },
    create: {
      type: WEBHOOK_OPTION_TYPE,
      name,
      value: JSON.stringify(full),
      userId,
    },
    update: { value: JSON.stringify(full) },
  });
  // 重开旧 token 立即失效：option 行已换新值，同图内存旧条目一并清
  //（否则运行期旧 token 仍可达，轮换语义失效——重启装载前安全窗口；
  // unregisterWebhook 同款遍历；tianshu-server webhook.service 同根修复随批）
  for (const [oldToken, reg] of registrations) {
    if (reg.graphId === graphId) {
      registrations.delete(oldToken);
    }
  }
  registrations.set(token, { ...full, graphId, userId });
  const bound = await ensureWebhookServer();
  return `http://127.0.0.1:${bound}/webhook/${token}`;
}

export async function unregisterWebhook(
  graphId: number,
  userId: number,
): Promise<void> {
  const name = `graph:${graphId}`;
  await prisma.option.deleteMany({
    where: { type: WEBHOOK_OPTION_TYPE, name, userId },
  });
  for (const [token, reg] of registrations) {
    if (reg.graphId === graphId && reg.userId === userId) {
      registrations.delete(token);
    }
  }
  // 该图在途 webhook 运行一并中止（图已关/删，继续跑无意义）
  abortRunsOfGraph(graphId);
  if (registrations.size === 0) {
    await stopWebhookServer();
  }
}

/** 中止某图的全部在途 webhook 运行（注销/删除图时调用） */
function abortRunsOfGraph(graphId: number): void {
  for (const run of activeRuns.values()) {
    if (run.graphId === graphId) {
      run.abort.abort();
    }
  }
}

/** 查询某图当前注册（含 URL 与配置，供编辑器配置弹窗回显） */
export async function getWebhookRegistration(
  graphId: number,
  userId: number,
): Promise<(WebhookConfig & { url: string }) | null> {
  const row = await prisma.option.findFirst({
    where: {
      type: WEBHOOK_OPTION_TYPE,
      name: `graph:${graphId}`,
      userId,
    },
  });
  if (!row) {
    return null;
  }
  const config = parseConfigValue(row.value);
  registrations.set(config.token, { ...config, graphId, userId });
  const bound = await ensureWebhookServer();
  return {
    ...config,
    url: `http://127.0.0.1:${bound}/webhook/${config.token}`,
  };
}

async function reloadRegistrations(): Promise<void> {
  registrations.clear();
  const rows = await prisma.option.findMany({
    where: { type: WEBHOOK_OPTION_TYPE },
  });
  for (const row of rows) {
    const matched = /^graph:(\d+)$/.exec(row.name);
    if (matched && row.userId !== null) {
      const config = parseConfigValue(row.value);
      registrations.set(config.token, {
        ...config,
        graphId: Number(matched[1]),
        userId: row.userId,
      });
    }
  }
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const jobMatch = /^\/webhook\/([a-f0-9]+)\/jobs\/(\d+)$/.exec(url.pathname);
    if (jobMatch && req.method === "GET") {
      // 异步 job 轮询：reg 校验 + 内存结果 → run 表兜底（重启后 output 空）
      const reg = registrations.get(jobMatch[1]);
      if (!reg) {
        sendJson(res, 404, { error: "invalid_token" });
        return;
      }
      const jobId = Number(jobMatch[2]);
      const memory = jobResults.get(jobId);
      if (memory) {
        sendJson(res, 200, memory);
        return;
      }
      const run = await prisma.automationRun.findFirst({
        where: { id: jobId, graphId: reg.graphId },
      });
      if (!run) {
        sendJson(res, 404, { error: "job_not_found" });
        return;
      }
      sendJson(res, 200, {
        status: run.status === "running" ? "running" : run.status,
        output: "",
        note: "重启后详细输出不保留（完整轨迹见运行历史）",
      });
      return;
    }
    const token = /^\/webhook\/([a-f0-9]+)$/.exec(url.pathname)?.[1];
    if (!token || req.method !== "POST") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    const reg = registrations.get(token);
    if (!reg) {
      sendJson(res, 404, { error: "invalid_token" });
      return;
    }
    const inputs = await parseBody(req);
    if (reg.async) {
      // 异步 job（fire-and-forget）：run 行落库（onRunId）即回 202，不等
      // 图完成——客户端凭 jobId 轮询；前置失败（图不可用等）无 runId，
      // runForWebhook 直接失败返回 500
      let notifyRunId!: (runId: number) => void;
      const runIdReady = new Promise<number>(
        (resolve) => (notifyRunId = resolve),
      );
      const outcome = runForWebhook(reg, inputs, {
        onRunId: notifyRunId,
        fireAndForget: true,
      });
      const first = await Promise.race([
        runIdReady,
        // 前置失败先于 runId 到达（onRunId 在 run 行创建时必已触发）
        outcome.then((o) => (o.ok ? null : o)),
      ]);
      if (first === null || typeof first === "number") {
        const jobId = await (typeof first === "number" ? first : runIdReady);
        sendJson(res, 202, {
          jobId,
          statusUrl: `http://127.0.0.1:${port}/webhook/${reg.token}/jobs/${jobId}`,
        });
        return;
      }
      sendJson(res, 500, { error: first.error });
      return;
    }
    const outcome = await runForWebhook(reg, inputs);
    if (!outcome.ok) {
      sendJson(res, 500, { error: outcome.error });
      return;
    }
    // 自定义模板：原样文本（模板自身可为 JSON 串，不再 stringify）；
    // 默认形态仍走 sendJson
    if (reg.responseTemplate.trim() === "") {
      sendJson(res, reg.statusCode, outcome.body);
    } else {
      res.writeHead(reg.statusCode, { "Content-Type": "application/json" });
      res.end(String(outcome.body));
    }
  })().catch((e) => {
    Log.error("webhook 处理异常", e);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "internal" });
    } else {
      res.end();
    }
  });
}

/** 执行 + 响应构建（自定义模板经 renderNodePrompt 渲染节点输出）。
 * fireAndForget（异步 job）：不挂 120s 强杀定时器（各节点自身超时兜底），
 * 完成结果只写内存 jobResults；两条路径完成均发布 taskFinished 事件
 * （targetType=graph，链式任务对 webhook 运行同样可续） */
async function runForWebhook(
  reg: Registration,
  inputs: Record<string, string>,
  opts?: { onRunId?: (runId: number) => void; fireAndForget?: boolean },
): Promise<
  | {
      ok: true;
      status: "success" | "failed";
      output: string;
      body: unknown;
      runId?: number;
    }
  | { ok: false; error: string; runId?: number }
> {
  const graph = await prisma.graphDefinition.findFirst({
    where: { id: reg.graphId, userId: reg.userId },
  });
  if (!graph || !graph.enabled) {
    return { ok: false, error: "graph_not_available" };
  }
  const workspace = await prisma.workspace.findFirst({
    where: { userId: reg.userId },
    orderBy: { id: "desc" },
  });
  if (!workspace) {
    return { ok: false, error: "workspace_not_found" };
  }
  const { runGraphToResult } = await import("./graph-executor");
  const abort = new AbortController();
  // 同步模式挂 120s 强杀；异步 fire-and-forget 靠节点自身超时，退出/
  // 注销时经 activeRuns 中止
  const timer =
    opts?.fireAndForget === true
      ? null
      : setTimeout(() => abort.abort(), SYNC_TIMEOUT_MS);
  const track = (runId: number) => {
    activeRuns.set(runId, { abort, graphId: reg.graphId });
    opts?.onRunId?.(runId);
  };
  try {
    const result = await runGraphToResult({
      graph: graph as GraphRow,
      task: null,
      inputs,
      triggerType: "webhook",
      attempt: 1,
      abort: abort.signal,
      workspace: { id: workspace.id, directoryPath: workspace.directoryPath },
      // 外部触发（token 即可达）对齐 default 任务：工具禁用生效；代码/
      // 写节点默认无全权，图级 fullAccess（注册时用户显式授权）放行
      disabledTools: readDisabledTools,
      codeAuthorized: reg.fullAccess === true,
      onRunId: track,
    });
    const runId = result.runId;
    if (runId !== undefined) {
      activeRuns.delete(runId);
    }
    // fire-and-forget 完成后写内存结果供 jobId 轮询（同步模式响应即结果）
    if (opts?.fireAndForget && runId !== undefined) {
      jobResults.set(runId, {
        status: result.status,
        output: result.output,
      });
    }
    // 完成即发布 taskFinished（同步/异步同径）——「图运行完成」链式任务
    // 对 webhook 运行同样续上（异常 event-bus 内部吞掉）
    const { publishAutomationEvent } =
      await import("../automation/automation-event-bus");
    await publishAutomationEvent({
      source: "taskFinished",
      targetType: "graph",
      targetId: reg.graphId,
      outcome: result.status,
    });
    // nodeOutputs 是 Record<id,string>；renderNodePrompt 要求 {output} 形态
    // ——逐项包装
    const nodesForRender: Record<string, { output: string }> = {};
    for (const [id, output] of Object.entries(result.nodeOutputs ?? {})) {
      nodesForRender[id] = { output };
    }
    const body =
      reg.responseTemplate.trim() === ""
        ? { status: result.status, output: result.output }
        : renderNodePrompt(reg.responseTemplate, {
            inputs,
            nodes: nodesForRender,
            now: new Date(),
          });
    return {
      ok: true,
      status: result.status,
      output: result.output,
      body,
      runId,
    };
  } catch (e) {
    Log.error("webhook 图执行异常", reg.graphId, e);
    return { ok: false, error: "internal" };
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

/**
 * 请求体解析（≤1MB；JSON 对象顶层值展平 string map）。end/error/close
 * 三口收敛 settle：客户端中途断开（无 end）时立即按已收内容收敛，外层
 * async 不永久悬挂。导出供单测。
 */
export function parseBody(
  req: http.IncomingMessage,
): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let raw = "";
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve(parseInputs(raw));
    };
    req.on("data", (chunk: Buffer) => {
      if (raw.length < 1024 * 1024) {
        raw += chunk.toString();
      }
    });
    req.on("end", settle);
    // error：连接复位；close：正常收尾后亦触发，settle 幂等无害
    req.on("error", settle);
    req.on("close", settle);
  });
}

/** 已收原文 → inputs（空/非 JSON/非对象 → 空 map；非字符串值 JSON 化） */
function parseInputs(raw: string): Record<string, string> {
  if (raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    const inputs: Record<string, string> = {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        inputs[key] = typeof value === "string" ? value : JSON.stringify(value);
      }
    }
    return inputs;
  } catch {
    return {};
  }
}
