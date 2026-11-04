/**
 * 会话级路径授权清单 IPC（spec 2026-10-14 §6.4）：
 * - fileWindow:grantFilePath：渲染层（文件窗口 library tab 会话）注册 AI
 *   直改授权；session 归属校验（session.userId === userId，防越权为他
 *  人会话注册）；absPath trim 后 resolve（首尾空白不炸 isAbsolute 判定）
 * - fileWindow:revokeSession：渲染层关 library tab 时回收（T14 接线，
 *   LibraryTabBody 卸载触发）；同受归属校验
 * 通道白名单（ipc-channels.ts）两通道均已登记，勿重复。
 */
import path from "node:path";
import prisma from "../../../commons/prisma-client";
import { handleUser } from "../../../commons/ipc-user";
import { grantFilePath, revokeSession } from "./granted-paths";

export interface GrantFilePathParams {
  sessionId: number;
  /** 授权绝对路径（library 条目 storagePath） */
  absPath: string;
}

export interface RevokeSessionParams {
  sessionId: number;
}

/** 会话归属校验：sessionId 须属于当前用户（不存在/他人会话一律拒绝） */
async function assertSessionOwned(
  sessionId: number,
  userId: number,
): Promise<void> {
  const row = await prisma.session.findFirst({
    where: { id: sessionId, userId },
    select: { id: true },
  });
  if (!row) throw new Error("SESSION_NOT_FOUND");
}

export function registerGrantedPathsIpc(): void {
  handleUser(
    "fileWindow:grantFilePath",
    async (_event, userId, p: GrantFilePathParams) => {
      if (
        typeof p?.sessionId !== "number" ||
        typeof p?.absPath !== "string" ||
        !path.isAbsolute(p.absPath.trim())
      ) {
        throw new Error("grantFilePath 参数非法（须为会话 id 与绝对路径）");
      }
      await assertSessionOwned(p.sessionId, userId);
      // userId 随传落盘/分桶（T28 多用户隔离，spec §16 项 2）
      return grantFilePath(p.sessionId, path.resolve(p.absPath.trim()), userId);
    },
  );

  handleUser(
    "fileWindow:revokeSession",
    async (_event, userId, p: RevokeSessionParams) => {
      if (typeof p?.sessionId !== "number") {
        throw new Error("revokeSession 参数非法（须为会话 id）");
      }
      await assertSessionOwned(p.sessionId, userId);
      return revokeSession(p.sessionId, userId);
    },
  );
}
