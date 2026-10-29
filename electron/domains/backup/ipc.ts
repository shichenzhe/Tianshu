/**
 * 备份域 IPC 面（spec 2026-10-27 §4 + 2026-10-28 多用户扩展）：四 invoke
 * 通道（list/create/restore/delete）+ backup:relaunch（恢复后用户手动重启
 * 的薄封装）+ backup:progress 事件（packing/uploading/downloading/restoring
 * 四相字节进度）+ claim 申领通道与 invites/clients 管理面五通道（admin
 * 判定在 server 端）+ 本地链路两通道（create:local/restore:local——无服
 * 务端导出与恢复，不碰连接注册表，选择器取消返回 null）。依赖工厂注入
 * （测试替身）；连接信息经注入的 getConnection 取 direct 连接的
 * baseUrl+token（backupToken 优先——备份身份独立凭据，缺省回落 token；
 * claim 例外恒走大门 token见 gatewayClientFor；管理面与数据面同链
 * backupToken 优先——二层部署 TIANSHU_BACKUP_TOKEN 下 admin 手填该值后面
 * 板可见即须可操作；relay 不开放——spec §1 裁定，本地链路无此约束）。
 * tempDir 一律取 tianshuRoot() 直下 mkdtemp（防 Linux /tmp tmpfs 跨卷
 * rename EXDEV——保护副本与 restoreArchive 的 staging 都依赖同卷
 * rename；本地导出经 copyFileSync 跨卷安全落任意目标盘）；恢复前先
 * sha256 对拍下载产物（spec §3.3 完整性闸门；本地档案无远端 meta，解包
 * 校验兜底）再断 Prisma 连接（Windows rename 打开句柄必败）。
 * backups-local 保护副本本批不做上限清理（后续批复用保留策略口径）。
 * 构造即注册全部 handler（Application 装配一次），face 侧严禁二次构造
 * （server/ipc 同款口径）。
 */
import { app, dialog, ipcMain, type BrowserWindow } from "electron";
import os from "node:os";
import path from "node:path";
import { copyFile } from "node:fs/promises";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import prisma from "../../commons/prisma-client";
import { tianshuRoot } from "../../commons/paths";
import type { BackupListResult, BackupMeta } from "@tianshu/protocol";
import { publishFaceEvent } from "../server-face/face-events";
import { BackupClient } from "./backup-client";
import { verifyTarGzIntegrity } from "./ustar-tar";
import {
  createBackupArchive,
  hashFile,
  type BackupArchiveResult,
} from "./snapshot";
import { createLocalSafetyCopy, restoreArchive } from "./restore";

/** progress 事件载荷——收编协议包 BackupProgressPayload（face 面
 *  backup.progress 事件同形，渲染层 IPC 通道名不变） */
export type BackupProgressPayload =
  import("@tianshu/protocol").BackupProgressPayload;

/** getConnection 返回的连接最小面（ConnectionConfig 结构子集） */
export interface BackupConnectionInfo {
  mode: string;
  baseUrl?: string;
  token?: string;
  /** 备份专用 token（申领所得 clientToken；缺省回落 token=单用户） */
  backupToken?: string;
}

export interface BackupIpcDeps {
  /** 按 id 取连接配置（Application 装配自 server 域连接注册表） */
  getConnection(
    connId: string,
  ):
    | BackupConnectionInfo
    | undefined
    | Promise<BackupConnectionInfo | undefined>;
  /** 申领写回：只 patch backupToken 不动其余字段（Application 装配自
   *  server 域连接保存 API；未装配时 backup:claim 写回步报「未装配」） */
  saveConnection?(
    connId: string,
    patch: { backupToken: string },
  ): Promise<void>;
  /** progress 事件广播目标窗口集合 */
  windows(): BrowserWindow[];
  makeClient?(baseUrl: string, token?: string): BackupClient;
  archive?(opts: {
    tempDir: string;
    appVersion: string;
  }): Promise<BackupArchiveResult>;
  safety?(tempDir: string): Promise<string>;
  restore?(archivePath: string): Promise<void>;
  /** 应用版本（meta.appVersion 数据源；默认 app.getVersion()） */
  appVersion?(): string;
  /** 恢复前断库（默认 prisma.$disconnect；注入化便于测试与顺序断言） */
  disconnectDatabase?(): Promise<void> | void;
  /** 本地导出保存路径选择（默认 showSaveDialog 系统覆盖确认；取消 null） */
  pickSavePath?(): Promise<string | null>;
  /** 本地恢复档案选择（默认 showOpenDialog；取消 null） */
  pickArchivePath?(): Promise<string | null>;
}

export type BackupEmit = (payload: BackupProgressPayload) => void;

