/**
 * 入站 webhook 触发（GA-T7）：mirror electron/domains/ai/orchestration/
 * webhook-server.ts 的无头端等价——mirror 的本地 http server（127.0.0.1:
 * 27400，option webhook.port 可配）收敛为 Nest 控制器（/webhook/:token，
 * HTTP 生命周期随应用，无端口/启停面）。注册面：每图随机 token（option 表
 * type=webhook name=graph:<graphId> 存 JSON {token, responseTemplate,
 * statusCode, async}，兼容读旧版裸 token 值）。POST /webhook/<token>：
 * - 同步模式（默认）：挂起至完成（120s 上限，deps 可注入缩短值），自定义
 *   模板（经 renderNodePrompt 渲染 {{nodes.x.output}}/{{input.y}}）或默认
 *   {status, output} JSON，按配置状态码返回。
 * - 异步模式：立即 202 + {jobId, statusUrl}；GET /webhook/<token>/jobs/<id>
 *   轮询——内存存完整结果，重启后回落 run 表状态（output 不落库）。
 * JSON body 顶层字符串值 → inputs。workspace 取伴生用户最新一个
 * （session.repository findLatestWorkspace 同款 id desc 查询）。
 * 触发链调 GA-T4 executor：runGraphToResult（triggerType=webhook、
 * attempt=1、codeAuthorized=false——外部触发（token 即可达）对齐 default
 * 任务无全权语义，GraphRunParams.codeAuthorized 注释点名）。
 *
 * ================= server 环境适配点登记（其余逐段保持 mirror） =================
 * 1. prisma → server 自有 PrismaService（DI）；commons/Log → Nest Logger；
 *    bounded-map server 无此工具——按任务面最小内联（语义逐行同款）
 * 2. starter option 模型无 userId 列：注册/装载/注销按单伴生用户面
 *    （COMPANION_USER_ID，graph.service 同款口径）——upsert 复合键
 *    type_name_userId → type_name；mirror 的 per-user 注册隔离不适用
 * 3. 端口/启停面（ensureWebhookServer/stopWebhookServer/webhook.port/
 *    closeAllConnections）→ Nest 应用生命周期：onModuleInit 装载注册，
 *    onModuleDestroy 中止在途 webhook 运行（mirror 停服清理等价）
 * 4. setWebhookDisabledTools 工具禁用闭包（mirror Application 注入安全
 *    配置）→ server 无全局禁用配置面，不注入（graph.service.run 试运行
 *    同款缺省口径）；codeAuthorized=false 的核心无全权语义保持
 * 5. publishAutomationEvent(taskFinished) 未摘（Ruling 10：EventBus 由
 *    server EventBusService 承担，链式推进钩子 no-op；「图运行完成」的
 *    事件投影已由 executor 内部 graph.run.updated 承担）
 * 6. 返回 URL：mirror 拼绝对地址 http://127.0.0.1:${port}——无头端部署
 *    host/前缀不定，注册面返回相对路径 /webhook/<token>（触发响应内
 *    statusUrl 按请求自身 origin 拼绝对地址，由控制器传入）
 * ============================================================================
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { renderNodePrompt } from '@tianshu/core';
import { COMPANION_USER_ID } from 'src/commons/config/tianshu-config.entity';
import { ErrorCodeEnum } from 'src/commons/exception/error-code.enum';
import { BusinessException } from 'src/commons/exception/bussiness-exception';
import { PrismaService } from 'src/commons/database/prisma.service';
import { runGraphToResult } from 'src/core/graph/graph-executor';

const WEBHOOK_OPTION_TYPE = 'webhook';
/** 同步模式挂起上限（毫秒）——deps 可注入缩短值（测试快进） */
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

/** 可选依赖（缺省产线值；测试经 overrideProvider 注入缩短值/固定 token） */
export interface WebhookServiceDeps {
  /** 同步模式挂起上限（毫秒，缺省 120_000） */
  syncTimeoutMs?: number;
  /** token 生成器（缺省 randomBytes(24).hex） */
  generateToken?: () => string;
}

/** 控制器出参：真实状态码 + 原样响应体（string=模板原样文本，不再
 * stringify——绕开统一包装拦截器由 @Res() 直发） */
