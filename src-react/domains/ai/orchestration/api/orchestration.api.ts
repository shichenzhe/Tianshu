// src-react/domains/ai/orchestration/api/orchestration.api.ts
/**
 * 编排图 API（IPC 封装）。GRAPH_CHANGED_EVENT 为图变更事件通道单一
 * 事实源（后端 graph.repo 照 AUTOMATION_CHANGED_EVENT 先例 import 此处
 * 推送，useGraphs 据此失效查询）；RunRecord 复用 automation 域（图运行
 * 与任务运行同表同口径，taskId 可空/graphId/graphTrace 见该类型注释）。
 */
import { invoke } from "@/lib/ipc";
import type { RunRecord } from "@/domains/ai/automation/api/automation.api";

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
    return invoke<GraphRecord[]>("orchestration:list");
  }

  static async create(params: GraphCreateParams): Promise<GraphRecord> {
    return invoke<GraphRecord>("orchestration:create", params);
  }

  static async update(
    id: number,
    params: GraphUpdateParams,
  ): Promise<GraphRecord> {
    return invoke<GraphRecord>("orchestration:update", id, params);
  }

  static async remove(id: number): Promise<void> {
    return invoke<void>("orchestration:delete", id);
  }

  static async toggle(id: number, enabled: boolean): Promise<GraphRecord> {
    return invoke<GraphRecord>("orchestration:toggle", id, enabled);
  }

  static async templates(): Promise<GraphTemplate[]> {
    return invoke<GraphTemplate[]>("orchestration:templates");
  }

  /** 导出工作流（主进程另存对话框）：取消返回 null，成功返回落盘路径 */
  static async exportWorkflow(payload: {
    name: string;
    description?: string;
    graphJson: string;
  }): Promise<string | null> {
    return invoke<string | null>("orchestration:exportWorkflow", payload);
  }

  /** 导入工作流（主进程文件选择 + 前置校验）：取消返回 null；
   *  kind=single 预填编辑器、kind=bundle 已批量建库（返回汇总） */
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

  /** 批量导出：选中图聚合 bundle 落盘（主进程 save dialog）；取消返回 null */
  static async exportWorkflows(
    ids: number[],
  ): Promise<{ path: string; count: number } | null> {
    return invoke<{ path: string; count: number } | null>(
      "orchestration:exportWorkflows",
      ids,
    );
  }

  /** 图试运行（触发即返回，结果经 graphs-changed 事件刷新）。draftJson
   * 为编辑器当前草稿——有则试改后的图而非库内版本 */
  static async runTest(
    id: number,
    inputs: Record<string, string>,
    workspaceId: number,
    draftJson?: string,
  ): Promise<void> {
    return invoke<void>(
      "orchestration:runTest",
      id,
      inputs,
      workspaceId,
      draftJson,
    );
  }

  static async runs(graphId: number, page: number): Promise<GraphRunPage> {
    return invoke<GraphRunPage>("orchestration:runs", graphId, page);
  }

  /** 运行节点详情行（去会话化 2026-10-28）：按 runId 拉节点级完整输入/输出 */
  static async runNodes(runId: number): Promise<GraphRunNodeRow[]> {
    return invoke<GraphRunNodeRow[]>("orchestration:runNodes", runId);
  }

  /** 手工中断试运行（无在途抛 GRAPH_NOT_RUNNING；收尾推 graphs-changed 自动刷新） */
  static async cancelTestRun(graphId: number): Promise<void> {
    return invoke<void>("orchestration:cancelTestRun", graphId);
  }

  /** 提示词 AI 润色（用当前节点所选模型改写，{{}} 占位符保留） */
  static async polishPrompt(modelId: number, prompt: string): Promise<string> {
    return invoke<string>("orchestration:polishPrompt", modelId, prompt);
  }

  /** HTTP binary 请求体文件选择（系统对话框，取消返回 null） */
  static async pickBinaryFile(): Promise<string | null> {
    return invoke<string | null>("orchestration:pickBinaryFile");
  }

  /** 入站 webhook：开启（可携响应配置，返回 URL）/ 关闭 / 查询 */
  static async webhookEnable(
    graphId: number,
    config?: {
      responseTemplate?: string;
      statusCode?: number;
      async?: boolean;
      fullAccess?: boolean;
    },
  ): Promise<string> {
    return invoke<string>("orchestration:webhookEnable", graphId, config);
  }
  static async webhookDisable(graphId: number): Promise<void> {
    return invoke<void>("orchestration:webhookDisable", graphId);
  }
  static async webhookStatus(graphId: number): Promise<{
    enabled: boolean;
    url: string;
    responseTemplate?: string;
    statusCode?: number;
    async?: boolean;
    fullAccess?: boolean;
  }> {
    return invoke<{
      enabled: boolean;
      url: string;
      responseTemplate?: string;
      statusCode?: number;
      async?: boolean;
      fullAccess?: boolean;
    }>("orchestration:webhookStatus", graphId);
  }

  /** 单节点测试：轻量单跑该节点 handler，返回输出或错误（不落 run） */
  static async testNode(
    node: object,
    inputs: Record<string, string>,
    nodes: Record<string, { output: string }>,
    workspaceId: number,
  ): Promise<
    { ok: true; output: string } | { ok: false; code: string; message: string }
  > {
    return invoke("orchestration:testNode", node, inputs, nodes, workspaceId);
  }
}

/** 图变更事件通道（图试运行收尾后主进程推送） */
export const GRAPH_CHANGED_EVENT = "orchestration:graphs-changed";

/** 节点状态实时事件通道（执行期逐节点 running/success/failed，
 * payload { graphId, nodeId, status }——试运行画布高亮消费） */
export const NODE_STATUS_EVENT = "orchestration:node-status";
