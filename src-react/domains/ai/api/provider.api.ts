/**
 * 服务商 API（类型同时供主进程 repo import type）
 */

import { invoke } from "@/lib/ipc";

export const PROVIDER_TYPES = [
  "openai-compatible",
  "anthropic",
  "gemini",
  "ollama",
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
  apiKey?: string;
  extraHeaders?: string;
  enabled?: boolean;
}

export class ProviderApi {
  static async list(): Promise<ProviderRecord[]> {
    return invoke<ProviderRecord[]>("provider:list");
  }

  static async getById(id: number): Promise<ProviderRecord | null> {
    return invoke<ProviderRecord | null>("provider:getById", id);
  }

  static async create(params: ProviderCreateParams): Promise<ProviderRecord> {
    return invoke<ProviderRecord>("provider:create", params);
  }

  static async update(params: ProviderUpdateParams): Promise<ProviderRecord> {
    return invoke<ProviderRecord>("provider:update", params);
  }

  static async delete(id: number): Promise<void> {
    return invoke<void>("provider:delete", id);
  }
}

export default ProviderApi;