export interface WebhookHttpOutcome {
  status: number;
  body: unknown;
}

/** 管理面三端点统一回参（WH 批 2026-10-27；形状对齐 mirror
 * orchestration:webhookStatus：enabled + url + 四配置回显；url 为相对
 * 路径 /webhook/<token>，控制端按主机地址拼绝对） */
export interface WebhookManageResult {
  enabled: boolean;
  url: string;
  responseTemplate?: string;
  statusCode?: number;
  async?: boolean;
  fullAccess?: boolean;
}

interface Registration extends WebhookConfig {
  graphId: number;
  userId: number;
}

/** 执行 + 响应构建结果（mirror runForWebhook 返回形态） */
type RunOutcome =
  | {
      ok: true;
      status: 'success' | 'failed';
      output: string;
      body: unknown;
      runId?: number;
    }
  | { ok: false; error: string; runId?: number };

/** 有界 Map（插入序 FIFO 逐出）：超上限删最旧键——高频写入的内存缓存
 * （webhook 异步 job 结果）防无界增长。mirror commons/bounded-map 同款
 * 最小内联；仅暴露 get/set/has/size 最小面，语义与 Map 对齐；重复 set
 * 已有键不刷新位置（按首次插入序逐出）。 */
interface BoundedMap<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  has(key: K): boolean;
  readonly size: number;
}

function createBoundedMap<K, V>(max: number): BoundedMap<K, V> {
  const map = new Map<K, V>();
  return {
    get: (key) => map.get(key),
    has: (key) => map.has(key),
    set(key, value) {
      map.set(key, value);
      if (map.size > max) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
    },
    get size() {
      return map.size;
    },
  };
}

/** 异步 job 结果保留上限：外部高频触发下内存不无界（插入序 FIFO 逐出最旧） */
const JOB_RESULTS_MAX = 200;

/** option 行值 → 注册配置（旧版裸 token 兼容读） */
function parseConfigValue(value: string): WebhookConfig {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { token?: unknown }).token === 'string'
    ) {
      const cfg = parsed as WebhookConfig;
      return {
        token: cfg.token,
        responseTemplate:
          typeof cfg.responseTemplate === 'string' ? cfg.responseTemplate : '',
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
  return { token: value, responseTemplate: '', statusCode: 200, async: false };
}

/** JSON body → inputs（非对象/数组 → 空 map；非字符串值 JSON 化）。mirror
 * parseInputs 的已解析对象面——原始 raw 面由 fastify JSON parser 承担
 * （1MB bodyLimit 等价、坏 JSON 由框架 400 拒） */
function parseInputs(body: unknown): Record<string, string> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {};
  }
  const inputs: Record<string, string> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    inputs[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return inputs;
}

