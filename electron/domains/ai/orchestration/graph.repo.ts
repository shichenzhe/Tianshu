/**
 * 编排图仓储 + IPC（spec §6/§8）。userId 隔离（handleUser 解 token）；
 * 保存期 validateGraph 阻断非法图；update 乐观锁（version 不符 →
 * VERSION_CONFLICT）；删除先查任务引用拒绝悬空；runTest 试运行互斥走
 * graphTestInflight，fire-and-forget 收尾推 graphs-changed 并发布
 * taskFinished(targetType=graph) 事件（T10 留的图试运行发布点）；
 * cancelTestRun 手工中断在途试运行（executor 侧归一 user_aborted）。
 */
import { BrowserWindow, dialog, ipcMain } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import prisma from "../../../commons/prisma-client";
import Log from "../../../commons/Log";
import { handleUser } from "../../../commons/ipc-user";
import { workflowAssetsDir } from "../../../commons/paths";
import {
  graphNodeSchema,
  normalizeGraph,
  validateGraph,
} from "../../../../src-react/domains/ai/orchestration/api/graph.schema";
import { GRAPH_CHANGED_EVENT } from "../../../../src-react/domains/ai/orchestration/api/orchestration.api";
import {
  buildWorkflowBundle,
  dedupeName,
  parseWorkflowBundle,
} from "./workflow-bundle";
import { registerTools } from "../agent/tool-registry";
import {
  makeGetWorkflowRunTool,
  makeRunWorkflowTool,
  makeWorkflowReadTool,
  makeWorkflowWriteTool,
  type SessionPrismaLike,
  type WorkspacePrismaLike,
  type WorkflowGraphPrismaLike,
  type WorkflowRunPrismaLike,
} from "./create-workflow";
import type {
  RunPage,
  RunRecord,
} from "../../../../src-react/domains/ai/automation/api/automation.api";
import { executeGraphRun, polishNodePrompt } from "./graph-executor";
import { listGraphTemplates, type GraphTemplate } from "./graph-templates";
import { graphTestInflight } from "./graph-inflight";
import { publishAutomationEvent } from "../automation/automation-event-bus";

type GraphRow = NonNullable<
  Awaited<ReturnType<typeof prisma.graphDefinition.findFirst>>
>;
type RunRow = NonNullable<
  Awaited<ReturnType<typeof prisma.automationRun.findFirst>>
>;

/** 图运行历史分页大小（对齐 automation listRuns 的 PAGE_SIZE=20） */
const RUN_PAGE_SIZE = 20;

/** 图变更收口推送：试运行收尾后通知渲染层刷新（先例
 * notifyTasksChanged；CRUD 响应即回不推，同 automation repo 语义——
 * IPC 调用方自 invalidate；chat 工具 create/update 写库无前端调用方，
 * 经 deps.notify 也走此广播） */
function notifyGraphsChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(GRAPH_CHANGED_EVENT);
  }
}

/** 前端图记录（nodeCount 由 graphJson 派生，列表卡片直显） */
export interface GraphRecord {
  id: number;
  name: string;
  description?: string;
  graphJson: string;
  version: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
}

/** DB 行 → 前端记录（历史脏行坏 JSON 容错 nodeCount=0，不炸列表） */
export function toGraphRecord(row: GraphRow): GraphRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    graphJson: row.graphJson,
    version: row.version,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    nodeCount: countNodes(row.graphJson),
  };
}

function countNodes(graphJson: string): number {
  try {
    const nodes = (JSON.parse(graphJson) as { nodes?: unknown }).nodes;
    return Array.isArray(nodes) ? nodes.length : 0;
  } catch {
    return 0;
  }
}

/** run 行 → RunRecord（图运行历史视图）。taskName 复用图名——试运行与
 * 任务挂图运行同口径（automation.repo toRunRecord 的图侧轻量版，
 * taskName 字段沿用 RunRecord 形态） */