/** 取连接并校验 direct（relay 不开放）；返回该连接的 BackupClient
 *  （备份面批收拢：IPC 与 face tap 同源） */
export async function backupClientFor(
  connId: string,
  deps: BackupIpcDeps,
): Promise<BackupClient> {
  const conn = await directConnFor(connId, deps);
  const makeClient =
    deps.makeClient ??
    ((baseUrl, token) => new BackupClient({ baseUrl, token }));
  // 备份身份独立凭据（多用户批）：backupToken 优先，缺省回落 token
  const token = conn.backupToken ?? conn.token;
  return makeClient(conn.baseUrl, token);
}

/** 取连接并校验 direct（备份面批收拢；gatewayClientFor 共用）——返回
 *  baseUrl 收窄为必填（direct 校验已保证） */
async function directConnFor(
  connId: string,
  deps: BackupIpcDeps,
): Promise<BackupConnectionInfo & { baseUrl: string }> {
  const conn = await deps.getConnection(connId);
  if (!conn) throw new Error(`连接不存在：${connId}`);
  if (conn.mode !== "direct" || !conn.baseUrl) {
    throw new Error("备份仅支持直连连接（relay 未开放）");
  }
  // 展开收窄 baseUrl（守卫后必填；直接 return conn 不携带属性收窄）
  return { ...conn, baseUrl: conn.baseUrl };
}

/** 大门身份客户端（多用户批）：凭据恒取 conn.token（远控大门 token）——
 * claim 申领专用（此刻无客户端身份，勿走 backupToken 优先链——已申领
 * 连接会拿 clientToken 被拒）；invites/clients 管理面已移回
 * backupClientFor 同链（backupToken ?? token——二层部署 admin 手填
 * TIANSHU_BACKUP_TOKEN 到 backupToken 后面板可见且可操作，管理调用
 * 若仍走 conn.token 会被 BackupGuard 401）。gatewayToken 同值显式注入
 * （单客户端混用时 claim 的 authorization 兜底语义与数据面 token 解耦）。 */
async function gatewayClientFor(
  connId: string,
  deps: BackupIpcDeps,
): Promise<BackupClient> {
  const conn = await directConnFor(connId, deps);
  const makeClient =
    deps.makeClient ??
    ((baseUrl, token) =>
      new BackupClient({ baseUrl, token, gatewayToken: token }));
  return makeClient(conn.baseUrl, conn.token);
}

/** 列表含 viewer（多用户批）：IPC backup:list 通道数据源（UI admin 面板
 *  显隐判定）；face 面 backup/list 维持 BackupMeta[]（移动端契约不变，
 *  经 listBackups 分流） */
export async function listBackupsWithViewer(
  connId: string,
  deps: BackupIpcDeps,
): Promise<BackupListResult> {
  return (await backupClientFor(connId, deps)).listWithViewer();
}

/** 列表（face backup/list 与 IPC backup:list 同源） */
export async function listBackups(
  connId: string,
  deps: BackupIpcDeps,
): Promise<BackupMeta[]> {
  return (await backupClientFor(connId, deps)).list();
}

/** 删除（face backup/delete 与 IPC 同源） */
export async function deleteBackupById(
  connId: string,
  backupId: string,
  deps: BackupIpcDeps,
): Promise<void> {
  await (await backupClientFor(connId, deps)).remove(backupId);
}

/** 打包+上传完整链（face backup/create 后台执行体；进度经注入 emit 扇出）
 */
