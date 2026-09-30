/**
 * 产物面板文件 API（前端；WorkspaceFileContent 为主进程同构副本，
 * 渲染进程不 import 主进程代码）
 */

import { invoke } from "@/lib/ipc";

export interface WorkspaceFileContent {
  kind: "text" | "image" | "webview";
  content?: string;
  dataUrl?: string;
  /** webview 类（html/pdf/音视频）：绝对路径（前端拼编码 file:// URL） */
  absPath?: string;
  size: number;
}

/** 本地产物列表条目（跨会话 write_file 记录聚合；类型被 session.repo 反向 import） */
export interface ArtifactListItem {
  /** resolve 后绝对路径 */
  path: string;
  /** write_file 原始 path（readFile/revealFile 消费） */
  relPath: string;
  name: string;
  /** 扩展名分类（classifyFileType 口径，与资料库一致） */
  fileType: string;
  workspaceId: number;
  workspaceName: string;
  sessionId: number;
  sessionTitle: string;
  /** 源消息写入时间（ISO） */
  writtenAt: string;
  size: number;
  /** 收藏态（artifactFavorite 独立表，workspaceId+relPath 键） */
  favorite: boolean;
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

  /** 本地产物列表（资料库「本地产物」视图）：已删除文件不返回 */
  static async listArtifacts(): Promise<ArtifactListItem[]> {
    return invoke<ArtifactListItem[]>("workspace:listArtifacts");
  }

  /** 收藏/取消收藏本地产物；返回操作后的收藏态 */
  static async toggleArtifactFavorite(
    workspaceId: number,
    relPath: string,
  ): Promise<boolean> {
    return invoke<boolean>(
      "workspace:toggleArtifactFavorite",
      workspaceId,
      relPath,
    );
  }
}

export default ArtifactApi;
