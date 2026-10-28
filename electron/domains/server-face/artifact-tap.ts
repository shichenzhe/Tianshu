/**
 * 桌面被控面本地产物实现（AR 批，spec 2026-10-27）：artifact/list|
 * toggleFavorite|read 的 face 侧真身——list/toggle 复用 SessionRepository
 * 既有方法（artifact-aggregate 聚合与收藏表同源）；read 复用
 * readWorkspaceFileById（fullAccess 语义——write_file 记录的任意路径，
 * 与桌面 workspace:readFile 同链路），text/image 转协议联合、webview 类
 * （html/pdf/音视频）拒 ARTIFACT_PREVIEW_UNSUPPORTED（移动端提示桌面端
 * 预览，A5 尾富媒体同款语义）。
 * DTO 不泄本机路径（library 批纪律）：list 行剔桌面 ArtifactListItem 的
 * path（resolve 绝对路径）——relPath 即标识（收藏键一半）。
 */
import {
  ARTIFACT_ERROR_CODES,
  type ArtifactReadResult,
  type ArtifactWireItem,
} from "@tianshu/protocol";
import type { ServerFaceArtifact } from "./deps";

/** artifact 面业务错（code 稳定——routes 侧转 bizError 信封） */
export class FaceArtifactError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** 主进程 WorkspaceFileContent 最小投影（跨层 type-only 同构，不 import src-react） */
interface WorkspaceFileContentLike {
  kind: "text" | "image" | "webview";
  content?: string;
  dataUrl?: string;
}

/** dataUrl（data:image/png;base64,xxx）→ 协议 image 联合段 */
function parseDataUrl(dataUrl: string): { mime: string; dataBase64: string } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) {
    throw new FaceArtifactError(
      ARTIFACT_ERROR_CODES.NOT_FOUND,
      "产物内容不可用",
    );
  }
  return { mime: match[1], dataBase64: match[2] };
}

export function createArtifactFace(
  sessions: ServerFaceArtifact,
): ServerFaceArtifactWire {
  return {
    async list(userId): Promise<ArtifactWireItem[]> {
      const rows = await sessions.listArtifacts(userId);
      // 剔 path（绝对路径不透出）；favorite 已在 repo 聚合内
      return rows.map(({ path: _path, ...rest }) => rest);
    },

    async toggleFavorite(userId, workspaceId, relPath): Promise<boolean> {
      return await sessions.toggleArtifactFavorite(
        userId,
        workspaceId,
        relPath,
      );
    },

    async read(userId, workspaceId, relPath): Promise<ArtifactReadResult> {
      const content = (await sessions.readWorkspaceFileById(
        workspaceId,
        relPath,
        userId,
      )) as WorkspaceFileContentLike;
      if (content.kind === "text") {
        return { kind: "text", content: content.content ?? "" };
      }
      if (content.kind === "image" && content.dataUrl) {
        return { kind: "image", ...parseDataUrl(content.dataUrl) };
      }
      throw new FaceArtifactError(
        ARTIFACT_ERROR_CODES.PREVIEW_UNSUPPORTED,
        "该文件类型请在桌面端预览",
      );
    },
  };
}

/** face 装配的 wire 面（deps.artifact 注入形态；方法签名 userId 首参） */
export interface ServerFaceArtifactWire {
  list(userId: number): Promise<ArtifactWireItem[]>;
  toggleFavorite(
    userId: number,
    workspaceId: number,
    relPath: string,
  ): Promise<boolean>;
  read(
    userId: number,
    workspaceId: number,
    relPath: string,
  ): Promise<ArtifactReadResult>;
}
