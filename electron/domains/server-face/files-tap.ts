/**
 * 桌面被控面文件实现（FA-T2，spec 2026-10-20 §3.1）：files/list|read|
 * uploadImage 的 face 侧真身——清单/守卫读取经 @tianshu/core 共享纯函数
 * （与 mirror file:listWorkspaceFiles、无头端 files 端点三处同口径）；
 * uploadImage 落本机数据根 attachments/（electron paths——dev/app 分组
 * 含在 attachmentsDir 内），返回相对 appDataHome 的路径（sessionSend
 * images/ImageBlock.imagePath 同值消费，本机 loadImage 回喂零适配）。
 * workspace 归属校验对齐 face 既有桥（userId 比对）。
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { listWorkspaceFiles, readTextFileGuarded } from "@tianshu/core";
import prisma from "../../commons/prisma-client";
import { appDataHome, attachmentsDir } from "../../commons/paths";
import type { ServerFaceFiles } from "./deps";

/** relay 单帧 4MiB 余量（spec §6 假设 1；无头端同值） */
const IMAGE_MAX_BYTES = 3 * 1024 * 1024;

/** files 面业务错（code 稳定——routes 侧转 bizError 信封，控制端判码） */
export class FaceFilesError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** workspace 绑定目录（归属校验 + 未绑拒） */
async function workspaceRootOf(
  userId: number,
  workspaceId: number,
): Promise<string> {
  const workspace = await prisma.workspace.findFirst({
    where: { id: workspaceId },
  });
  const root =
    workspace && workspace.userId === userId
      ? (workspace.directoryPath ?? "").trim()
      : "";
  if (!root) {
    throw new FaceFilesError("FILES_NO_WORKSPACE", "未绑定工作空间目录");
  }
  return root;
}

export function createFilesFace(): ServerFaceFiles {
  return {
    async list(userId, workspaceId) {
      return listWorkspaceFiles(await workspaceRootOf(userId, workspaceId));
    },

    async read(userId, workspaceId, relPath) {
      const root = await workspaceRootOf(userId, workspaceId);
      const absolute = path.resolve(root, relPath);
      if (absolute !== root && !absolute.startsWith(root + path.sep)) {
        throw new FaceFilesError("FILES_PATH_ESCAPE", "路径越界");
      }
      const guarded = await readTextFileGuarded(absolute);
      if (guarded.ok) {
        return { content: guarded.content };
      }
      if (guarded.reason === "too-large") {
        throw new FaceFilesError("FILES_TOO_LARGE", "超过 512KB 上限");
      }
      if (guarded.reason === "binary") {
        throw new FaceFilesError("FILES_BINARY", "二进制文件");
      }
      throw new FaceFilesError("FILES_READ_FAILED", "读取失败");
    },

    async uploadImage(input) {
      const bytes = Buffer.from(input.base64, "base64");
      if (bytes.length > IMAGE_MAX_BYTES) {
        throw new FaceFilesError("FILES_IMAGE_TOO_LARGE", "图片超过 3MB 上限");
      }
      // name 剥路径段防逃逸；唯一子目录隔离冲突——文件保原名（展示名）
      const safeName = path.basename(input.name ?? "") || "image.png";
      const dirName = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
      const dir = path.join(attachmentsDir(), dirName);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, safeName), bytes);
      return {
        imagePath: path.relative(appDataHome(), path.join(dir, safeName)),
      };
    },
  };
}
