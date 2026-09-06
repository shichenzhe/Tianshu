/**
 * 产物面板文件 API（前端；WorkspaceFileContent 为主进程同构副本，
 * 渲染进程不 import 主进程代码）
 */

import { invoke } from "@/lib/ipc";

export interface WorkspaceFileContent {
  kind: "text" | "image";
  content?: string;
  dataUrl?: string;
  size: number;
}

export class ArtifactApi {
  /** 读工作空间文件（预览）；不存在/二进制/超限由主进程抛中文文案 */
  static async readFile(
    workspaceId: number,
    relPath: string,
  ): Promise<WorkspaceFileContent> {
    return invoke<WorkspaceFileContent>(
      "workspace:readFile",
      workspaceId,
      relPath,
    );
  }

  /** 在 Finder 中定位文件 */
  static async revealFile(workspaceId: number, relPath: string): Promise<void> {
    await invoke<void>("workspace:revealFile", workspaceId, relPath);
  }

  /** 另存为副本（"下载"）；用户取消返回 null */
  static async exportFile(
    workspaceId: number,
    relPath: string,
  ): Promise<string | null> {
    return invoke<string | null>("workspace:exportFile", workspaceId, relPath);
  }
}

export default ArtifactApi;
