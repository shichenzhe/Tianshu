// src-react/domains/ai/orchestration/api/orchestration.api.ts
/**
 * 编排图 API（IPC 封装）。GRAPH_CHANGED_EVENT 为图变更事件通道单一
 * 事实源（后端 graph.repo 照 AUTOMATION_CHANGED_EVENT 先例 import 此处
 * 推送，useGraphs 据此失效查询）；RunRecord 复用 automation 域（图运行
 * 与任务运行同表同口径，taskId 可空/graphId/graphTrace 见该类型注释）。
 *
 * 主机路由化（orchestration 批 2026-11-10）：数据面通道（list/create/
 * update/remove/toggle/runs/runNodes/runTest/cancelTestRun/webhook 三件）
 * 远程态经 remote-catalog 适配器走无头端 graph/automation 端点——远程
 * 对话建图（workflow_write）落远端库，编排页远程态直读远端数据面。
 * 深水功能门控（远程态显式拒绝，防静默错位落本地库/本地文件系统）：
 * - 导入导出三通道 + pickBinaryFile：本地文件系统语义（远端导入导出
 *   =「文件在控制端、库在远端」跨端组合，待专项设计）
 * - polishPrompt/testNode：依赖本地 provider 配置与本地 executor 单跑
 *   （远端等价需 server 补端点，挂账）
 * templates 为静态预填清单（无数据面），本地清单远程态直接复用。
 */
import { invoke } from "@/lib/ipc";
import { routeInvoke } from "@/domains/ai/data-source/host-route";
import {
  remoteGraphCancelTestRun,
  remoteGraphDelete,
  remoteGraphList,
  remoteGraphRunNodes,
  remoteGraphRunTest,
  remoteGraphRuns,
  remoteGraphSave,
  remoteGraphToggle,
  remoteGraphWebhook,
} from "@/domains/ai/data-source/remote-catalog";
import type { RunRecord } from "@/domains/ai/automation/api/automation.api";
import { remoteConnId } from "@/domains/ai/data-source/host-route";

/** 远程态深水功能门控（统一文案出口——i18n 由 toast 层消费 Error message） */
function rejectOnRemote(feature: string): void {
  if (remoteConnId() != null) {
    throw new Error(`远程主机暂不支持${feature}（本功能仅本机可用）`);
  }
}

/** 前端编排图记录（nodeCount 由后端从 graphJson 派生，列表行直显） */
export interface GraphRecord {
  id: number;
  name: string;
  description?: string;
  graphJson: string;
  /** 乐观锁：编辑保存需携带，与库内不符 → VERSION_CONFLICT */
  version: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
  /** AI 编排会话绑定（1:1，null/undefined=未绑定） */
  aiSessionId?: number | null;
}

export interface GraphCreateParams {
  name: string;
  description?: string;
  graphJson: string;
}

export interface GraphUpdateParams extends GraphCreateParams {
  version: number;
}

/** 图运行历史分页（taskName 取图名，试运行 taskId 为 null） */
export interface GraphRunPage {
  total: number;
  items: RunRecord[];
}

/** graphRunNode 节点详情行（去会话化 2026-10-28；后端原样透传，时间字段
 * 为 ISO 字符串；老 run 无行——前端回落 trace 预览） */
export interface GraphRunNodeRow {
  id: number;
  runId: number;
  nodeId: string;
  nodeName: string | null;
  status: string;
  /** 渲染后完整输入（截 64KB） */
  input: string | null;
  /** 完整输出（截 64KB；failed 行为失败全貌文本） */
  output: string | null;
  errorJson: string | null;
  toolCallsJson: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number;
  startedAt: string;
  outputImage: string | null;
  errorOutput: string | null;
  fallbackJson: string | null;
}

/** 内置图模板（后端 graph-templates）：graphJson 为对象非序列（编辑器
 * 预填后 JSON.stringify 提交 create/update），文案只放 i18n key */
