/**
 * 备份/下载批契约（spec 2026-10-27）：桌面端全量数据备份上传/下载恢复
 * 六端点 DTO + 常量。server DTO 与桌面端请求体均自本包引用，防双端漂移。
 * 多用户扩展（spec 2026-10-28）：BackupMeta.owner 归属 + BackupListResult.viewer
 * 查看者身份 + claim/invites/clients 三组 DTO 与邀请码/错误码常量。
 */
/** 分块原始字节上限（4MB；base64 后 ~5.3MB < server bodyLimit 16MB） */
export const BACKUP_CHUNK_BYTES = 4 * 1024 * 1024;
/** 默认保留份数（server option 表 type="app" name="backupMaxKeep" 可配） */
export const DEFAULT_BACKUP_MAX_KEEP = 10;
/** 单备份大小上限（默认 2GB） */
export const DEFAULT_BACKUP_MAX_SIZE_BYTES = 2 * 1024 * 1024 * 1024;

/** 备份元数据（list 返回行 + 落盘 meta.json 同构） */
export interface BackupMeta {
  id: string;
  /** ISO 时间戳 */
  createdAt: string;
  appVersion: string;
  schemaVersion: number;
  fileSize: number;
  /** 整包 sha256（hex） */
  sha256: string;
  chunkCount: number;
  note?: string;
  deviceName?: string;
  /** uploading=分块未 commit；ready=定稿可下载 */
  status: "uploading" | "ready";
  /** 归属 client 标识；存量档读取期由 server 兜底 BACKUP_ADMIN_OWNER */
  owner: string;
}

export interface BackupCreateRequest {
  appVersion: string;
  schemaVersion: number;
  fileSize: number;
  sha256: string;
  chunkCount: number;
  note?: string;
  deviceName?: string;
}

export interface BackupChunkRequest {
  id: string;
  /** 0 起，须连续提交 */
  seq: number;
  /** 原始字节 base64（≤ BACKUP_CHUNK_BYTES） */
  data: string;
  chunkSha256: string;
}

export interface BackupDownloadRequest {
  id: string;
  seq: number;
}

export interface BackupDownloadResult {
  data: string;
  totalChunks: number;
}

export interface BackupCommitResult {
  fileSize: number;
  sha256: string;
}

/** 备份列表结果（admin 见全部档；client 仅见名下档，viewer 声明查看者身份） */
export interface BackupListResult {
  backups: BackupMeta[];
  viewer: BackupViewer;
}

export interface BackupDeleteResult {
  deleted: true;
}

/** 备份进度帧（face backup.progress 事件载荷；桌面渲染层 backup:progress
 *  同形扩展）：四相字节进度；done=true 为终态帧（error 携失败原因）——
 *  202 受理模式下移动端据此复位并重拉列表 */
export interface BackupProgressPayload {
  phase: "packing" | "uploading" | "downloading" | "restoring";
  current: number;
  total: number;
  /** 终态帧标记（成功/失败一帧收敛；非终态恒缺省） */
  done?: boolean;
  error?: string;
}

// —— 多用户扩展（spec 2026-10-28）：owner 归属 + 认领/邀请/设备管理 ——

/** 管理员占位 ownerId（存量档无 owner 字段读取期兜底） */
export const BACKUP_ADMIN_OWNER = "__admin__";

/** 邀请码前缀 */
export const BACKUP_INVITE_PREFIX = "TS-";
/** 邀请码字符集（去易混淆 0/O/1/I/L） */
export const BACKUP_INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
/** 邀请码长度（不含前缀） */
export const BACKUP_INVITE_LENGTH = 8;

/** 错误码：设备名已被占用 */
export const BACKUP_CLIENT_NAME_TAKEN = "BACKUP_CLIENT_NAME_TAKEN";
/** 错误码：邀请码无效或已被使用 */
export const BACKUP_INVITE_INVALID = "BACKUP_INVITE_INVALID";
/** 错误码：仅管理员可操作 */
export const BACKUP_ADMIN_ONLY = "BACKUP_ADMIN_ONLY";

/** 列表查看者身份（admin 见全部档；client 仅见名下档，携带 clientId） */
export interface BackupViewer {
  kind: "client" | "admin";
  clientId?: string;
}

/** 邀请码认领请求（client 以邀请码换设备身份） */
export interface BackupClaimRequest {
  inviteCode: string;
  deviceName: string;
}

/** 邀请码认领结果（clientToken 为该设备后续调用凭据） */
export interface BackupClaimResult {
  clientId: string;
  clientToken: string;
}

/** 邀请码记录 */
export interface BackupInviteRecord {
  code: string;
  note?: string;
  /** ISO 时间戳 */
  createdAt: string;
  /** 兑换时间（已用才有） */
  usedAt?: string;
  /** 兑换设备名 */
  usedBy?: string;
}

export interface BackupCreateInvitesRequest {
  count?: number;
  note?: string;
}

export interface BackupCreateInvitesResult {
  invites: BackupInviteRecord[];
}

/** 已认领设备（client）记录 */
export interface BackupClientRecord {
  clientId: string;
  /** ISO 时间戳 */
  createdAt: string;
  /** 认领所用邀请码备注 */
  invitedNote?: string;
}
