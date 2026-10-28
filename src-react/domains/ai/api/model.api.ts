/**
 * 模型 API
 * listAll/test 主机路由化（HD-T3）：本地 invoke 原通道；远程走
 * providerBundle/providerTest（形状转换见 data-source/remote-catalog）。
 */

import { invoke } from "@/lib/ipc";
import { routeInvoke } from "@/domains/ai/data-source/host-route";
import * as remote from "@/domains/ai/data-source/remote-catalog";

export interface ModelRecord {
  id: number;
  providerId: number;
  modelId: string;
  name?: string;
  enabled: boolean;
  /** 模型类型（单一事实源：主进程 connectivity 同源引用） */
  type: ModelType;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  contextWindow?: number;
  createdAt: string;
  updatedAt: string;
}

/** 模型类型：llm 走 chat 补全；其余为专项端点模型（测试/消费方按类型分派） */
export type ModelType = "llm" | "embedding" | "tts" | "reranker" | "asr";

export const MODEL_TYPES: ModelType[] = [
  "llm",
  "embedding",
  "tts",
  "reranker",
  "asr",
];

export interface ModelCreateParams {
  providerId: number;
  modelId: string;
  name?: string;
  type?: ModelType;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  contextWindow?: number;
}

export interface ModelUpdateParams {
  id: number;
  modelId?: string;
  /** 可空字段：null 表示清空（undefined = 不修改） */
  name?: string | null;
  enabled?: boolean;
  type?: ModelType;
  temperature?: number | null;
  topP?: number | null;
  maxTokens?: number | null;
  contextWindow?: number | null;
}

export interface TestConnectionResult {
  success: boolean;
  errorCode?: string;
  message: string;
}

export interface OllamaRemoteModel {
  modelId: string;
}

/** 远端模型（拉取模型列表结果项，type 定义单一事实源：主进程 import type） */
export interface RemoteModel {
  modelId: string;
  ownedBy?: string;
}

/** 拉取模型列表结构化结果（与 TestConnectionResult 同模式：连通失败是预期结果） */
export interface ListRemoteResult {
  success: boolean;
  errorCode?: string;
  message: string;
  models: RemoteModel[];
}

/**
 * 模型显示名：name 非空白优先（trim 后回显），否则回退 modelId。
 * name 库内可空（dev 实测常恒 null），消费面严禁裸用 name —— 统一
 * 经此函数（回归 2026-10-23：MemoryGroup 误写 `name?.trim() !== ""`
 * 判定，null 时 children 为 null 渲染空白下拉项）
 */
export function modelDisplayName(
  model: Pick<ModelRecord, "name" | "modelId">,
): string {
  return model.name?.trim() || model.modelId;
}

export class ModelApi {
  static async listByProvider(providerId: number): Promise<ModelRecord[]> {
    return invoke<ModelRecord[]>("model:listByProvider", providerId);
  }

  static async listAll(): Promise<ModelRecord[]> {
    return routeInvoke({ ch: "model:listAll", args: [] }, (connId) =>
      remote.remoteModelList(connId),
    );
  }

  static async create(params: ModelCreateParams): Promise<ModelRecord> {
    return routeInvoke({ ch: "model:create", args: [params] }, (connId) =>
      remote.remoteModelCreate(params, connId),
    );
  }

  static async update(params: ModelUpdateParams): Promise<ModelRecord> {
    return routeInvoke({ ch: "model:update", args: [params] }, (connId) =>
      remote.remoteModelUpdate(params, connId),
    );
  }

  static async delete(id: number): Promise<void> {
    return routeInvoke({ ch: "model:delete", args: [id] }, (connId) =>
      remote.remoteModelDelete(id, connId),
    );
  }

  static async test(id: number): Promise<TestConnectionResult> {
    return routeInvoke({ ch: "model:test", args: [id] }, (connId) =>
      remote.remoteModelTest(id, connId),
    );
  }

  static async listOllama(providerId: number): Promise<OllamaRemoteModel[]> {
    return invoke<OllamaRemoteModel[]>("model:listOllama", providerId);
  }

  static async listRemote(providerId: number): Promise<ListRemoteResult> {
    return routeInvoke(
      { ch: "model:listRemote", args: [providerId] },
      (connId) => remote.remoteModelListRemote(providerId, connId),
    );
  }
}

export default ModelApi;
