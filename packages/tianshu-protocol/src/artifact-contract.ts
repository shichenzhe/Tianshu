/**
 * @tianshu/protocol artifact-contract：移动端本地产物面板契约（AR 批
 * 2026-10-27）。artifact 表只在桌面端（write 结构化登记 +
 * artifactFavorite 收藏）——三端点为桌面被控面专属（同 A6 monitor/A5
 * library 先例，无头端不实现不报）；移动端以 artifact/list 首 404
 * 隐藏视图（端点缺失自隐藏，其他错误显可重试态）。
 * DTO 不携带本机路径（library 批纪律）：桌面 ArtifactListItem 的 path
 * （resolve 绝对路径）不进 wire——relPath 即标识（workspaceId+relPath
 * 为收藏键）。
 */

/** 本地产物列表行（桌面 ArtifactListItem 同形减 path） */
export interface ArtifactWireItem {
  /** write 原始相对路径（收藏键一半 + artifact/read 入参） */
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
  /** 收藏态（artifactFavorite 表，workspaceId+relPath 键） */
  favorite: boolean;
}

/** artifact/toggleFavorite 入参 */
export interface ArtifactToggleFavoritePayload {
  workspaceId: number;
  relPath: string;
}

/** artifact/read 入参 */
export interface ArtifactReadPayload {
  workspaceId: number;
  relPath: string;
}

/** artifact/read 结果：文本/图片判别联合——webview 类（html/pdf/音视频）
 * 被控端拒绝（ARTIFACT_PREVIEW_UNSUPPORTED，移动端提示桌面端预览，
 * A5 尾富媒体同款语义） */
export type ArtifactReadResult =
  | { kind: "text"; content: string }
  | { kind: "image"; mime: string; dataBase64: string };

/** artifact 面业务错误码（face bizError 信封，控制端判码） */
export const ARTIFACT_ERROR_CODES = {
  /** webview 类文件（html/pdf/音视频）不支持移动端预览 */
  PREVIEW_UNSUPPORTED: "ARTIFACT_PREVIEW_UNSUPPORTED",
  /** 文件不存在（含已删除——列表 stat 剔除后的竞态兜底） */
  NOT_FOUND: "ARTIFACT_NOT_FOUND",
} as const;
