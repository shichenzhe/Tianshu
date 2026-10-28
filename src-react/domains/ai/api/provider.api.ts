/**
 * 服务商 API（类型同时供主进程 repo import type）
 * list 主机路由化（HD-T3）：本地 invoke 原通道；远程走 providerBundle
 * （形状转换见 data-source/remote-catalog）。写方法仍本地 IPC——远程
 * 保存走 providerSave 通道（Remote* 壳消费，P3 随壳退役收口）。
 */

import { invoke } from "@/lib/ipc";
import { routeInvoke } from "@/domains/ai/data-source/host-route";
import * as remote from "@/domains/ai/data-source/remote-catalog";
import type { TestConnectionResult } from "./model.api";

export const PROVIDER_TYPES = [
  "openai-compatible",
  "anthropic",
  "gemini",
  "ollama",
  "comfyui",
] as const;

export type ProviderType = (typeof PROVIDER_TYPES)[number];

export interface ProviderRecord {
  id: number;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey?: string;
  extraHeaders?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderCreateParams {
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey?: string;
  extraHeaders?: string;
  enabled?: boolean;
}

export interface ProviderUpdateParams {
  id: number;
  name?: string;
  type?: ProviderType;
  baseUrl?: string;
  /** 可空字段：null 表示清空（undefined = 不修改） */
  apiKey?: string | null;
  extraHeaders?: string | null;
  enabled?: boolean;
}

export class ProviderApi {
  static async list(): Promise<ProviderRecord[]> {
    return routeInvoke({ ch: "provider:list", args: [] }, (connId) =>
      remote.remoteProviderList(connId),
    );
  }

  static async getById(id: number): Promise<ProviderRecord | null> {
    return invoke<ProviderRecord | null>("provider:getById", id);
  }

  static async create(params: ProviderCreateParams): Promise<ProviderRecord> {
    return routeInvoke({ ch: "provider:create", args: [params] }, (connId) =>
      remote.remoteProviderCreate(params, connId),
    );
  }

  static async update(params: ProviderUpdateParams): Promise<ProviderRecord> {
    return routeInvoke({ ch: "provider:update", args: [params] }, (connId) =>
      remote.remoteProviderUpdate(params, connId),
    );
  }

  static async delete(id: number): Promise<void> {
    return routeInvoke({ ch: "provider:delete", args: [id] }, (connId) =>
      remote.remoteProviderDelete(id, connId),
    );
  }

  /** provider 级连通测试（comfyui：GET /system_stats）。本地 IPC——远程
   *  无头端 provider/test 仅轻探上游 /models（不支持 comfyui），不路由 */
  static async test(id: number): Promise<TestConnectionResult> {
    return invoke<TestConnectionResult>("provider:test", id);
  }
}

export default ProviderApi;