@Injectable()
export class WebhookService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookService.name);
  /** token → 注册（mirror registrations 同款；启动时自 option 表装载） */
  private readonly registrations = new Map<string, Registration>();
  /** 异步 job 结果（内存；重启后 GET 回落 run 表状态，output 置空并标注） */
  private readonly jobResults = createBoundedMap<
    number,
    { status: 'success' | 'failed'; output: string }
  >(JOB_RESULTS_MAX);
  /** 在途运行注册表（runId → {abort, graphId}）：注销或删除图时统一中止
   * （mirror activeRuns 同款先例；执行完成即移除） */
  private readonly activeRuns = new Map<
    number,
    { abort: AbortController; graphId: number }
  >();
  private readonly syncTimeoutMs: number;
  private readonly generateToken: () => string;

  constructor(
    private readonly prisma: PrismaService,
    deps: WebhookServiceDeps = {},
  ) {
    this.syncTimeoutMs = deps.syncTimeoutMs ?? SYNC_TIMEOUT_MS;
    this.generateToken =
      deps.generateToken ?? (() => randomBytes(24).toString('hex'));
  }

  /** 启动装载注册（mirror ensureWebhookServer 的 reloadRegistrations 段） */
  async onModuleInit(): Promise<void> {
    await this.reloadRegistrations();
  }

  /** 应用关闭中止在途 webhook 运行（mirror stopWebhookServer 的清理段） */
  onModuleDestroy(): void {
    for (const run of this.activeRuns.values()) {
      run.abort.abort();
    }
    this.activeRuns.clear();
  }

  /** 注册/重注册（开启或改配置时生成新 token 旧 token 失效）。返回相对
   * URL /webhook/<token>（适配点 6：绝对地址由调用端拼） */
  async registerWebhook(
    graphId: number,
    userId: number,
    config?: Partial<
      Pick<
        WebhookConfig,
        'responseTemplate' | 'statusCode' | 'async' | 'fullAccess'
      >
    >,
  ): Promise<WebhookConfig & { url: string }> {
    const token = this.generateToken();
    const full: WebhookConfig = {
      token,
      responseTemplate: config?.responseTemplate ?? '',
      statusCode: config?.statusCode ?? 200,
      async: config?.async ?? false,
      fullAccess: config?.fullAccess ?? false,
    };
    const name = `graph:${graphId}`;
    await this.prisma.option.upsert({
      where: { type_name: { type: WEBHOOK_OPTION_TYPE, name } },
      create: {
        type: WEBHOOK_OPTION_TYPE,
        name,
        value: JSON.stringify(full),
      },
      update: { value: JSON.stringify(full) },
    });
    // 重开旧 token 立即失效：option 行已换新值，同图内存旧条目一并清
    //（否则运行期旧 token 仍可达，轮换语义失效——重启装载前安全窗口；
    // unregisterWebhook 同款遍历；mirror webhook-server 同根修复随批）
    for (const [oldToken, reg] of this.registrations) {
      if (reg.graphId === graphId) {
        this.registrations.delete(oldToken);
      }
    }
    this.registrations.set(token, { ...full, graphId, userId });
    return { ...full, url: `/webhook/${token}` };
  }

  /** 注销（GA-T3 deleteGraph 钩子接线）：清 option 行 + 内存注册，该图在
   * 途 webhook 运行一并中止（图已删，继续跑无意义）。option 无 userId 列
   * （适配点 2）——mirror deleteMany 的 userId 条件不适用；hook 签名
   * (graphId, userId) 单参即可满足 */
  async unregisterWebhook(graphId: number): Promise<void> {
    const name = `graph:${graphId}`;
    await this.prisma.option.deleteMany({
      where: { type: WEBHOOK_OPTION_TYPE, name },
    });
    for (const [token, reg] of this.registrations) {
      if (reg.graphId === graphId) {
        this.registrations.delete(token);
      }
    }
    this.abortRunsOfGraph(graphId);
  }

  /** 查询某图当前注册（含 URL 与配置，供配置面回显；同时刷新内存注册） */
  async getWebhookRegistration(
    graphId: number,
  ): Promise<(WebhookConfig & { url: string }) | null> {
    const row = await this.prisma.option.findFirst({
      where: { type: WEBHOOK_OPTION_TYPE, name: `graph:${graphId}` },
    });
    if (!row) {
      return null;
    }
    const config = parseConfigValue(row.value);
    this.registrations.set(config.token, {
      ...config,
      graphId,
      userId: COMPANION_USER_ID,
    });
    return { ...config, url: `/webhook/${config.token}` };
  }

  /** POST /webhook/<token>（mirror handleRequest 主段：同步模板/异步 202）。
   * statusUrlBase = 请求自身 origin+路径（含部署前缀），statusUrl 对调用
   * 端即达 */
  async trigger(
    token: string,
    body: unknown,
    statusUrlBase: string,
  ): Promise<WebhookHttpOutcome> {
    const reg = this.registrations.get(token);
    if (!reg) {
      return { status: 404, body: { error: 'invalid_token' } };
    }
    const inputs = parseInputs(body);
    if (reg.async) {
      // 异步 job（fire-and-forget）：run 行落库（onRunId）即回 202，不等
      // 图完成——客户端凭 jobId 轮询；前置失败（图不可用等）无 runId，
      // runForWebhook 直接失败返回 500
      let notifyRunId!: (runId: number) => void;
      const runIdReady = new Promise<number>(
        (resolve) => (notifyRunId = resolve),
      );
      const outcome = this.runForWebhook(reg, inputs, {
        onRunId: notifyRunId,
        fireAndForget: true,
      });
      const first = await Promise.race([
        runIdReady,
        // 前置失败先于 runId 到达（onRunId 在 run 行创建时必已触发）
        outcome.then((o) => (o.ok ? null : o)),
      ]);
      if (first === null || typeof first === 'number') {
        const jobId = typeof first === 'number' ? first : await runIdReady;
        // 202 已回，后续完成仅写内存 job 结果；链尾兜底防未处理拒绝
        // （server 常驻进程崩溃面；mirror 同位由 http 请求外层 catch 收敛）
        void outcome.catch((e): void => {
          this.logger.warn(
            `webhook 异步 job 异常 graph=${reg.graphId}: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
        return {
          status: 202,
          body: { jobId, statusUrl: `${statusUrlBase}/jobs/${jobId}` },
        };
      }
      return { status: 500, body: { error: first.error } };
    }
    const outcome = await this.runForWebhook(reg, inputs);
    if (!outcome.ok) {
      return { status: 500, body: { error: outcome.error } };
    }
    return { status: reg.statusCode, body: outcome.body };
  }

  /** GET /webhook/<token>/jobs/<id>：reg 校验 + 内存结果 → run 表兜底
   * （重启后 output 空；jobId = runId） */
  async getJob(token: string, jobIdRaw: string): Promise<WebhookHttpOutcome> {
    const reg = this.registrations.get(token);
    if (!reg) {
      return { status: 404, body: { error: 'invalid_token' } };
    }
    const jobId = Number(jobIdRaw);
    if (!Number.isInteger(jobId)) {
      return { status: 404, body: { error: 'job_not_found' } };
    }
    const memory = this.jobResults.get(jobId);
    if (memory) {
      return { status: 200, body: memory };
    }
    const run = await this.prisma.automationRun.findFirst({
      where: { id: jobId, graphId: reg.graphId },
    });
    if (!run) {
      return { status: 404, body: { error: 'job_not_found' } };
    }
    return {
      status: 200,
      body: {
        status: run.status === 'running' ? 'running' : run.status,
        output: '',
        note: '重启后详细输出不保留（完整轨迹见运行历史）',
      },
    };
  }

  /** 中止某图的全部在途 webhook 运行（注销/删除图时调用） */
  private abortRunsOfGraph(graphId: number): void {
    for (const run of this.activeRuns.values()) {
      if (run.graphId === graphId) {
        run.abort.abort();
      }
    }
  }

  /**
   * 管理面：开启（WH 批 2026-10-27）。图存在性前置校验（mirror
   * orchestration:webhookEnable 同语义——不存在即 4040），重开经
   * registerWebhook 换新 token 旧失效；url 相对路径（适配点 6） */
  async enableWebhook(
    graphId: number,
    config?: Partial<
      Pick<
        WebhookConfig,
        'responseTemplate' | 'statusCode' | 'async' | 'fullAccess'
      >
    >,
  ): Promise<WebhookManageResult> {
    const graph = await this.prisma.graphDefinition.findFirst({
      where: { id: graphId, userId: COMPANION_USER_ID },
    });
    if (!graph) {
      throw new BusinessException('图不存在', ErrorCodeEnum.NOT_FOUND);
    }
    const reg = await this.registerWebhook(graphId, COMPANION_USER_ID, config);
    return { enabled: true, url: reg.url, ...this.manageConfigOf(reg) };
  }

  /** 管理面：关闭（幂等——未注册同样回 disabled；在途运行一并中止） */
  async disableWebhook(graphId: number): Promise<WebhookManageResult> {
    await this.unregisterWebhook(graphId);
    return { enabled: false, url: '' };
  }

  /** 管理面：查询回显（形状对齐 mirror orchestration:webhookStatus） */
  async getWebhookStatus(graphId: number): Promise<WebhookManageResult> {
    const reg = await this.getWebhookRegistration(graphId);
    if (!reg) {
      return { enabled: false, url: '' };
    }
    return { enabled: true, url: reg.url, ...this.manageConfigOf(reg) };
  }

  /** 注册结果 → 管理回显配置段（四字段显式列出，token 不单列——url 内含） */
  private manageConfigOf(
    reg: WebhookConfig & { url: string },
  ): Pick<
    WebhookConfig,
    'responseTemplate' | 'statusCode' | 'async' | 'fullAccess'
  > {
    return {
      responseTemplate: reg.responseTemplate,
      statusCode: reg.statusCode,
      async: reg.async,
      fullAccess: reg.fullAccess,
    };
  }

  /** 装载注册（启动时全量重放 option 表；mirror reloadRegistrations 段，
   * userId 自 option 行取的段不适用——适配点 2） */
  private async reloadRegistrations(): Promise<void> {
    this.registrations.clear();
    const rows = await this.prisma.option.findMany({
      where: { type: WEBHOOK_OPTION_TYPE },
    });
    for (const row of rows) {
      const matched = /^graph:(\d+)$/.exec(row.name);
      if (matched) {
        const config = parseConfigValue(row.value);
        this.registrations.set(config.token, {
          ...config,
          graphId: Number(matched[1]),
          userId: COMPANION_USER_ID,
        });
      }
    }
  }

  /** 执行 + 响应构建（自定义模板经 renderNodePrompt 渲染节点输出）。
   * fireAndForget（异步 job）：不挂同步强杀定时器（各节点自身超时兜底），
   * 完成结果只写内存 jobResults */
  private async runForWebhook(
    reg: Registration,
    inputs: Record<string, string>,
    opts?: { onRunId?: (runId: number) => void; fireAndForget?: boolean },
  ): Promise<RunOutcome> {
    const graph = await this.prisma.graphDefinition.findFirst({
      where: { id: reg.graphId, userId: reg.userId },
    });
    if (!graph || !graph.enabled) {
      return { ok: false, error: 'graph_not_available' };
    }
    const workspace = await this.prisma.workspace.findFirst({
      where: { userId: reg.userId },
      orderBy: { id: 'desc' },
    });
    if (!workspace) {
      return { ok: false, error: 'workspace_not_found' };
    }
    const abort = new AbortController();
    // 同步模式挂强杀；异步 fire-and-forget 靠节点自身超时，关闭/注销时经
    // activeRuns 中止
    const timer =
      opts?.fireAndForget === true
        ? null
        : setTimeout(() => abort.abort(), this.syncTimeoutMs);
    const track = (runId: number) => {
      this.activeRuns.set(runId, { abort, graphId: reg.graphId });
      opts?.onRunId?.(runId);
    };
    try {
      const result = await runGraphToResult({
        graph,
        task: null,
        inputs,
        triggerType: 'webhook',
        attempt: 1,
        abort: abort.signal,
        workspace: { id: workspace.id, directoryPath: workspace.directoryPath },
        // 外部触发（token 即可达）对齐 default 任务：代码/写节点默认
        // 无全权，图级 fullAccess（注册时用户显式授权）放行
        // （GraphRunParams.codeAuthorized 注释点名 webhook；disabledTools
        // 见适配点 4——server 无全局禁用配置面，缺省）
        codeAuthorized: reg.fullAccess === true,
        onRunId: track,
      });
      const runId = result.runId;
      if (runId !== undefined) {
        this.activeRuns.delete(runId);
      }
      // fire-and-forget 完成后写内存结果供 jobId 轮询（同步模式响应即结果）
      if (opts?.fireAndForget && runId !== undefined) {
        this.jobResults.set(runId, {
          status: result.status,
          output: result.output,
        });
      }
      // nodeOutputs 是 Record<id,string>；renderNodePrompt 要求 {output} 形态
      // ——逐项包装
      const nodesForRender: Record<string, { output: string }> = {};
      for (const [id, output] of Object.entries(result.nodeOutputs ?? {})) {
        nodesForRender[id] = { output };
      }
      const body =
        reg.responseTemplate.trim() === ''
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
      this.logger.error(
        `webhook 图执行异常 graph=${reg.graphId}`,
        e instanceof Error ? e.stack : String(e),
      );
      return { ok: false, error: 'internal' };
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }
}
