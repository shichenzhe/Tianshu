/**
 * 工作空间 API
 * HD-A2 主机路由化：list 本地 invoke 原通道参数逐字；远程走
 * workspaceList（形状转换见 data-source/remote-catalog——侧栏远端树）。
 * 写方法与文件系统面（目录/git）本地专属。
 */

import { invoke } from "@/lib/ipc";
import { routeInvoke } from "@/domains/ai/data-source/host-route";
import * as remote from "@/domains/ai/data-source/remote-catalog";

export interface WorkspaceRecord {
  id: number;
  name: string;
  icon?: string;
  directoryPath?: string;
  defaultModelId?: number;
  writeApprovedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceCreateParams {
  name: string;
  icon?: string;
  defaultModelId?: number;
  /** 「打开本地空间」一步建绑用；普通新建不传 */
  directoryPath?: string;
}

export interface WorkspaceUpdateParams {
  id: number;
  name?: string;
  icon?: string;
  defaultModelId?: number;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

export interface GitChangeFile {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
  staged: boolean;
}
export type GitWorkingChanges =
  | { kind: "not-git" }
  | { kind: "ok"; files: GitChangeFile[]; truncated: boolean };
export type GitFileDiffResult =
  { kind: "untracked" } | { kind: "diff"; text: string; truncated: boolean };

export class WorkspaceApi {
  static async list(): Promise<WorkspaceRecord[]> {
    return routeInvoke({ ch: "workspace:list", args: [] }, (connId) =>
      remote.remoteWorkspaceList(connId),
    );
  }

  static async create(params: WorkspaceCreateParams): Promise<WorkspaceRecord> {
    return invoke<WorkspaceRecord>("workspace:create", params);
  }

  static async update(params: WorkspaceUpdateParams): Promise<WorkspaceRecord> {
    return invoke<WorkspaceRecord>("workspace:update", params);
  }

  static async delete(id: number): Promise<void> {
    return invoke<void>("workspace:delete", id);
  }

  /** P1：弹系统目录选择框绑定工作空间目录；用户取消返回 null */
  static async bindDirectory(id: number): Promise<WorkspaceRecord | null> {
    return invoke<WorkspaceRecord | null>("workspace:bindDirectory", id);
  }

  /** P1：解绑工作空间目录（历史消息保留，仅收回 AI 的文件访问入口） */
  static async unbindDirectory(id: number): Promise<WorkspaceRecord | null> {
    return invoke<WorkspaceRecord | null>("workspace:unbindDirectory", id);
  }

  /** 新建任务页「打开本地空间」：目录选择 + 以目录名建空间并绑定；取消返回 null */
  static async openLocal(): Promise<WorkspaceRecord | null> {
    return invoke<WorkspaceRecord | null>("workspace:openLocal");
  }

  /** 打开空间绑定目录（任务上下文菜单「打开文件夹」） */
  static async openDirectory(workspaceId: number): Promise<void> {
    await invoke<void>("workspace:openDirectory", workspaceId);
  }

  /** DetailPanel 工作空间 tab：列目录（沙箱语义，主进程 workspace-dir.ts） */
  static async listDir(
    workspaceId: number,
    relPath: string,
  ): Promise<DirEntry[]> {
    return invoke<DirEntry[]>("workspace:listDir", workspaceId, relPath);
  }

  /** DetailPanel 查看变更 tab：工作树变更列表（主进程 git-changes.ts） */
  static gitStatus(workspaceId: number): Promise<GitWorkingChanges> {
    return invoke<GitWorkingChanges>("workspace:gitStatus", workspaceId);
  }

  static gitDiff(
    workspaceId: number,
    relPath: string,
  ): Promise<GitFileDiffResult> {
    return invoke<GitFileDiffResult>("workspace:gitDiff", workspaceId, relPath);
  }
}

export default WorkspaceApi;
