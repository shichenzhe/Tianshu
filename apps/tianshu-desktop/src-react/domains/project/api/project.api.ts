/**
 * 项目 API
 * IPC 通道由主进程 ProjectRepository 提供（electron/domains/project/project.repo.ts）
 */

import { invoke } from "@/lib/ipc";
import type {
  ProjectBindingInput,
  ProjectCreateParams,
  ProjectDetail,
  ProjectMemberItem,
  ProjectRecord,
  ProjectUpdateParams,
} from "../../../../electron/domains/project/project.entity";
import type { ProjectMemoryEntry } from "../../../../electron/domains/project/project-memory";

export default abstract class ProjectApi {
  /** 当前用户的项目列表（ownerId 由主进程从 token 解出） */
  static async list(): Promise<ProjectRecord[]> {
    return invoke<ProjectRecord[]>("project:list");
  }

  /** 项目详情：项目记录 + 能力挂载 + 动态流会话 */
  static async getDetail(id: number): Promise<ProjectDetail> {
    return invoke<ProjectDetail>("project:getDetail", id);
  }

  /** 创建项目（含初始指令/模版/挂载/动态流欢迎消息） */
  static async create(params: ProjectCreateParams): Promise<ProjectRecord> {
    return invoke<ProjectRecord>("project:create", params);
  }

  /** 更新项目（改名/改指令） */
  static async update(params: ProjectUpdateParams): Promise<void> {
    return invoke<void>("project:update", params);
  }

  /** 删除项目（级联删除成员/挂载/动态流会话） */
  static async remove(id: number): Promise<void> {
    return invoke<void>("project:delete", id);
  }

  /** 全量覆盖项目能力挂载 */
  static async setBindings(
    projectId: number,
    items: ProjectBindingInput[],
  ): Promise<void> {
    return invoke<void>("project:setBindings", projectId, items);
  }

  /** 项目成员列表（处理人选择器） */
  static async listMembers(projectId: number): Promise<ProjectMemberItem[]> {
    return invoke<ProjectMemberItem[]>("project:listMembers", projectId);
  }

  /** 项目记忆回写（批8 P0：交接摘要 + 产出物索引 → 资产空间 memory.md，
   *  getPromptContext 读回注入项目会话；失败由调用方静默处理） */
  static async appendMemory(
    projectId: number,
    entry: ProjectMemoryEntry,
  ): Promise<void> {
    return invoke<void>("project:appendMemory", projectId, entry);
  }
}

/** 项目变更事件通道（2026-11-01 批③：主进程 repo 写面创建/更新/删除后
 *  推送——渲染层 React Query ["projects"] 前缀失效；automation 同款先例） */
export const PROJECT_CHANGED_EVENT = "project:changed";