export async function createBackupNow(
  connId: string,
  note: string | undefined,
  deps: BackupIpcDeps,
  emit: BackupEmit,
): Promise<import("@tianshu/protocol").BackupCommitResult> {
  const client = await backupClientFor(connId, deps);
  const tempDir = mkdtempSync(path.join(tianshuRoot(), ".backup-create-"));
  try {
    emit({ phase: "packing", current: 0, total: 0 });
    const archiveFn = deps.archive ?? createBackupArchive;
    const archive = await archiveFn({
      tempDir,
      appVersion: (deps.appVersion ?? app.getVersion)(),
    });
    emit({ phase: "uploading", current: 0, total: archive.meta.fileSize });
    const uploadMeta = {
      ...archive.meta,
      deviceName: os.hostname(),
      ...(note ? { note } : {}),
    };
    return await client.uploadArchive(
      archive.archivePath,
      uploadMeta,
      (current: number, total: number) =>
        emit({ phase: "uploading", current, total }),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** 默认保存路径选择（showSaveDialog：默认名 tianshu-backup-<本地时间
 *  戳>.tar.gz，系统级覆盖确认；取消返回 null） */
async function defaultPickSavePath(): Promise<string | null> {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const result = await dialog.showSaveDialog({
    defaultPath: `tianshu-backup-${stamp}.tar.gz`,
  });
  return result.canceled || !result.filePath ? null : result.filePath;
}

/** 默认恢复档案选择（showOpenDialog：tar.gz 过滤；取消返回 null） */
async function defaultPickArchivePath(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [
      { name: "备份档案 (tar.gz)", extensions: ["gz", "tar.gz"] },
    ],
  });
  return result.canceled || result.filePaths.length === 0
    ? null
    : result.filePaths[0];
}

/**
 * 本地导出完整链（无服务端）：数据根临时区打包 → copyFileSync 到用户
 * 目标（跨卷安全——目标常为外置盘/网络盘）→ 落盘字节 sha256 对拍
 * （spec §3.3 完整性闸门同口径；不符删目标坏档不留假备份）。进度仅
 * packing 一相（无上传相）。
 */
export async function createBackupLocal(
  destPath: string,
  deps: BackupIpcDeps,
  emit: BackupEmit,
): Promise<{ destPath: string; fileSize: number; sha256: string }> {
  const tempDir = mkdtempSync(path.join(tianshuRoot(), ".backup-local-"));
  try {
    emit({ phase: "packing", current: 0, total: 0 });
    const archiveFn = deps.archive ?? createBackupArchive;
    const archive = await archiveFn({
      tempDir,
      appVersion: (deps.appVersion ?? app.getVersion)(),
    });
    // 异步 copy（GB 级档案 + 慢速目标盘不冻结主进程事件环）
    await copyFile(archive.archivePath, destPath);
    const sha256 = await hashFile(destPath);
    if (sha256 !== archive.meta.sha256) {
      try {
        rmSync(destPath, { force: true });
      } catch {
        // 删坏档失败（AV 锁定等）不掩盖原始校验错——残留文件下次覆盖
      }
      throw new Error("备份校验失败：sha256 不匹配");
    }
    return { destPath, fileSize: archive.meta.fileSize, sha256 };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * 恢复执行链（远端下载后与本地档案共用）：restoring 事件 → 断 Prisma →
 * 保护副本 → 原子切换 → relaunchRequired。安全副本临时区独立 mkdtemp
 * （数据根直下同卷 rename 纪律），与调用方各自的下载/导出临时区互不
 * 纠缠，finally 各自清理。
 */
async function runRestoreChain(
  archivePath: string,
  deps: BackupIpcDeps,
  emit: BackupEmit,
): Promise<{ relaunchRequired: true }> {
  emit({ phase: "restoring", current: 0, total: 0 });
  const safetyTempDir = mkdtempSync(path.join(tianshuRoot(), ".backup-safety-"));
  try {
    // 先断 Prisma 再动文件（Windows rename 打开句柄必败；恢复后由
    // relaunch 重建连接，macOS/Linux POSIX 句柄语义本就宽松）
    const disconnect =
      deps.disconnectDatabase ?? (() => prisma.$disconnect());
    await disconnect();
    // 保护副本（旧数据快照 → 数据根 backups-local/，分组外不被切换波及）
    await (deps.safety ?? createLocalSafetyCopy)(safetyTempDir);
    await (deps.restore ?? restoreArchive)(archivePath);
    return { relaunchRequired: true };
  } finally {
    rmSync(safetyTempDir, { recursive: true, force: true });
  }
}

export function registerBackupIpc(deps: BackupIpcDeps): void {
  const emit: BackupEmit = (payload: BackupProgressPayload): void => {
    for (const win of deps.windows()) {
      win.webContents.send("backup:progress", payload);
    }
    // 备份面批：face 事件总线并行扇出（远程控制端 backup.progress；
    // SSE/relay 现有通道零新传输，订阅者异常已被 face-events 隔离）
    publishFaceEvent({ type: "backup.progress", payload });
  };

  // 申领写回默认实现（未装配即报错——claim 通道在写回步显式失败，比
  // 静默丢弃 clientToken 安全：该 token 仅申领时回显一次，丢了须重邀）
  const saveConnection =
    deps.saveConnection ??
    (async (_connId: string, _patch: { backupToken: string }) => {
      throw new Error("备份申领写回未装配（saveConnection 缺失）");
    });

  ipcMain.handle("backup:list", async (_e, connId: string) =>
    listBackupsWithViewer(connId, deps),
  );
  ipcMain.handle(
    "backup:delete",
    async (_e, connId: string, backupId: string) =>
      deleteBackupById(connId, backupId, deps),
  );
  // 恢复后手动重启薄封装（恢复成功前端提示「点击重启生效」，不自动重启
  // ——防丢用户上下文；与 settings:relaunchApp 同语义独立通道）
  ipcMain.handle("backup:relaunch", (): void => {
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle("backup:create", async (_e, connId: string, note?: string) =>
    createBackupNow(connId, note, deps, emit),
  );

  // —— 本地链路（无服务端）：不碰连接注册表，选择器取消返回 null ——

  ipcMain.handle("backup:create:local", async () => {
    const destPath = await (deps.pickSavePath ?? defaultPickSavePath)();
    if (!destPath) return null;
    return createBackupLocal(destPath, deps, emit);
  });

  // —— 多用户扩展（spec 2026-10-28 §2）：claim 申领 + 管理面五通道 ——

  /** 邀请码申领：大门 token 调 claim → clientToken 写回连接 backupToken
   *  （备份身份自动落位，用户零手填）；返回 clientId（成功 toast 用） */
  ipcMain.handle(
    "backup:claim",
    async (_e, connId: string, inviteCode: string, deviceName: string) => {
      const client = await gatewayClientFor(connId, deps);
      const { clientId, clientToken } = await client.claim(
        inviteCode,
        deviceName,
      );
      await saveConnection(connId, { backupToken: clientToken });
      return { clientId };
    },
  );

  // 管理面透传（admin 判定在 server 端——BACKUP_ADMIN_ONLY 业务错直抛）。
  // 凭据与数据面同链（backupClientFor：backupToken ?? token）：二层部署
  // （server 设 TIANSHU_BACKUP_TOKEN）admin 将该值手填到连接 backupToken
  // 后面板可见，管理调用若走大门 conn.token 会 401（可见不可操作态）；
  // 已申领连接（backupToken=clientToken）则被 requireAdmin 拒——与
  // viewer.kind=admin 的面板显隐判定同源一致
  ipcMain.handle(
    "backup:invites:create",
    async (_e, connId: string, count?: number, note?: string) =>
      (await backupClientFor(connId, deps)).createInvites(count, note),
  );
  ipcMain.handle("backup:invites:list", async (_e, connId: string) =>
    (await backupClientFor(connId, deps)).listInvites(),
  );
  ipcMain.handle(
    "backup:invites:delete",
    async (_e, connId: string, code: string) =>
      (await backupClientFor(connId, deps)).removeInvite(code),
  );
  ipcMain.handle("backup:clients:list", async (_e, connId: string) =>
    (await backupClientFor(connId, deps)).listClients(),
  );
  ipcMain.handle(
    "backup:clients:delete",
    async (_e, connId: string, clientId: string) =>
      (await backupClientFor(connId, deps)).removeClient(clientId),
  );

  ipcMain.handle(
    "backup:restore",
    async (_e, connId: string, backupId: string, expectedSha256?: string) => {
      const client = await backupClientFor(connId, deps);
      const tempDir = mkdtempSync(path.join(tianshuRoot(), ".backup-restore-"));
      try {
        const dest = path.join(tempDir, "download.tar.gz");
        emit({ phase: "downloading", current: 0, total: 0 });
        const { sha256 } = await client.downloadArchive(
          backupId,
          dest,
          (current: number, total: number) =>
            emit({ phase: "downloading", current, total }),
        );
        // 下载后 sha256 对拍（spec §3.3 恢复链路完整性闸门）：客户端对
        // 落盘字节自算的哈希 vs 远端 meta——在 disconnect/safety/restore
        // 之前拦截，不符不动任何本地数据。期望值优先调用方传入（前端
        // 已持选中行 meta.sha256），缺省回查 list 按 backupId 取。
        const expected =
          expectedSha256 ??
          (await client.list()).find((meta: BackupMeta) => meta.id === backupId)
            ?.sha256;
        if (!expected) throw new Error(`备份不存在：${backupId}`);
        if (sha256 !== expected) {
          throw new Error("备份校验失败：sha256 不匹配");
        }
        // sha256 闸门后共用恢复执行链（断库/保护副本/切换——与本地档案恢复同源）
        return await runRestoreChain(dest, deps, emit);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  // 本地档案恢复（无服务端）：存在性与档案预检都在断库前拦截——预检 =
  // verifyTarGzIntegrity（gzip CRC 全量 + ustar 魔数，替代远端 sha256 闸门）
  ipcMain.handle("backup:restore:local", async () => {
    const picked = await (deps.pickArchivePath ?? defaultPickArchivePath)();
    if (!picked) return null;
    // TOCTOU/坏路径统一收敛为「不存在」（不抛裸 ENOENT）
    let isRegularFile = false;
    try {
      isRegularFile = statSync(picked).isFile();
    } catch {
      isRegularFile = false;
    }
    if (!isRegularFile) throw new Error(`备份档案不存在：${picked}`);
    await verifyTarGzIntegrity(picked);
    return runRestoreChain(picked, deps, emit);
  });
}
