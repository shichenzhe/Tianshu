// 移动端 CRUD 批 automation face 桥：桌面本地 AutomationRepository /
// GraphRepository 单源消费，载荷与返回同无头端 AutomationController 五端
// 点 + graph/query 只读（选图面）同构——save 全量 upsert（enabled 显式
// 携带才写，无头端 Ruling 12/14）、runPage 剔 graphTrace、query 分页壳
// （starter QueryResult 同形）。变更通知经 automation-change-bus 扇出
// （face-events 桥 → automation.changed 远程控制端）。tap 接 repo Pick，
// 内存替身可直测（providers-tap 先例）。
import type { TaskCreateParams } from "../../../src-react/domains/ai/automation/api/automation.api";
import type {
  AutomationRunPage,
  AutomationRunRecord,
  GraphRecord,
  TaskRecord,
} from "@tianshu/protocol";
import { emitAutomationChanged } from "../ai/automation/automation-change-bus";
import type {
  ServerFaceAutomation,
  ServerFaceGraphsReadonly,
  ServerFacePage,
} from "./deps";

/** 无头端 QueryResult 切片壳（page 非法归 1——无头端 service.query 同款） */
function pageOf<T>(
  all: T[],
  page: number,
  pageSize: number,
  filter: (row: T) => boolean,
): ServerFacePage<T> {
  const filtered = all.filter(filter);
  const p = page <= 0 ? 1 : page;
  return {
    page: p,
    pageSize,
    records: filtered.slice((p - 1) * pageSize, p * pageSize),
    total: filtered.length,
  };
}

/** name includes 关键词（大小写敏感——无头端 automation/graph query 同款） */
function nameMatches<T extends { name: string }>(
  keyword: string | undefined,
): (row: T) => boolean {
  const kw = keyword?.trim();
  return kw ? (row: T) => row.name.includes(kw) : () => true;
}

/** 桌面 RunRecord（含 graphTrace 全量面）→ wire AutomationRunRecord
 *  （剔 graphTrace——协议包精简面） */
function toRunWire(page: {
  total: number;
  items: Array<{ graphTrace?: string } & Omit<AutomationRunRecord, never>>;
}): AutomationRunPage {
  return {
    total: page.total,
    items: page.items.map(({ graphTrace: _graphTrace, ...rest }) => rest),
  };
}

/** 结构子集（AutomationRepository 实例天然满足；独立声明避免 tap 依赖
 *  repo 类的构造副作用——类构造注册 IPC/工具，测试替身不引） */
interface AutomationRepositoryLike {
  listTasks(userId: number): Promise<TaskRecord[]>;
  createTask(p: TaskCreateParams, userId: number): Promise<TaskRecord>;
  updateTask(
    id: number,
    p: TaskCreateParams,
    userId: number,
  ): Promise<TaskRecord>;
  deleteTasks(ids: number[], userId: number): Promise<number[]>;
  toggleTask(id: number, enabled: boolean, userId: number): Promise<TaskRecord>;
  runNow(id: number, userId: number): Promise<void>;
  listRuns(
    page: number,
    taskId: number | undefined,
    status: AutomationRunRecord["status"] | undefined,
    userId: number,
  ): Promise<{
    total: number;
    items: Array<
      { graphTrace?: string } & Omit<AutomationRunRecord, never> & {
          taskName: string;
        }
    >;
  }>;
}

export function createAutomationFace(deps: {
  automationRepo: AutomationRepositoryLike;
}): ServerFaceAutomation {
  const repo = deps.automationRepo;
  return {
    query: (page, pageSize, keyword, userId) =>
      repo
        .listTasks(userId)
        .then((all) => pageOf(all, page, pageSize, nameMatches(keyword))),
    save: async (payload, userId) => {
      const { id, enabled, ...params } = payload;
      let record =
        id == null
          ? await repo.createTask(params as TaskCreateParams, userId)
          : await repo.updateTask(id, params as TaskCreateParams, userId);
      if (typeof enabled === "boolean" && record.enabled !== enabled) {
        record = await repo.toggleTask(record.id, enabled, userId);
      }
      emitAutomationChanged(record.id);
      return record;
    },
    delete: async (ids, userId) => {
      const deleted = await repo.deleteTasks(ids, userId);
      for (const taskId of deleted) emitAutomationChanged(taskId);
    },
    // 202 受理：触发即返回；收尾通知走 repo runNow finally → change-bus
    // （对齐无头端「收尾经 automation.changed」，受理即不发）
    runNow: (id, userId) => repo.runNow(id, userId),
    runPage: (page, taskId, status, userId) =>
      repo
        .listRuns(page, taskId, status, userId)
        .then((result) => toRunWire(result)),
  };
}

/** graph 只读面（选图）：桌面 listGraphs 全量 → 分页壳；编辑遥控
 *  （save/delete/run/runAbort）不透出——无头端专属 */
export function createGraphsFace(deps: {
  graphRepo: { listGraphs(userId: number): Promise<GraphRecord[]> };
}): ServerFaceGraphsReadonly {
  return {
    query: (page, pageSize, keyword, userId) =>
      deps.graphRepo
        .listGraphs(userId)
        .then((all) => pageOf(all, page, pageSize, nameMatches(keyword))),
  };
}
