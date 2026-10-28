// A7 项目批（spec 2026-10-26 §2.2）：桌面被控面 projectAsset 六端点桥——
// AssetRepository 历史裸暴露（ipcMain.handle 无 userId 参数），可见性守卫
// 同 planView 逐方法补（assertProjectVisible 在前）；readImage 服务端解析
// 资产根（resolveAssetRoot）+ safeJoin 沙箱 + mime 白名单 + 10MB——物理
// 布局不透出，错误码复用 PROJECT_ERROR_CODES（映射见 readImageOf 注记）。
import fs from "node:fs/promises";
import path from "node:path";

import type { LibraryReadImageResult } from "@tianshu/protocol";
import type AssetRepository from "../project/asset.repo";
import { safeJoin } from "../project/asset.repo";
import type ProjectRepository from "../project/project.repo";
import type { ServerFaceProjectAsset } from "./deps";
import { FaceProjectError, toFaceProjectError } from "./project-tap";

/** readImage 图片上限（对齐 library-tap 与 workspace-files IMAGE_READ_LIMIT） */
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** readImage 扩展名 → mime 白名单（library-tap 同口径——不回传可含脚本的 svg） */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** 可见性守卫来源（ProjectRepository.assertProjectVisible 子集） */
type ProjectGuard = Pick<ProjectRepository, "assertProjectVisible">;
type AssetRepoSubset = Pick<
  AssetRepository,
  "list" | "createFolder" | "rename" | "delete" | "storage" | "resolveAssetRoot"
>;

/** 逐方法守门：非 owner 非成员拒（PROJECT_NOT_FOUND，存在性不泄露口径） */
async function assertVisible(
  projectRepo: ProjectGuard,
  userId: number,
  projectId: number,
): Promise<void> {
  await projectRepo
    .assertProjectVisible(projectId, userId)
    .catch(toFaceProjectError);
}

/** readImage 错误码映射（协议码表无 ASSET_TOO_LARGE/BINARY 专码，就近复用）：
 *  路径越界/空字节 → ASSET_PATH_ESCAPE；扩展名非白名单 → ASSET_NAME_INVALID；
 *  不存在/目录/超过 10MB/读盘失败 → ASSET_NOT_FOUND（message 明示具体原因） */
async function readImageOf(
  repo: AssetRepoSubset,
  projectId: number,
  relPath: string,
): Promise<LibraryReadImageResult> {
  const { root } = await repo
    .resolveAssetRoot(projectId)
    .catch(toFaceProjectError);
  let abs: string;
  try {
    abs = safeJoin(root, relPath);
  } catch {
    throw new FaceProjectError("ASSET_PATH_ESCAPE", "非法路径");
  }
  const mime = IMAGE_MIME_BY_EXT[path.extname(abs).toLowerCase()];
  if (!mime) {
    throw new FaceProjectError("ASSET_NAME_INVALID", "不是受支持的图片格式");
  }
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) {
      throw new FaceProjectError("ASSET_NOT_FOUND", "资产不存在或不是文件");
    }
    if (stat.size > IMAGE_MAX_BYTES) {
      throw new FaceProjectError("ASSET_NOT_FOUND", "图片超过 10MB 上限");
    }
    const buf = await fs.readFile(abs);
    return { mime, dataBase64: buf.toString("base64") };
  } catch (error) {
    if (error instanceof FaceProjectError) throw error;
    throw new FaceProjectError("ASSET_NOT_FOUND", "资产不存在或读取失败");
  }
}

export function createProjectAssetFace(
  projectRepo: ProjectGuard,
  assetRepo: AssetRepoSubset,
): ServerFaceProjectAsset {
  return {
    list: async (userId, projectId, folderPath) => {
      await assertVisible(projectRepo, userId, projectId);
      const entries = await assetRepo
        .list(projectId, folderPath)
        .catch(toFaceProjectError);
      // AssetEntry.ext 桌面侧 null（文件夹/无扩展名）→ DTO 空串归一
      return entries.map((entry) => ({ ...entry, ext: entry.ext ?? "" }));
    },
    createFolder: async (userId, projectId, parentPath, name) => {
      await assertVisible(projectRepo, userId, projectId);
      return assetRepo
        .createFolder(projectId, parentPath, name)
        .catch(toFaceProjectError);
    },
    rename: async (userId, projectId, relPath, newName) => {
      await assertVisible(projectRepo, userId, projectId);
      return assetRepo
        .rename(projectId, relPath, newName)
        .catch(toFaceProjectError);
    },
    remove: async (userId, projectId, relPath) => {
      await assertVisible(projectRepo, userId, projectId);
      await assetRepo.delete(projectId, relPath).catch(toFaceProjectError);
    },
    storage: async (userId, projectId) => {
      await assertVisible(projectRepo, userId, projectId);
      return assetRepo.storage(projectId).catch(toFaceProjectError);
    },
    readImage: async (userId, projectId, relPath) => {
      await assertVisible(projectRepo, userId, projectId);
      return readImageOf(assetRepo, projectId, relPath);
    },
  };
}
