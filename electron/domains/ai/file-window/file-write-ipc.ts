/**
 * workspace:writeFile handler（文件窗口保存链路，spec 2026-10-14 §5.2）
 * + workspace:fileChanged 全窗广播。写路径围栏（终审 I1）：resolve 后
 * containment 双检 + realpath 复检（口径同 agent 侧 resolveSafePath），
 * 越界抛 PATH_OUTSIDE_WORKSPACE——渲染层攻陷不得借此写任意本地路径。
 * 广播服务两条写路径：用户手动保存
 * （本 handler）与 AI write_file 工具（ChatService ctx 注入
 * broadcastFileChangedFor 产出的闭包，spec §6.4）。
 * AI 直改库文件联动（T14 修复轮 Important 1）：write_file 裸 fs.writeFile
 * 不经 library:writeFileContent——notifyLibraryFileWritten 补 updatedAt
 * bump + fileWindow:libraryChanged 全窗广播（文件窗 library tab 基线/
 * 重载感知；workspace:fileChanged 反解不了库路径，另立库维度事件）。
 */
import { BrowserWindow } from "electron";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import prisma from "../../../commons/prisma-client";
import { handleUser } from "../../../commons/ipc-user";
import Log from "../../../commons/Log";
import { libraryDir } from "../../../commons/paths";
import { realPathLenient } from "../agent/file-tools";
import { resolveFilePath, writeWorkspaceFile } from "../chat/workspace-files";
import type { FileHistoryService } from "../../security/file-history";

export interface WriteFileParams {
  workspaceId: number;
  /** 工作空间内相对路径（渲染层 tab 口径，"/" 分隔） */
  path: string;
  content: string;
  /** 加载时磁盘 mtime（ms）；null = 新建/免检（不符抛 FILE_CONFLICT） */
  baselineMtime: number | null;
  /** 新建语义（+ 菜单）：磁盘已有同名文件即拒绝（抛 FILE_EXISTS），防
   *  唯一名探测（仅扫本窗 tabs）漏掉磁盘既有文件时静默覆写 */
  expectNotExists?: boolean;
}

/** 全窗广播 fileChanged（主窗 React Query invalidate + 文件窗同路径 tab） */
export function broadcastFileChanged(workspaceId: number, path: string): void {
  // best-effort：广播失败（半销毁窗口等）不影响写盘路径本身
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send("workspace:fileChanged", { workspaceId, path });
      } catch {
        // 单窗发送失败不阻断其余窗口
      }
    }
  } catch {
    // 无窗可播（如测试环境未提供 BrowserWindow）：静默
  }
}

/**
 * AI write_file 写盘广播闭包（ChatService ctx.onFileWritten 注入）：
 * absPath 反解 relPath，分隔符统一 "/"（渲染层 dedupe key 口径，
 * win32 的 path.relative 产出 "\"）
 */
export function broadcastFileChangedFor(
  workspaceId: number,
  workspaceDir: string,
): (absPath: string) => void {
  return (absPath) =>
    broadcastFileChanged(
      workspaceId,
      path.relative(workspaceDir, absPath).split(path.sep).join("/"),
    );
}

/** 全窗广播 fileWindow:libraryChanged（库维度文件变更，T14 修复轮） */
export function broadcastLibraryChanged(itemId: number): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send("fileWindow:libraryChanged", { itemId });
      } catch {
        // 单窗发送失败不阻断其余窗口
      }
    }
  } catch {
    // 无窗可播（如测试环境未提供 BrowserWindow）：静默
  }
}

/**
 * AI 直改库文件后的条目联动（T14 修复轮 Important 1）：absPath 落在
 * libraryDir() 下时——①bump 条目 updatedAt/size（storagePath 非落库列，
 * 按 libraryDir() 下首段 <itemId> 寻址，同 toClientItem 组装口径）；
 * ②全窗广播 fileWindow:libraryChanged（渲染层 library tab 非脏重读/
 * 脏置 externalChanged）。非库路径返回 false（调用方回落工作空间维度
 * fileChanged 广播）；bump 失败仍广播（文件确已写盘，读侧重载为准），
 * 失败仅记日志。
 */
