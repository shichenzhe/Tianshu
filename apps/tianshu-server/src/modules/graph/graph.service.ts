import { Injectable, Logger } from '@nestjs/common';
import { QueryResult } from 'src/commons/query/query-result';
import { COMPANION_USER_ID } from 'src/commons/config/tianshu-config.entity';
import { PrismaService } from 'src/commons/database/prisma.service';
import { executeGraphRun } from 'src/core/graph/graph-executor';
import { graphTestInflight } from 'src/core/graph/graph-inflight';
import { GraphRepository, type GraphRecord } from './graph.repository';
import type { GraphQueryDto } from './dto/graph-query.dto';
import type { GraphSaveDto } from './dto/graph-save.dto';
import type { GraphRunDto } from './dto/graph-run.dto';

/**
 * 编排图服务（userId 伴生写死 1，见 COMPANION_USER_ID 头注释）。
 * CRUD 薄转 GA-T3 仓储；run/runAbort 为 mirror graph.repo runTest/
 * cancelTestRun 的无头等价（GA-T4 executor 链 + graphTestInflight 互斥），
 * run 202 受理即返回 {runId}——执行流经 graph.run.updated 事件回传。
 */
@Injectable()
export class GraphService {
  private readonly logger = new Logger(GraphService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: GraphRepository,
  ) {}

  /** 图列表（QueryFilter 分页 + keyword 名称内存过滤，session/query 同款） */
  async query(dto: GraphQueryDto): Promise<QueryResult<GraphRecord>> {
    const all = await this.repository.listGraphs(COMPANION_USER_ID);
    const keyword = dto.keyword?.trim();
    const filtered = keyword
      ? all.filter((graph) => graph.name.includes(keyword))
      : all;
    const page = dto.page <= 0 ? 1 : dto.page;
    const pageSize = dto.pageSize;
    const records = filtered.slice((page - 1) * pageSize, page * pageSize);
    return QueryResult.of(records, page, pageSize, filtered.length);
  }

  /** 全量 upsert：带 id 更新（version 乐观锁），否则创建 */
  async save(dto: GraphSaveDto): Promise<GraphRecord> {
    if (dto.id != null) {
      if (dto.version == null) {
        // version 缺席会使 updateMany 乐观锁条件退化为无条件——显式拦截
        throw new Error('VERSION_REQUIRED');
      }
      return await this.repository.updateGraph(
        dto.id,
        {
          name: dto.name,
          description: dto.description,
          graphJson: dto.graphJson,
          version: dto.version,
        },
        COMPANION_USER_ID,
      );
    }
    return await this.repository.createGraph(
      {
        name: dto.name,
        description: dto.description,
        graphJson: dto.graphJson,
      },
      COMPANION_USER_ID,
    );
  }

  async delete(id: number): Promise<void> {
    await this.repository.deleteGraph(id, COMPANION_USER_ID);
  }

  /**
   * 试运行（mirror runTest 语义：无任务上下文、互斥 GRAPH_ALREADY_RUNNING、
   * fire-and-forget）。202 受理即返回 {runId}：executor createRun 后即回调
   * onRunId（运行首 await 前），控制端以此关联 graph.run.updated 事件流；
   * createRun 前的意外失败（库不可用等）经同一 promise 拒绝回传。
   */
  async run(dto: GraphRunDto): Promise<{ runId: number }> {
    const graph = await this.prisma.graphDefinition.findFirst({
      where: { id: dto.graphId, userId: COMPANION_USER_ID },
    });
    if (!graph) {
      throw new Error('GRAPH_NOT_FOUND');
    }
    const workspace = await this.resolveWorkspace(dto.workspaceId);
    if (graphTestInflight.has(graph.id)) {
      throw new Error('GRAPH_ALREADY_RUNNING');
    }
    const abort = new AbortController();
    graphTestInflight.set(graph.id, abort);
    let resolveRunId!: (runId: number) => void;
    let rejectRunId!: (reason: unknown) => void;
    const runIdPromise = new Promise<number>((resolve, reject) => {
      resolveRunId = resolve;
      rejectRunId = reject;
    });
    const launched = executeGraphRun({
      graph,
      task: null,
      inputs: dto.inputs ?? {},
      triggerType: 'manual',
      attempt: 1,
      abort: abort.signal,
      workspace: { id: workspace.id, directoryPath: workspace.directoryPath },
      onRunId: resolveRunId,
    });
    // GA-T6 审查修：单链收口（mirror launchTestRun 同款形态）——catch 落
    // 终点后 finally 恒清 inflight，链上派生 promise 恒有 handler（launched
    // 仅在 createRun 前失败时拒绝，运行期异常 executor 内部已吞掉落库）；
    // 分叉三链会让无 handler 的分支在拒绝时触发 unhandledRejection——
    // Node 15+ 默认进程崩溃，无人值守端把一次 DB 抖动放大为整机重启
    void launched
      .catch((e): 'failed' => {
        // 桥拒绝回传（await runIdPromise → HTTP 统一包装回给控制端）
        rejectRunId(e);
        this.logger.error(`图试运行失败 ${graph.id} ${String(e)}`);
        return 'failed';
      })
      .finally(() => {
        graphTestInflight.delete(graph.id);
      });
    return { runId: await runIdPromise };
  }

  /**
   * 中止试运行（mirror cancelTestRun 语义；入参按 spec §4.1 为 runId——
   * run 行反查 graphId 归属后经 inflight 注册表 abort，reason=
   * USER_CANCELLED 供 executor 归一 user_aborted/aborted 投影）
   */
  async abortRun(runId: number): Promise<{ aborted: boolean }> {
    const run = await this.prisma.automationRun.findUnique({
      where: { id: runId },
    });
    if (!run?.graphId) {
      throw new Error('GRAPH_NOT_FOUND');
    }
    const graph = await this.prisma.graphDefinition.findFirst({
      where: { id: run.graphId, userId: COMPANION_USER_ID },
    });
    if (!graph) {
      throw new Error('GRAPH_NOT_FOUND');
    }
    const abort = graphTestInflight.get(graph.id);
    if (!abort) {
      throw new Error('GRAPH_NOT_RUNNING');
    }
    abort.abort(new Error('USER_CANCELLED'));
    return { aborted: true };
  }

  /** 工作空间解析：缺省挂用户最近一个空间（id desc，session create 同
   *  口径）；显式传入校验归属——图节点文件操作的沙箱基目录 */
  private async resolveWorkspace(workspaceId?: number): Promise<{
    id: number;
    directoryPath: string | null;
  }> {
    const workspace =
      workspaceId == null
        ? await this.prisma.workspace.findFirst({
            where: { userId: COMPANION_USER_ID },
            orderBy: { id: 'desc' },
          })
        : await this.prisma.workspace.findFirst({
            where: { id: workspaceId, userId: COMPANION_USER_ID },
          });
    if (!workspace) {
      throw new Error('WORKSPACE_NOT_FOUND');
    }
    return workspace;
  }
}
