// 自 mirror electron/domains/ai/orchestration/graph.repo.ts 摘取（GA-T3）。
// 改造点：
// 1. prisma → server 自有 PrismaService（NestJS DI 注入，@Injectable）
// 2. run 行写入/状态更新原语（createRun/finishRun）自 mirror
//    orchestration/graph-executor.ts 的 createRunRow/finishRun 落库段摘取
//    （server 消费面 spec §4.1 graph/run + run 表状态机）；finishRun 仅保留
//    run 行落库——monitor 埋点（recordGraphMonitorEvents）与任务推进
//    （advanceTaskAfterRun）属 executor/runner 编排，T4/T5 接线
// 3. Electron IPC 层（handleUser/ipcMain）与 BrowserWindow 推送移除——
//    CRUD 方法改 public 供 service/controller 消费
// 4. deleteGraph 的 webhook 注册清理注入化：unregisterWebhook 闭包参数默认
//    no-op（mirror 为动态 import webhook-server——Electron 侧模块，server
//    无头端 webhook 由 T7 controller/service 实现，届时注入真实清理）
// 5. validateGraph 改自 @tianshu/core 引（GA-T2 收编，mirror 侧同源）
// 6. RunRecord/RunPage 自 automation.repository 引（mirror 先例：graph 侧
//    经 automation.api 引 run 类型；类型为该文件的 type-only 副本）
// 7. 新增 findById（§4.1 图详情消费；server SessionRepository.findById 先例，
//    mirror 侧该查询内联于 assertGraphOwned）
// 8. GraphRow 行类型以 @prisma/client 生成模型名替代 mirror 的推导
// 摘取边界（server 消费面 spec §4.1）：graph CRUD + run 行写入；试运行触发
// 链（runTest/launchTestRun/cancelTestRun——executor/graph-inflight T4 接线）、
// 导入导出与 binary 固化（dialog 文件 IO）、testNode/polishPrompt、模板
// 列表、webhook 端点、create-workflow 工具注册（spec §3.4 明确排除）未摘。
// 其余逻辑逐段保持 mirror 原样。
import { Injectable, Logger, Optional } from '@nestjs/common';
import { AutomationRun, GraphDefinition } from '@prisma/client';
import { validateGraph } from '@tianshu/core';
import { PrismaService } from 'src/commons/database/prisma.service';
import {
  toRunRecord,
  type RunPage,
  type RunRecord,
} from 'src/modules/automation/automation.repository';

/** DB 行类型（mirror GraphRow/RunRow 同位） */
type GraphRow = GraphDefinition;
type RunRow = AutomationRun;

/** 图运行历史分页大小（对齐 mirror listRuns 的 PAGE_SIZE=20） */
const RUN_PAGE_SIZE = 20;

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
  return toRunRecord(row, graphName);
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
 * 规范化落库） */
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
    // 码列表（mirror 渲染端按 chat:orchestration.validation.<code> 本地化；
    // 前端保存前已内联校验，此为后端兜底）。GraphIssue 经 @tianshu/protocol
    // （file: 依赖）的类型引用在 eslint projectService 下不可解析——
    // tsc 正常，先例 response.interceptor 定点 disable
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    throw new Error(validated.issues.map((issue) => issue.code).join('; '));
  }
  return JSON.stringify(validated.value);
}

/** run 行写入原语入参（mirror createRunRow 消费字段的具名收口） */
export interface CreateRunParams {
  taskId: number | null;
  graphId: number;
  attempt: number;
  triggerType: string;
}

/** run 收尾入参（mirror finishRun 落库字段的具名收口——trace 序列化/
 * token 汇总/错误归一在 executor 侧完成后传终值；sessionId 列保留但
 * graph 路径不再写——去会话化 2026-10-28） */
export interface FinishRunParams {
  runId: number;
  status: 'success' | 'failed';
  graphTrace: string;
  error: string | null;
  durationMs: number;
  promptTokens?: number | null;
  completionTokens?: number | null;
}

