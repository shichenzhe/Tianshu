// 备份面批 wire（桌面被控面专属三端点；无头端不报 capability backup——
// 连无头端不进备份页）。create 为 202 受理（进度/终态经 backup.progress
// 事件流，store 订阅驱动状态机）。
import {
  ENDPOINTS,
  type BackupMeta,
  type BackupViewer,
} from "@tianshu/protocol";

import { wireRequest } from "./wire";
import type { ApiResult } from "./graph-api";

export type { BackupMeta } from "@tianshu/protocol";

/** 列表载荷：行集 + viewer 身份（旧桌面面缺省 viewer 字段时置 null 不渲染徽标） */
export interface BackupListData {
  backups: BackupMeta[];
  viewer: BackupViewer | null;
}

export async function backupList(): Promise<ApiResult<BackupListData>> {
  const r = await wireRequest("POST", ENDPOINTS.backup.list, {});
  if (!r.ok) return r;
  const data = r.data as { backups?: unknown; viewer?: unknown };
  return {
    ok: true,
    data: {
      backups: Array.isArray(data.backups)
        ? (data.backups as BackupMeta[])
        : [],
      viewer:
        data.viewer && (data.viewer as BackupViewer).kind
          ? (data.viewer as BackupViewer)
          : null,
    },
  };
}

/** 202 受理（成功回 {accepted:true}；后台执行结果走事件流） */
export async function backupCreate(
  note: string | undefined,
): Promise<ApiResult<{ accepted: true }>> {
  const r = await wireRequest("POST", ENDPOINTS.backup.create, {
    ...(note ? { note } : {}),
  });
  return r.ok ? { ok: true, data: { accepted: true } } : r;
}

export async function backupDelete(
  backupId: string,
): Promise<ApiResult<{ deleted: true }>> {
  const r = await wireRequest("POST", ENDPOINTS.backup.delete, {
    id: backupId,
  });
  return r.ok ? { ok: true, data: { deleted: true } } : r;
}
