/**
 * 助手预设 API
 * list 主机路由化（HD-T3）：本地 invoke 原通道；远程走 assistantList
 * （形状转换见 data-source/remote-catalog）。写方法仍本地 IPC。
 */

import { invoke } from "@/lib/ipc";
import { routeInvoke } from "@/domains/ai/data-source/host-route";
import * as remote from "@/domains/ai/data-source/remote-catalog";
import type { TeamMember } from "../../../../electron/domains/ai/chat/expert-team";

export interface AssistantRecord {
  id: number;
  name: string;
  icon?: string;
  systemPrompt: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  builtin: boolean;
  description?: string;
  tags?: string[];
  sourceSlug?: string;
  profession?: string;
  quickPrompts?: string[];
  categoryId?: string;
  skillNames?: string[];
  expertType?: "agent" | "team";
  members?: TeamMember[];
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
  description?: string;
  tags?: string[];
  sourceSlug?: string;
  profession?: string;
  quickPrompts?: string[];
  categoryId?: string;
  skillNames?: string[];
  expertType?: "agent" | "team";
  members?: TeamMember[];
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
  description?: string | null;
  tags?: string[] | null;
  profession?: string | null;
  quickPrompts?: string[] | null;
  categoryId?: string | null;
  skillNames?: string[] | null;
  /** 市场来源 slug：undefined 不动列；null 清空；值即设置（被控面
   *  save 透传，桌面表单不传保持原样） */
  sourceSlug?: string | null;
  expertType?: "agent" | "team" | null;
  members?: TeamMember[] | null;
}

export class AssistantApi {
  static async list(): Promise<AssistantRecord[]> {
    return routeInvoke({ ch: "assistant:list", args: [] }, (connId) =>
      remote.remoteAssistantList(connId),
    );
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

  /** 导出专家为 JSON 文件（主进程另存对话框；用户取消返回 null 静默） */
  static async exportToFile(id: number): Promise<string | null> {
    return invoke<string | null>("assistant:export", id);
  }

  /** 从 JSON 文件导入专家（主进程打开对话框；取消返回 null 静默） */
  static async importFromFile(): Promise<{ name: string } | null> {
    return invoke<{ name: string } | null>("assistant:import");
  }
}

export default AssistantApi;