export async function notifyLibraryFileWritten(
  absPath: string,
): Promise<boolean> {
  const root = libraryDir();
  const abs = path.resolve(absPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) return false;
  const id = Number(abs.slice(root.length + 1).split(path.sep)[0]);
  if (!Number.isInteger(id) || id <= 0) return false;
  let matched: boolean;
  try {
    const size = await fs.stat(abs).then(
      (s) => s.size,
      () => null,
    );
    const result = await prisma.libraryItem.updateMany({
      where: { id, kind: "file" },
      data: { updatedAt: new Date(), ...(size !== null ? { size } : {}) },
    });
    matched = result.count > 0;
  } catch (e) {
    Log.error("[file-window] 库条目直改联动 bump 失败", e);
    matched = true; // bump 失败仍广播：读侧重载兜底
  }
  if (matched) broadcastLibraryChanged(id);
  return true;
}

export default class FileWriteIpc {
  constructor(
    private deps: {
      fileHistory: FileHistoryService;
      fileBackupEnabled: () => boolean;
    },
  ) {
    handleUser("workspace:writeFile", (_e, userId, p: WriteFileParams) =>
      this.write(p, userId),
    );
  }

  private async write(
    p: WriteFileParams,
    userId: number,
  ): Promise<{ absPath: string; mtime: number }> {
    // 归属校验（口径同 session.repo assertWorkspaceOwned：不存在与
    // 他人所有同报错，不泄露存在性）
    const ws = await prisma.workspace.findFirst({
      where: { id: p.workspaceId, userId },
      select: { directoryPath: true },
    });
    if (!ws) throw new Error("WORKSPACE_NOT_FOUND");
    // 判空与写盘同用 trim 后值（空白目录路径不落到 resolve 残留 cwd 语义）
    const directoryPath = ws.directoryPath?.trim() ?? "";
    if (!directoryPath) throw new Error("工作空间未绑定目录");
    this.assertPathInside(directoryPath, p.path);
    const result = await writeWorkspaceFile(
      directoryPath,
      {
        relPath: p.path,
        content: p.content,
        baselineMtime: p.baselineMtime,
        expectNotExists: p.expectNotExists,
      },
      {
        // sessionId=0 = 手动保存（非会话来源）：FileHistoryService 仅以
        // sessionId 作备份目录分组名，0 即独立的「手动保存」分组
        backupFile: this.deps.fileBackupEnabled()
          ? (abs) => this.deps.fileHistory.backupFile(abs, 0)
          : undefined,
      },
    );
    broadcastFileChanged(p.workspaceId, p.path);
    Log.info(`[file-window] 写入 ${p.path}（${result.absPath}）`);
    return result;
  }

  /** 写路径围栏：path 源自渲染层 IPC（攻陷渲染层即任意输入），resolve 后
   *  containment 双检——文字前缀（绝对路径/`..` 逃逸直接拒）+ realpath
   *  复检（symlink 展开后仍须在空间内；缺失段沿祖先解析，同 agent 侧
   *  resolveSafePath 口径。workspace-files 的 fullAccess 语义属读通道，
   *  不适用于本写通道）。越界抛 PATH_OUTSIDE_WORKSPACE */
  private assertPathInside(directoryPath: string, relPath: string): void {
    const resolved = resolveFilePath(directoryPath, relPath);
    const wsRoot = path.resolve(directoryPath);
    if (resolved !== wsRoot && !resolved.startsWith(wsRoot + path.sep)) {
      throw new Error("PATH_OUTSIDE_WORKSPACE");
    }
    const realWs = realpathSync(directoryPath);
    const real = realPathLenient(resolved);
    if (real !== realWs && !real.startsWith(realWs + path.sep)) {
      throw new Error("PATH_OUTSIDE_WORKSPACE");
    }
  }
}