/**
 * 编排图仓储（relationMode=prisma 无外键，userId 归属过滤在查询条件维护）。
 * 保存期 validateGraph 阻断非法图；update 乐观锁（version 不符 →
 * VERSION_CONFLICT）；删除先查任务/子图/事件引用拒绝悬空。
 */
@Injectable()
export class GraphRepository {
  private readonly logger = new Logger(GraphRepository.name);

  /** webhook 注册清理钩子（默认 no-op；T7 webhook service 注入真实实现，
   *  先例 mirror disabledTools 闭包注入）。GA-T6：@Optional 标注缺省参——
   *  Nest DI 对带默认值的构造参数仍尝试解析（Function token 无 provider） */
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    private readonly unregisterWebhook: (
      graphId: number,
      userId: number,
    ) => Promise<void> = async () => {},
  ) {}

  /** 校验图归当前用户（不存在与他人所有同报错，不泄露存在性） */
  private async assertGraphOwned(id: number, userId: number): Promise<void> {
    const row = await this.prisma.graphDefinition.findFirst({
      where: { id, userId },
    });
    if (!row) {
      throw new Error('GRAPH_NOT_FOUND');
    }
  }

  async listGraphs(userId: number): Promise<GraphRecord[]> {
    const rows = await this.prisma.graphDefinition.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toGraphRecord);
  }

  /** 按归属查图（GA-T3 新增，改造点 7） */
  async findById(id: number, userId: number): Promise<GraphRecord | null> {
    const row = await this.prisma.graphDefinition.findFirst({
      where: { id, userId },
    });
    return row ? toGraphRecord(row) : null;
  }

  /** 创建图（mirror private 经 IPC 暴露，server 改 public 供 service） */
  async createGraph(
    p: GraphCreateParams,
    userId: number,
  ): Promise<GraphRecord> {
    const graphJson = parseGraphJson(p.graphJson);
    const row = await this.prisma.graphDefinition.create({
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
            typeof node === 'object' &&
            ((node as { kind?: unknown }).kind === 'subflow' ||
              (node as { kind?: unknown }).kind === 'iterate') &&
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
        parsed.source === 'taskFinished' &&
        parsed.targetType === 'graph' &&
        parsed.targetId === graphId
      );
    } catch {
      return false;
    }
  }

  /** 乐观锁：前端携带的 version 与库内不符（他人已改/基于旧版编辑）→
   * VERSION_CONFLICT；通过则 version+1 落库（updateMany 支持 where 带
   * 非唯一字段 version，count=0 即冲突或已不归本人） */
  async updateGraph(
    id: number,
    p: GraphUpdateParams,
    userId: number,
  ): Promise<GraphRecord> {
    await this.assertGraphOwned(id, userId);
    const graphJson = parseGraphJson(p.graphJson);
    const res = await this.prisma.graphDefinition.updateMany({
      where: { id, userId, version: p.version },
      data: {
        name: p.name,
        description: p.description ?? null,
        graphJson,
        version: { increment: 1 },
      },
    });
    if (res.count === 0) {
      throw new Error('VERSION_CONFLICT');
    }
    const row = await this.prisma.graphDefinition.findUniqueOrThrow({
      where: { id },
    });
    return toGraphRecord(row);
  }

  /** 删除引用检查：被本人 graph 任务 / 其他图 subflow·iterate 节点 /
   * 任务 eventJson（taskFinished→graph）引用 → GRAPH_IN_USE:清单（渲染端
   * 按码映射文案）；无引用则先清 webhook 注册再事务先删节点行/run 后删图
   * （应用层级联，SQLite 无外键）。归属前置必须有——automationRun 无
   * userId 列，否则他人图 id 会先删光其全部 run */
  async deleteGraph(id: number, userId: number): Promise<void> {
    await this.assertGraphOwned(id, userId);
    const refs = await this.prisma.automationTask.findMany({
      where: { targetKind: 'graph', graphId: id, userId },
      select: { name: true },
    });
    // eventJson 链式引用：JSON 列无法精确查询，取非空行内存解析匹配
    const eventRows = await this.prisma.automationTask.findMany({
      where: { userId, eventJson: { not: null } },
      select: { name: true, eventJson: true },
    });
    // 跨图引用（subflow/iterate 引用本图）：保存期不拦跨图合法性，
    // 删除期集中检查——悬空引用只在运行期 subflow_missing 暴露太晚
    const graphRows = await this.prisma.graphDefinition.findMany({
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
      throw new Error(`GRAPH_IN_USE:${names.join(',')}`);
    }
    // webhook 注册先行清理（改造点 4：注入钩子，避免悬空 token 重启后复活）
    await this.unregisterWebhook(id, userId);
    // graphRunNode 无 graphId 列（去会话化 2026-10-28，spec §3.1）：run 行
    // 删除前先取 run id 集合连带删节点行，避免孤儿行（SQLite 无外键）
    const runIds = (
      await this.prisma.automationRun.findMany({
        where: { graphId: id },
        select: { id: true },
      })
    ).map((row) => row.id);
    await this.prisma.$transaction([
      this.prisma.graphRunNode.deleteMany({ where: { runId: { in: runIds } } }),
      this.prisma.automationRun.deleteMany({ where: { graphId: id } }),
      this.prisma.graphDefinition.deleteMany({ where: { id, userId } }),
    ]);
  }

  /** 启停（mirror private 经 IPC 暴露，server 改 public 供 service） */
  async toggleGraph(
    id: number,
    enabled: boolean,
    userId: number,
  ): Promise<GraphRecord> {
    await this.assertGraphOwned(id, userId);
    const row = await this.prisma.graphDefinition.update({
      where: { id },
      data: { enabled },
    });
    return toGraphRecord(row);
  }

  /** 图运行历史分页（mirror runTest 收尾后渲染层刷新拉取的读路径） */
  async listGraphRuns(
    graphId: number,
    page: number,
    userId: number,
  ): Promise<RunPage> {
    await this.assertGraphOwned(graphId, userId);
    const where = { graphId };
    const [total, rows] = await Promise.all([
      this.prisma.automationRun.count({ where }),
      this.prisma.automationRun.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * RUN_PAGE_SIZE,
        take: RUN_PAGE_SIZE,
      }),
    ]);
    const graph = await this.prisma.graphDefinition.findUnique({
      where: { id: graphId },
      select: { name: true },
    });
    return {
      total,
      items: rows.map((r) => toGraphRunRecord(r, graph?.name ?? '-')),
    };
  }

  /** run 行写入原语（mirror graph-executor createRunRow 同款落库）：
   * 图/任务运行开始即落 running 行，返回 runId 供状态流与收尾定位 */
  async createRun(params: CreateRunParams): Promise<number> {
    const run = await this.prisma.automationRun.create({
      data: {
        taskId: params.taskId,
        graphId: params.graphId,
        attempt: params.attempt,
        triggerType: params.triggerType,
        status: 'running',
        startedAt: new Date(),
      },
    });
    return run.id;
  }

  /** run 收尾落库原语（mirror graph-executor finishRun 同款）：终态/
   * graphTrace/tokens/finishedAt 全量落库（sessionId 列保留但 graph 路径
   * 不再写——去会话化 2026-10-28）。run 行可能已被删除
   * （在途删图先删 run）——收尾落库失败仅记日志，不向调用方抛（P2025
   * 类预期冲突；外层兜底会把二次 finishRun 抛错误判为新失败） */
  async finishRun(p: FinishRunParams): Promise<void> {
    try {
      await this.prisma.automationRun.update({
        where: { id: p.runId },
        data: {
          status: p.status,
          graphTrace: p.graphTrace,
          error: p.error,
          durationMs: p.durationMs,
          promptTokens: p.promptTokens,
          completionTokens: p.completionTokens,
          finishedAt: new Date(),
        },
      });
    } catch (e) {
      this.logger.warn(
        `图运行收尾落库失败（run 行可能已删除）runId=${p.runId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