export interface GraphTemplate {
  slug: string;
  icon: string;
  titleI18nKey: string;
  descI18nKey: string;
  graphJson: object;
}

/** 删除被引用错误前缀：后端拼 `GRAPH_IN_USE:任务名,任务名`，前端解析
 * 出引用清单展示（提示先解除任务引用再删） */
export const GRAPH_IN_USE_ERROR = "GRAPH_IN_USE:";

export class GraphApi {
  static async list(): Promise<GraphRecord[]> {
    return routeInvoke({ ch: "orchestration:list", args: [] }, (connId) =>
      remoteGraphList(connId),
    );
  }

  static async create(params: GraphCreateParams): Promise<GraphRecord> {
    return routeInvoke(
      { ch: "orchestration:create", args: [params] },
      (connId) => remoteGraphSave(params, connId),
    );
  }

  static async update(
    id: number,
    params: GraphUpdateParams,
  ): Promise<GraphRecord> {
    return routeInvoke(
      { ch: "orchestration:update", args: [id, params] },
      (connId) =>
        remoteGraphSave({ ...params, id, version: params.version }, connId),
    );
  }

  static async remove(id: number): Promise<void> {
    return routeInvoke({ ch: "orchestration:delete", args: [id] }, (connId) =>
      remoteGraphDelete(id, connId),
    );
  }

  static async toggle(id: number, enabled: boolean): Promise<GraphRecord> {
    return routeInvoke(
      { ch: "orchestration:toggle", args: [id, enabled] },
      (connId) => remoteGraphToggle(id, enabled, connId),
    );
  }

  /** AI 编排会话绑定回写（1:1；null=解绑）——本地编辑器能力，远程态门控 */
  static async bindAiSession(
    id: number,
    aiSessionId: number | null,
  ): Promise<GraphRecord> {
    rejectOnRemote("AI 编排会话绑定");
    return invoke<GraphRecord>("orchestration:bindAiSession", id, aiSessionId);
  }

  static async templates(): Promise<GraphTemplate[]> {
    return invoke<GraphTemplate[]>("orchestration:templates");
  }

  /** 导出工作流（主进程另存对话框）：取消返回 null，成功返回落盘路径——
   *  本地文件系统语义，远程态门控（跨端导入导出待专项） */
  static async exportWorkflow(payload: {
    name: string;
    description?: string;
    graphJson: string;
  }): Promise<string | null> {
    rejectOnRemote("导出工作流");
    return invoke<string | null>("orchestration:exportWorkflow", payload);
  }

