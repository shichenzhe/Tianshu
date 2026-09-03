/**
 * 助手预设 API
 */

import { invoke } from "@/lib/ipc";

export interface AssistantRecord {
  id: number;
  name: string;
  icon?: string;
  systemPrompt: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantCreateParams {
  name: string;
  systemPrompt: string;
  icon?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

export interface AssistantUpdateParams {
  id: number;
  name?: string;
  systemPrompt?: string;
  /** 可空字段：null 表示清空（undefined = 不修改） */
  icon?: string | null;
  temperature?: number | null;
  topP?: number | null;
  maxTokens?: number | null;
}

export class AssistantApi {
  static async list(): Promise<AssistantRecord[]> {
    return invoke<AssistantRecord[]>("assistant:list");
  }

  static async create(params: AssistantCreateParams): Promise<AssistantRecord> {
    return invoke<AssistantRecord>("assistant:create", params);
  }

  static async update(params: AssistantUpdateParams): Promise<AssistantRecord> {
    return invoke<AssistantRecord>("assistant:update", params);
  }

  static async delete(id: number): Promise<void> {
    return invoke<void>("assistant:delete", id);
  }
}

export default AssistantApi;