function toGraphRunRecord(row: RunRow, graphName: string): RunRecord {
  return {
    id: row.id,
    taskId: row.taskId,
    taskName: graphName,
    graphId: row.graphId ?? undefined,
    graphTrace: row.graphTrace ?? undefined,
    sessionId: row.sessionId ?? undefined,
    attempt: row.attempt,
    triggerType: row.triggerType as RunRecord["triggerType"],
    status: row.status as RunRecord["status"],
    durationMs: row.durationMs ?? undefined,
    promptTokens: row.promptTokens ?? undefined,
    completionTokens: row.completionTokens ?? undefined,
    error: row.error ?? undefined,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
  };
}

export interface GraphCreateParams {
  name: string;
  description?: string;
  graphJson: string;
}

export interface GraphUpdateParams extends GraphCreateParams {
  version: number;
}

/** graphJson 字符串 → 校验并规范化序列（先例 buildTaskData 的 eventJson：
 * 非法 JSON/结构不合保存期即拒，错误码即校验 issues；zod 默认值随
 * 规范化落库）。校验通过后 normalizeGraph 归一补齐——start 节点缺失
 * 与末节点断头（AI 技能生成的图常省略"无执行语义"的 start；无出边
 * 叶子在画布上 END 连线缺失），保存统一口在此自愈（执行语义不变） */
