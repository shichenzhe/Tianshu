// 备份面批 backup face 桥：桌面被控面专属三端点——遥控桌面备份客户端
// （打包上传它所配 direct 连接的无头端）。create 为 202 受理模式（打包+
// 上传分钟级不可长连）：受理即返，后台经 createBackupNow 执行，进度帧/
// 终态帧（done/error）经 backup.progress 事件流扇出（emit 双扇出在
// backup/ipc 的 face 版 emit 注入——桌面本地 IPC 不受影响）。connId 由
// 注入的 resolveConnection 解析（连接注册表首个 direct；无则业务错）。
import type { BackupProgressPayload } from "@tianshu/protocol";
import { publishFaceEvent } from "./face-events";
import type { ServerFaceBackup } from "./deps";
import type { BackupIpcDeps } from "../backup/ipc";
import {
  createBackupNow,
  deleteBackupById,
  listBackupsWithViewer,
} from "../backup/ipc";

/** create 后台执行互斥：占用中再受理直接业务错（face 面单飞语义） */
let createInflight = false;

export function createBackupFace(deps: {
  backupDeps: BackupIpcDeps;
  /** 移动端不带 connId——桌面解析默认直连（首个 direct；null=未配置） */
  resolveConnection(): Promise<string | null>;
}): ServerFaceBackup {
  const emit = (payload: BackupProgressPayload): void => {
    publishFaceEvent({ type: "backup.progress", payload });
  };
  return {
    list: async () => {
      const connId = await deps.resolveConnection();
      if (connId === null) throw new Error("未配置直连连接（备份不可用）");
      return listBackupsWithViewer(connId, deps.backupDeps);
    },
    // 202 受理：fire-and-forget；终态帧收敛（done:true + error?）——
    // 移动端据此复位并重拉列表
    create: async (note) => {
      if (createInflight) throw new Error("备份进行中，请稍候");
      const connId = await deps.resolveConnection();
      if (connId === null) throw new Error("未配置直连连接（备份不可用）");
      createInflight = true;
      void createBackupNow(connId, note, deps.backupDeps, emit)
        .then(() => {
          emit({ phase: "uploading", current: 0, total: 0, done: true });
        })
        .catch((e: unknown) => {
          emit({
            phase: "uploading",
            current: 0,
            total: 0,
            done: true,
            error: e instanceof Error ? e.message : String(e),
          });
        })
        .finally(() => {
          createInflight = false;
        });
      return { accepted: true };
    },
    delete: async (backupId) => {
      const connId = await deps.resolveConnection();
      if (connId === null) throw new Error("未配置直连连接（备份不可用）");
      await deleteBackupById(connId, backupId, deps.backupDeps);
    },
  };
}
