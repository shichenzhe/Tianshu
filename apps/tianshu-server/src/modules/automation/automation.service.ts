/**
 * 自动化任务服务（GA-T6 薄层：CRUD 转 GA-T3 仓储；runNow 接 GA-T5 执行链）。
 * 变更面（create/update/delete 与 runNow 收尾）经 EventBus 发
 * automation.changed 任务级刷新信号（协议包 AutomationChangedPayload——
 * taskId 必带，nextRunAt 仅保存路径携带提示值，消费端以重拉列表为准）。
 * userId 伴生写死 1（COMPANION_USER_ID）。
 */
import { Injectable } from '@nestjs/common';
import type {
  AutomationRunNodeRecord,
  AutomationRunPage,
} from '@tianshu/protocol';
import { QueryResult } from 'src/commons/query/query-result';
import { COMPANION_USER_ID } from 'src/commons/config/tianshu-config.entity';
import { EventBusService } from 'src/commons/event-bus/event-bus.service';
import { PrismaService } from 'src/commons/database/prisma.service';
import { AutomationRepository, type TaskRecord } from './automation.repository';
import { recordAutomationEvent } from './automation-stat';
import type { AutomationQueryDto } from './dto/automation-query.dto';
import type { AutomationSaveDto } from './dto/automation-save.dto';
import type { AutomationRunQueryDto } from './dto/automation-run-query.dto';

@Injectable()
export class AutomationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: AutomationRepository,
    private readonly bus: EventBusService,
  ) {}

  /** 任务列表（QueryFilter 分页 + keyword 任务名内存过滤） */
  async query(dto: AutomationQueryDto): Promise<QueryResult<TaskRecord>> {
    const all = await this.repository.listTasks(COMPANION_USER_ID);
    const keyword = dto.keyword?.trim();
    const filtered = keyword
      ? all.filter((task) => task.name.includes(keyword))
      : all;
    const page = dto.page <= 0 ? 1 : dto.page;
    const pageSize = dto.pageSize;
    const records = filtered.slice((page - 1) * pageSize, page * pageSize);
    return QueryResult.of(records, page, pageSize, filtered.length);
  }

  /** 全量 upsert：带 id 更新，否则创建（创建埋点 stat + 发变更事件）。
   * GA-T9/Ruling 14：载荷显式携 enabled 时写入任务开关（控制端启停走
   * save 全量、无 toggle 端点——Ruling 12）；缺省不碰开关（repo
   * buildTaskData「编辑不重置用户开关」默认路径原样）。写入复用 repo
   * toggleTask 启停原语（重新启用含恢复语义：status 回 active +
   * 清 statusNote），与当前值一致时跳过冗余写 */
  async save(dto: AutomationSaveDto): Promise<TaskRecord> {
    const { id, enabled, ...params } = dto;
    const creating = id == null;
    let record = creating
      ? await this.repository.createTask(params, COMPANION_USER_ID)
      : await this.repository.updateTask(id, params, COMPANION_USER_ID);
    if (typeof enabled === 'boolean' && record.enabled !== enabled) {
      record = await this.repository.toggleTask(
        record.id,
        enabled,
        COMPANION_USER_ID,
      );
    }
    if (creating) {
      // 创建埋点（T5 待收口 3；mirror 渲染层 automation:stat 通道的服务端
      // 等价，fire-and-forget 吞错）。tabSwitchCount 无头端无 UI 切页恒 0
      void recordAutomationEvent(this.prisma, 'create', {
        mode: params.schedule.mode,
        kind: params.targetKind ?? 'prompt',
        hasEndAt: params.endAt != null,
        tabSwitchCount: 0,
      });
    }
    this.bus.publish({
      type: 'automation.changed',
      payload: { taskId: record.id, nextRunAt: record.nextRunAt ?? null },
    });
    return record;
  }

  /** 批量删除（run 级联）；逐实删 id 发变更事件 */
  async delete(ids: number[]): Promise<void> {
    const deleted = await this.repository.deleteTasks(ids, COMPANION_USER_ID);
    for (const taskId of deleted) {
      this.bus.publish({ type: 'automation.changed', payload: { taskId } });
    }
  }

  /**
   * 手动触发（mirror 语义：triggerType=manual 不消耗调度字段；GA-T5
   * runNow——inflight 互斥 + fire，收尾 automation.changed 由 repo 发）。
   * 202 受理即返回。
   */
  async runNow(taskId: number): Promise<{ accepted: true }> {
    await this.repository.runNow(taskId, COMPANION_USER_ID);
    return { accepted: true };
  }

  /** 运行历史分页（移动端 CRUD+运行历史批）：repo listRuns 薄层 */
  async runPage(dto: AutomationRunQueryDto): Promise<AutomationRunPage> {
    return await this.repository.listRuns(
      dto.page,
      dto.taskId,
      dto.status,
      COMPANION_USER_ID,
    );
  }

  /** 运行节点详情（移动端执行详情批）：repo listRunNodes 薄层——图 run
   * 节点级执行详情（全文输入/输出/工具调用摘要），prompt run 恒空集 */
  async runNodes(runId: number): Promise<AutomationRunNodeRecord[]> {
    return await this.repository.listRunNodes(runId, COMPANION_USER_ID);
  }
}