function parseGraphJson(graphJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(graphJson);
  } catch (e) {
    throw new Error(
      `graphJson 不是合法 JSON: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
  const validated = validateGraph(parsed);
  if (!validated.ok) {
    // 码列表（渲染端按 chat:orchestration.validation.<code> 本地化；
    // 前端保存前已内联校验，此为后端兜底）
    throw new Error(validated.issues.map((issue) => issue.code).join("; "));
  }
  return JSON.stringify(normalizeGraph(validated.value));
}

export default class GraphRepository {
  /** 工具禁用清单闭包（先例 AutomationRepository，SP6 裁定 2）：
   * Application 注入实时读安全配置，缺省不滤（测试）；试运行与调度/
   * 手动/事件触发同一过滤口径 */
  constructor(private disabledTools: () => string[] = () => []) {
    // workflow_write/read 静态注册进 P1 聚合点（先例 skill.repo 的
    // create_skill；2026-10-29 六件坍缩四件），chat.service 从 registry
    // 透传零侵入
    const graphDelegate =
      prisma.graphDefinition as unknown as WorkflowGraphPrismaLike;
    const sessionDelegate = prisma.session as unknown as SessionPrismaLike;
    registerTools([
      makeWorkflowWriteTool({
        graphDefinition: graphDelegate,
        session: sessionDelegate,
        // 对话建图无前端调用方 invalidate，落库即广播列表失效
        notify: () => notifyGraphsChanged(),
      }),
      makeWorkflowReadTool({
        graphDefinition: graphDelegate,
        session: sessionDelegate,
      }),
      makeRunWorkflowTool({
        graphDefinition: graphDelegate,
        session: sessionDelegate,
        workspace: prisma.workspace as unknown as WorkspacePrismaLike,
        // 异步发射（fire-and-forget）：互斥/收尾在 launchTestRun 内
        launch: (p) =>
          this.launchTestRun(p.graph as never, p.inputs, p.workspace),
      }),
      makeGetWorkflowRunTool({
        graphDefinition: graphDelegate,
        session: sessionDelegate,
        runs: prisma.automationRun as unknown as WorkflowRunPrismaLike,
      }),
    ]);
    this.registerHandlers();
  }

  private registerHandlers(): void {
    handleUser("orchestration:list", (_, userId) => this.listGraphs(userId));
    handleUser("orchestration:create", (_, userId, p: GraphCreateParams) =>
      this.createGraph(p, userId),
    );
    handleUser(
      "orchestration:update",
      (_, userId, id: number, p: GraphUpdateParams) =>
        this.updateGraph(id, p, userId),
    );
    handleUser("orchestration:delete", (_, userId, id: number) =>
      this.deleteGraph(id, userId),
    );
    handleUser(
      "orchestration:toggle",
      (_, userId, id: number, enabled: boolean) =>
        this.toggleGraph(id, enabled, userId),
    );
    // templates 为静态模板：不涉用户数据，保留匿名通道（先例
    // automation:templates；渲染端统一追加的 token 会被忽略）
    ipcMain.handle("orchestration:templates", (): GraphTemplate[] =>
      listGraphTemplates(),
    );
    handleUser(
      "orchestration:runTest",
      (
        _,
        userId,
        id: number,
        inputs: Record<string, string>,
        workspaceId: number,
        draftJson?: string,
      ) => this.runTest(id, inputs, workspaceId, userId, draftJson),
    );
    // 手工中断试运行（渲染端运行历史/画布「停止」入口；错误码
    // GRAPH_NOT_RUNNING / GRAPH_NOT_FOUND 由渲染端映射文案）
    handleUser("orchestration:cancelTestRun", (_, userId, id: number) =>
      this.cancelTestRun(id, userId),
    );
    handleUser(
      "orchestration:runs",
      (_, userId, graphId: number, page: number) =>
        this.listGraphRuns(graphId, page, userId),
    );
    // 节点详情行（去会话化 2026-10-28，spec §4 三层下钻第三层）：
    // 归属两段校验与 id asc 排序内聚 listRunNodes（执行详情批起
    // server-face automation/runNodes 桥同源消费）
    handleUser("orchestration:runNodes", (_, userId, runId: number) =>
      this.listRunNodes(runId, userId),
    );
    // 提示词 AI 润色（编辑器轻量能力，不走图执行链路）
    handleUser(
      "orchestration:polishPrompt",
      (_, _userId, modelId: number, prompt: string) =>
        polishNodePrompt(modelId, prompt),
    );
    // HTTP 节点 binary 请求体文件选择（系统对话框，取消返回 null）：
    // 选择即固化——拷贝到 userData/workflow-assets/，工作流引用拷贝路径，
    // 源文件后续移动/修改不影响执行（Coze 云上传同款语义）
    handleUser(
      "orchestration:pickBinaryFile",
      async (): Promise<string | null> => this.pickBinaryFile(),
    );
    // 导入/导出（渲染层发起，对话框与文件 IO 在主进程；见方法注释）
    handleUser(
      "orchestration:exportWorkflow",
      (
        _,
        _userId,
        p: { name: string; description?: string; graphJson: string },
      ) => this.exportWorkflow(p),
    );
    // bundle 导入直接建库需归属 userId（单图分支仅预填不用）；渲染端
    // invoke 本就统一追加 token，匿名注册改为鉴权通道对前端零改动
    handleUser("orchestration:importWorkflow", (_, userId) =>
      this.importWorkflow(userId),
    );
    // 批量导出：选中图聚合 bundle 落盘（dialog 与 IO 同单导出，见方法注释）
    handleUser("orchestration:exportWorkflows", (_, userId, ids: number[]) =>
      this.exportWorkflows(ids, userId),
    );
    // 入站 webhook：开启（生成新 token）/ 关闭 / 查询（返回完整 URL）
    handleUser(
      "orchestration:webhookEnable",
      async (
        _,
        userId,
        graphId: number,
        config?: {
          responseTemplate?: string;
          statusCode?: number;
          async?: boolean;
          fullAccess?: boolean;
        },
      ): Promise<string> => {
        const graph = await prisma.graphDefinition.findFirst({
          where: { id: graphId, userId },
        });
        if (!graph) {
          throw new Error(`graph ${graphId} not found`);
        }
        const { registerWebhook } = await import("./webhook-server");
        return registerWebhook(graphId, userId, config);
      },
    );
    handleUser(
      "orchestration:webhookDisable",
      async (_, userId, graphId: number): Promise<void> => {
        const { unregisterWebhook } = await import("./webhook-server");
        await unregisterWebhook(graphId, userId);
      },
    );
    handleUser(
      "orchestration:webhookStatus",
      async (
        _,
        userId,
        graphId: number,
      ): Promise<{
        enabled: boolean;
        url: string;
        responseTemplate?: string;
        statusCode?: number;
        async?: boolean;
        fullAccess?: boolean;
      }> => {
        const { getWebhookRegistration } = await import("./webhook-server");
        const reg = await getWebhookRegistration(graphId, userId);
        return {
          enabled: reg !== null,
          url: reg?.url ?? "",
          ...(reg
            ? {
                responseTemplate: reg.responseTemplate,
                statusCode: reg.statusCode,
                async: reg.async,
                fullAccess: reg.fullAccess === true,
              }
            : {}),
        };
      },
    );
    // 单节点测试：zod 校验入参节点后轻量单跑（不落 run 记录）
    handleUser(
      "orchestration:testNode",
      async (
        _,
        userId,
        rawNode: object,
        inputs: Record<string, string>,
        nodes: Record<string, { output: string }>,
        workspaceId: number,
      ) => {
        const parsedNode = graphNodeSchema.safeParse(rawNode);
        if (!parsedNode.success) {
          throw new Error("node_invalid: 节点数据不合法");
        }
        const workspace = await prisma.workspace.findFirst({
          where: { id: workspaceId, userId },
        });
        if (!workspace) {
          throw new Error("WORKSPACE_NOT_FOUND");
        }
        const { testSingleNode } = await import("./graph-executor");
        return testSingleNode({
          node: parsedNode.data,
          inputs,
          nodes,
          workspace: {
            id: workspace.id,
            directoryPath: workspace.directoryPath,
          },
          userId,
        });
      },
    );
  }

  /** binary 文件固化拷贝上限（与执行器 readBinaryBody 同限，选择期
   * 前置拦截，错误更友好） */
  private static readonly BINARY_LIMIT = 10 * 1024 * 1024;

  async pickBinaryFile(): Promise<string | null> {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      title: "选择上传文件",
    });
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    const source = result.filePaths[0];
    const stat = await fs.stat(source);
    if (stat.size > GraphRepository.BINARY_LIMIT) {
      throw new Error("HTTP_BINARY_TOO_LARGE");
    }
    const dir = workflowAssetsDir();
    await fs.mkdir(dir, { recursive: true });
    // 时间戳前缀防重名互相覆盖；basename 天然无路径分隔符，不越目录
    const dest = path.join(dir, `${Date.now()}-${path.basename(source)}`);
    await fs.copyFile(source, dest);
    return dest;
  }

  /** 导出工作流：系统另存对话框 → 写自包含 JSON（kind 魔术标识 +
   * name/description + graphJson 对象）。取消返回 null；graphJson 由
   * 调用方序列化（编辑器传当前草稿序列，所见即所得） */
  async exportWorkflow(payload: {
    name: string;
    description?: string;
    graphJson: string;
  }): Promise<string | null> {
    const result = await dialog.showSaveDialog({
      title: "导出工作流",
      defaultPath: `${(payload.name || "workflow").replace(/[\\/:*?"<>|]/g, "_")}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) {
      return null;
    }
    let graph: object;
    try {
      graph = JSON.parse(payload.graphJson) as object;
    } catch (e) {
      throw new Error(
        `graphJson 不是合法 JSON: ${e instanceof Error ? e.message : e}`,
        { cause: e },
      );
    }
    const doc = {
      kind: "tianshu-workflow",
      version: 1,
      name: payload.name,
      description: payload.description ?? "",
      graphJson: graph,
    };
    await fs.writeFile(result.filePath, JSON.stringify(doc, null, 2), "utf8");
    return result.filePath;
  }

  /** 导入工作流：文件选择（10MB 上限——bundle 多图聚合）→ 解析（bundle
   *  聚合优先逐项校验建库；单图包裹格式优先，裸 graphJson 兼容、文件名
   *  兜底为名称）→ validateGraph 前置校验（不合法带错误码返回，不进预填
   *  链路）；取消返回 null */
  async importWorkflow(userId: number): Promise<
    | {
        ok: true;
        kind: "single";
        name: string;
        description: string;
        graphJson: object;
      }
    | {
        ok: true;
        kind: "bundle";
        imported: string[];
        failed: Array<{ name: string; reason: string }>;
      }
    | { ok: false; reason: string }
    | null
  > {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      title: "导入工作流",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    const source = result.filePaths[0];
    const stat = await fs.stat(source);
    if (stat.size > 10 * 1024 * 1024) {
      return { ok: false, reason: "文件超过 10MB 上限" };
    }
    const raw = await fs.readFile(source, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return {
        ok: false,
        reason: `不是合法 JSON: ${e instanceof Error ? e.message : e}`,
      };
    }
    // bundle 分支：聚合文件逐项校验建库（名称冲突加后缀），不走单图预填
    const bundle = parseWorkflowBundle(parsed);
    if (bundle.ok) {
      const used = new Set(
        (
          await prisma.graphDefinition.findMany({
            select: { name: true },
          })
        ).map((row) => row.name),
      );
      const imported: string[] = [];
      const failed = [...bundle.failed];
      for (const item of bundle.items) {
        const validated = validateGraph(item.graphJson);
        if (!validated.ok) {
          failed.push({
            name: item.name,
            reason: `图校验未通过: ${validated.issues
              .map((issue) => issue.code)
              .join("; ")}`,
          });
          continue;
        }
        await this.createGraph(
          {
            name: dedupeName(item.name, used),
            description: item.description || undefined,
            graphJson: JSON.stringify(validated.value),
          },
          userId,
        );
        imported.push(item.name);
      }
      return { ok: true, kind: "bundle", imported, failed };
    }
    const wrapped =
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as { kind?: unknown }).kind === "tianshu-workflow"
        ? (parsed as {
            name?: unknown;
            description?: unknown;
            graphJson?: unknown;
          })
        : null;
    const graphCandidate = wrapped ? wrapped.graphJson : parsed;
    if (
      graphCandidate === null ||
      typeof graphCandidate !== "object" ||
      Array.isArray(graphCandidate)
    ) {
      return {
        ok: false,
        reason: "文件内容不是工作流定义（缺少 graphJson 对象）",
      };
    }
    const name =
      wrapped && typeof wrapped.name === "string" && wrapped.name !== ""
        ? wrapped.name
        : path.basename(source, ".json");
    const description =
      wrapped && typeof wrapped.description === "string"
        ? wrapped.description
        : "";
    const validated = validateGraph(graphCandidate);
    if (!validated.ok) {
      return {
        ok: false,
        reason: `图校验未通过: ${validated.issues
          .map((issue) => issue.code)
          .join("; ")}`,
      };
    }
    return {
      ok: true,
      kind: "single",
      name,
      description,
      graphJson: validated.value,
    };
  }

  /** 批量导出：选中图（userId 隔离）聚合 bundle → save dialog 落盘；
   *  取消返回 null；查不到任何图（越权/空选）抛错 */
  async exportWorkflows(
    ids: number[],
    userId: number,
  ): Promise<{ path: string; count: number } | null> {
    const rows = await prisma.graphDefinition.findMany({
      where: { id: { in: ids }, userId },
    });
    if (rows.length === 0) {
      throw new Error("GRAPH_NOT_FOUND");
    }
    const bundle = buildWorkflowBundle(
      rows.map((row) => ({
        name: row.name,
        description: row.description ?? undefined,
        graphJson: row.graphJson,
      })),
    );
    const date = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
    const result = await dialog.showSaveDialog({
      title: "批量导出工作流",
      defaultPath: `workflows-${stamp}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) {
      return null;
    }
    await fs.writeFile(
      result.filePath,
      JSON.stringify(bundle, null, 2),
      "utf8",
    );
    return { path: result.filePath, count: bundle.workflows.length };
  }

  /** 校验图归当前用户（不存在与他人所有同报错，不泄露存在性） */
  private async assertGraphOwned(id: number, userId: number): Promise<void> {
    const row = await prisma.graphDefinition.findFirst({
      where: { id, userId },
    });
    if (!row) {
      throw new Error(`graph ${id} not found`);
    }
  }

  async listGraphs(userId: number): Promise<GraphRecord[]> {
    const rows = await prisma.graphDefinition.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toGraphRecord);
  }

  private async createGraph(
    p: GraphCreateParams,
    userId: number,
  ): Promise<GraphRecord> {
    const graphJson = parseGraphJson(p.graphJson);
    const row = await prisma.graphDefinition.create({
      data: {
        name: p.name,
        description: p.description ?? null,
        graphJson,
        userId,
      },
    });
    return toGraphRecord(row);
  }

  /** graphJson 是否含 subflow/iterate 节点引用指定图（删除引用检查用；
   * 坏 JSON 容错 false） */
  private refOfGraphJson(graphJson: string, graphId: number): boolean {
    try {
      const nodes = (JSON.parse(graphJson) as { nodes?: unknown[] }).nodes;
      return (
        Array.isArray(nodes) &&
        nodes.some(
          (node) =>
            node !== null &&
            typeof node === "object" &&
            ((node as { kind?: unknown }).kind === "subflow" ||
              (node as { kind?: unknown }).kind === "iterate") &&
            (node as { graphId?: unknown }).graphId === graphId,
        )
      );
    } catch {
      return false;
    }
  }

  /** eventJson 是否为指向指定图的 taskFinished 链式配置（删除引用检查
   * 用；空/坏 JSON 容错 false） */
  private refOfEventJson(eventJson: string | null, graphId: number): boolean {
    if (!eventJson) {
      return false;
    }
    try {
      const parsed = JSON.parse(eventJson) as {
        source?: unknown;
        targetType?: unknown;
        targetId?: unknown;
      };
      return (
        parsed.source === "taskFinished" &&
        parsed.targetType === "graph" &&
        parsed.targetId === graphId
      );
    } catch {
      return false;
    }
  }

  /** 乐观锁：前端携带的 version 与库内不符（他人已改/基于旧版编辑）→
   * VERSION_CONFLICT；通过则 version+1 落库（updateMany 支持 where 带
   * 非唯一字段 version，count=0 即冲突或已不归本人） */
  private async updateGraph(
    id: number,
    p: GraphUpdateParams,
    userId: number,
  ): Promise<GraphRecord> {
    await this.assertGraphOwned(id, userId);
    const graphJson = parseGraphJson(p.graphJson);
    const res = await prisma.graphDefinition.updateMany({
      where: { id, userId, version: p.version },
      data: {
        name: p.name,
        description: p.description ?? null,
        graphJson,
        version: { increment: 1 },
      },
    });
    if (res.count === 0) {
      throw new Error("VERSION_CONFLICT");
    }
    const row = await prisma.graphDefinition.findUniqueOrThrow({
      where: { id },
    });
    return toGraphRecord(row);
  }

  /** 删除引用检查：被本人 graph 任务 / 其他图 subflow·iterate 节点 /
   * 任务 eventJson（taskFinished→graph）引用 → GRAPH_IN_USE:清单（渲染端
   * 按码映射文案）；无引用则先清 webhook 注册再事务先删节点行/run 后删图
   * （应用层级联，SQLite 无外键，先例 automation delete）。归属前置必须
   * 有——automationRun 无 userId 列，否则他人图 id 会先删光其全部 run */
  private async deleteGraph(id: number, userId: number): Promise<void> {
    await this.assertGraphOwned(id, userId);
    const refs = await prisma.automationTask.findMany({
      where: { targetKind: "graph", graphId: id, userId },
      select: { name: true },
    });
    // eventJson 链式引用：JSON 列无法精确查询，取非空行内存解析匹配
    const eventRows = await prisma.automationTask.findMany({
      where: { userId, eventJson: { not: null } },
      select: { name: true, eventJson: true },
    });
    // 跨图引用（subflow/iterate 引用本图）：保存期不拦跨图合法性，
    // 删除期集中检查——悬空引用只在运行期 subflow_missing 暴露太晚
    const graphRows = await prisma.graphDefinition.findMany({
      where: { userId },
      select: { id: true, name: true, graphJson: true },
    });
    const names = [
      ...refs.map((row) => row.name),
      ...eventRows
        .filter((row) => this.refOfEventJson(row.eventJson, id))
        .map((row) => `${row.name}（事件触发）`),
      ...graphRows
        .filter(
          (row) => row.id !== id && this.refOfGraphJson(row.graphJson, id),
        )
        .map((row) => `${row.name}（子工作流）`),
    ];
    if (names.length > 0) {
      throw new Error(`GRAPH_IN_USE:${names.join(",")}`);
    }
    // webhook 注册先行清理（option 行 + 内存路由 + 在途运行中止），
    // 避免悬空 token 重启后复活
    const { unregisterWebhook } = await import("./webhook-server");
    await unregisterWebhook(id, userId);
    // graphRunNode 无 graphId 列（去会话化 2026-10-28，spec §3.1）：run 行
    // 删除前先取 run id 集合连带删节点行，避免孤儿行（SQLite 无外键）
    const runIds = (
      await prisma.automationRun.findMany({
        where: { graphId: id },
        select: { id: true },
      })
    ).map((row) => row.id);
    await prisma.$transaction([
      prisma.graphRunNode.deleteMany({ where: { runId: { in: runIds } } }),
      prisma.automationRun.deleteMany({ where: { graphId: id } }),
      prisma.graphDefinition.deleteMany({ where: { id, userId } }),
    ]);
  }

  private async toggleGraph(
    id: number,
    enabled: boolean,
    userId: number,
  ): Promise<GraphRecord> {
    await this.assertGraphOwned(id, userId);
    const row = await prisma.graphDefinition.update({
      where: { id },
      data: { enabled },
    });
    return toGraphRecord(row);
  }

  async listGraphRuns(
    graphId: number,
    page: number,
    userId: number,
  ): Promise<RunPage> {
    await this.assertGraphOwned(graphId, userId);
    const where = { graphId };
    const [total, rows] = await Promise.all([
      prisma.automationRun.count({ where }),
      prisma.automationRun.findMany({
        where,
        orderBy: { startedAt: "desc" },
        skip: (page - 1) * RUN_PAGE_SIZE,
        take: RUN_PAGE_SIZE,
      }),
    ]);
    const graph = await prisma.graphDefinition.findUnique({
      where: { id: graphId },
      select: { name: true },
    });
    return {
      total,
      items: rows.map((r) => toGraphRunRecord(r, graph?.name ?? "-")),
    };
  }

  /** 运行节点详情行（去会话化 2026-10-28，spec §4 三层下钻第三层；
   *  执行详情批起 server-face automation/runNodes 同源消费）：graphRunNode
   *  无用户列，归属两段校验——先查 run 的 graphId（prompt 型 run graphId
   *  null 直拒），再查图 userId（历史 graph 行 userId 可空，null 视为可查，
   *  对齐 executor 归属口径）；老 run 无节点行返回空集，前端回落预览 */
  async listRunNodes(
    runId: number,
    userId: number,
  ): Promise<GraphRunNodeRow[]> {
    const run = await prisma.automationRun.findFirst({
      where: { id: runId, graphId: { not: null } },
      select: { graphId: true },
    });
    if (!run?.graphId) {
      return [];
    }
    const graph = await prisma.graphDefinition.findUnique({
      where: { id: run.graphId },
      select: { userId: true },
    });
    if (!graph || (graph.userId !== null && graph.userId !== userId)) {
      return [];
    }
    return prisma.graphRunNode.findMany({
      where: { runId },
      orderBy: { id: "asc" },
    });
  }

  /** 试运行（spec §5 手动触发）：无任务上下文，workspace 行须自查归属
   * （任务运行经 assertTaskRefsOwned，此处试运行自行校验）；互斥
   * GRAPH_ALREADY_RUNNING；触发即返回，执行 fire-and-forget。draftJson
   * 为编辑器当前草稿（有则覆盖库内版本执行——试的是改后的图，运行
   * 记录仍归属原图；合法性由 executor parseGraphJson 兜底落库可见） */
  async runTest(
    id: number,
    inputs: Record<string, string>,
    workspaceId: number,
    userId: number,
    draftJson?: string,
  ): Promise<void> {
    const graph = await prisma.graphDefinition.findFirst({
      where: { id, userId },
    });
    if (!graph) {
      throw new Error(`graph ${id} not found`);
    }
    const workspace = await prisma.workspace.findFirst({
      where: { id: workspaceId, userId },
    });
    if (!workspace) {
      throw new Error("WORKSPACE_NOT_FOUND");
    }
    if (graphTestInflight.has(id)) {
      throw new Error("GRAPH_ALREADY_RUNNING");
    }
    const target =
      typeof draftJson === "string" && draftJson.trim() !== ""
        ? { ...graph, graphJson: draftJson }
        : graph;
    this.launchTestRun(target, inputs, workspace);
  }

  /** 互斥占位后发射（check→set 间无 await，防并发双跑）：executor 吞
   * 异常落库，catch 仅兜 create run 之前的意外；收尾清 inflight、推
   * graphs-changed、发布 taskFinished(targetType=graph) 事件——T10 留的
   * 图试运行发布点（事件触发的图链式任务由此续上）。run_workflow 工具
   * 异步触发共用此发射口（工具侧仅前置互斥，互斥 set 在此收口） */
  launchTestRun(
    graph: GraphRow,
    inputs: Record<string, string>,
    workspace: { id: number; directoryPath: string | null },
  ): void {
    const abort = new AbortController();
    graphTestInflight.set(graph.id, abort);
    void executeGraphRun({
      graph,
      task: null,
      inputs,
      triggerType: "manual",
      attempt: 1,
      abort: abort.signal,
      workspace: { id: workspace.id, directoryPath: workspace.directoryPath },
      disabledTools: this.disabledTools,
    })
      .catch((e): "failed" => {
        Log.error("图试运行失败", graph.id, e);
        return "failed";
      })
      .then((outcome) => {
        void publishAutomationEvent({
          source: "taskFinished",
          targetType: "graph",
          targetId: graph.id,
          outcome,
        });
      })
      .finally(() => {
        graphTestInflight.delete(graph.id);
        notifyGraphsChanged();
      });
  }

  /** 手工中断试运行：归属校验后 abort 在途控制器（reason=USER_CANCELLED
   *  供 executor 区分用户中断与 webhook 超时/调度退出类 abort）；run
   *  终态由执行收尾落 failed（error 归一见 executor user_aborted） */
  async cancelTestRun(id: number, userId: number): Promise<void> {
    const graph = await prisma.graphDefinition.findFirst({
      where: { id, userId },
    });
    if (!graph) {
      throw new Error("GRAPH_NOT_FOUND");
    }
    const abort = graphTestInflight.get(id);
    if (!abort) {
      throw new Error("GRAPH_NOT_RUNNING");
    }
    abort.abort(new Error("USER_CANCELLED"));
  }
}
