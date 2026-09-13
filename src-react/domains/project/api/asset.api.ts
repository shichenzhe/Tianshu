/**
 * 项目资产 API
 * IPC 通道由主进程 AssetRepository 提供（electron/domains/project/asset.repo.ts）；
 * 相对路径以 "/" 连接（后端 safeJoin 归一校验），名称清洗/重名序号在后端完成
 */

import { invoke } from "@/lib/ipc";
import type {
  AssetEntry,
  AssetStorage,
  AssetUploadResult,
} from "../../../../electron/domains/project/asset.entity";

export default abstract class AssetApi {
  /** 目录列表（folderPath 缺省为资产空间根目录） */
  static async list(projectId: number, folderPath = ""): Promise<AssetEntry[]> {
    return invoke<AssetEntry[]>("projectAsset:list", projectId, folderPath);
  }

  /** 新建文件夹（返回最终目录名） */
  static async createFolder(
    projectId: number,
    parentPath: string,
    name: string,
  ): Promise<string> {
    return invoke<string>(
      "projectAsset:createFolder",
      projectId,
      parentPath,
      name,
    );
  }

  /** 重命名（同目录内改，返回最终名） */
  static async rename(
    projectId: number,
    oldPath: string,
    newName: string,
  ): Promise<string> {
    return invoke<string>("projectAsset:rename", projectId, oldPath, newName);
  }

  /** 删除（文件 unlink / 文件夹递归，目标缺失幂等） */
  static async remove(projectId: number, targetPath: string): Promise<void> {
    return invoke<void>("projectAsset:delete", projectId, targetPath);
  }

  /** 批量上传（copyFile 逐文件，单文件失败收集进 failed 不中断） */
  static async upload(
    projectId: number,
    folderPath: string,
    absPaths: string[],
  ): Promise<AssetUploadResult> {
    return invoke<AssetUploadResult>(
      "projectAsset:upload",
      projectId,
      folderPath,
      absPaths,
    );
  }

  /** 资产空间用量（递归 du + 5GiB 软配额） */
  static async storage(projectId: number): Promise<AssetStorage> {
    return invoke<AssetStorage>("projectAsset:storage", projectId);
  }

  /** 系统默认程序预览（仅文件） */
  static async openFile(projectId: number, targetPath: string): Promise<void> {
    return invoke<void>("projectAsset:openFile", projectId, targetPath);
  }

  /** Finder/资源管理器定位（文件与文件夹均可） */
  static async revealFile(
    projectId: number,
    targetPath: string,
  ): Promise<void> {
    return invoke<void>("projectAsset:revealFile", projectId, targetPath);
  }

  /** 系统文件多选（上传入口；取消/未选返回 null） */
  static async pickFiles(): Promise<string[] | null> {
    return invoke<string[] | null>("projectAsset:pickFiles");
  }
}