  /** 导入工作流（主进程文件选择 + 前置校验）：取消返回 null；
   *  kind=single 预填编辑器、kind=bundle 已批量建库（返回汇总）——
   *  本地文件系统+本地库语义，远程态门控（跨端导入导出待专项） */
  static async importWorkflow(): Promise<
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
    rejectOnRemote("导入工作流");
    return invoke<
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
    >("orchestration:importWorkflow");
  }

  /** 批量导出：选中图聚合 bundle 落盘（主进程 save dialog）；取消返回 null
   *  ——本地文件系统语义，远程态门控 */
  static async exportWorkflows(
    ids: number[],
  ): Promise<{ path: string; count: number } | null> {
    rejectOnRemote("批量导出");
    return invoke<{ path: string; count: number } | null>(
      "orchestration:exportWorkflows",
      ids,
    );
  }

  /** 图试运行（触发即返回，结果经 graphs-changed 事件刷新）。draftJson
   * 为编辑器当前草稿——本地有则试改后的图；远程态先保存草稿再跑（适配
   * 层收敛语义差异）。workspaceId 为所选空间（远程态=远端空间 id） */
  static async runTest(
    id: number,
    inputs: Record<string, unknown>,
    workspaceId: number,
    draftJson?: string,
  ): Promise<void> {
    return routeInvoke(
      {
        ch: "orchestration:runTest",
        args: [id, inputs, workspaceId, draftJson],
      },
      (connId) =>
        remoteGraphRunTest(id, inputs, workspaceId, draftJson, connId),
    );
  }

  static async runs(
    graphId: number,
    page: number,
    topLevelOnly?: boolean,
  ): Promise<GraphRunPage> {
    return routeInvoke(
      {
        ch: "orchestration:runs",
        args: topLevelOnly ? [graphId, page, true] : [graphId, page],
      },
      (connId) => remoteGraphRuns(graphId, page, connId, topLevelOnly),
    );
  }

  /** 运行节点详情行（去会话化 2026-10-28）：按 runId 拉节点级完整输入/输出 */
  static async runNodes(runId: number): Promise<GraphRunNodeRow[]> {
    return routeInvoke(
      { ch: "orchestration:runNodes", args: [runId] },
      (connId) => remoteGraphRunNodes(runId, connId),
    );
  }

  /** 手工中断试运行（无在途抛 GRAPH_NOT_RUNNING；收尾推 graphs-changed 自动刷新） */
  static async cancelTestRun(graphId: number): Promise<void> {
    return routeInvoke(
      { ch: "orchestration:cancelTestRun", args: [graphId] },
      (connId) => remoteGraphCancelTestRun(graphId, connId),
    );
  }

  /** 提示词 AI 润色（用当前节点所选模型改写，{{}} 占位符保留）——
   *  依赖本地模型配置与本地执行，远程态门控 */
  static async polishPrompt(modelId: number, prompt: string): Promise<string> {
    rejectOnRemote("提示词 AI 润色");
    return invoke<string>("orchestration:polishPrompt", modelId, prompt);
  }

  /** HTTP binary 请求体文件选择（系统对话框，取消返回 null）——本地
   *  文件选择语义，远程态门控 */
  static async pickBinaryFile(): Promise<string | null> {
    rejectOnRemote("本地文件选择");
    return invoke<string | null>("orchestration:pickBinaryFile");
  }

  /** 入站 webhook：开启（可携响应配置，返回 URL）/ 关闭 / 查询——远程态
   *  走远端 webhook 管理面（url 适配层拼连接基址） */
  static async webhookEnable(
    graphId: number,
    config?: {
      responseTemplate?: string;
      statusCode?: number;
      async?: boolean;
      fullAccess?: boolean;
    },
  ): Promise<string> {
    const status = await routeInvoke(
      { ch: "orchestration:webhookEnable", args: [graphId, config] },
      (connId) => remoteGraphWebhook("enable", graphId, connId, config),
    );
    return status.url;
  }
  static async webhookDisable(graphId: number): Promise<void> {
    await routeInvoke(
      { ch: "orchestration:webhookDisable", args: [graphId] },
      (connId) => remoteGraphWebhook("disable", graphId, connId),
    );
  }
  static async webhookStatus(graphId: number): Promise<{
    enabled: boolean;
    url: string;
    responseTemplate?: string;
    statusCode?: number;
    async?: boolean;
    fullAccess?: boolean;
  }> {
    return routeInvoke(
      { ch: "orchestration:webhookStatus", args: [graphId] },
      (connId) => remoteGraphWebhook("status", graphId, connId),
    );
  }

  /** 单节点测试：轻量单跑该节点 handler，返回输出或错误（不落 run）——
   *  依赖本地 executor，远程态门控 */
  static async testNode(
    node: object,
    inputs: Record<string, string>,
    nodes: Record<string, { output: string }>,
    workspaceId: number,
  ): Promise<
    { ok: true; output: string } | { ok: false; code: string; message: string }
  > {
    rejectOnRemote("单节点测试");
    return invoke("orchestration:testNode", node, inputs, nodes, workspaceId);
  }
}

/** 图变更事件通道（图试运行收尾后主进程推送） */
export const GRAPH_CHANGED_EVENT = "orchestration:graphs-changed";

/** 节点状态实时事件通道（执行期逐节点 running/success/failed，
 * payload { graphId, nodeId, status }——试运行画布高亮消费） */
export const NODE_STATUS_EVENT = "orchestration:node-status";
