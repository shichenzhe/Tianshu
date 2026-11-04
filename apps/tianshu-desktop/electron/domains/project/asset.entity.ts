/**
 * 项目资产数据接口（前后端共享，项目模块二期 spec §4）
 * 文件面板（Task 5/6）与 @ 引用消费；AssetUploadResult/AssetStorage 由
 * Task 4 上传/用量 IPC 消费，本期先定契约
 */

/**
 * 资产条目：文件或文件夹（projectAsset:list 返回结构）
 */
export interface AssetEntry {
  /**
   * 条目名（不含路径）
   */
  name: string;

  /**
   * 条目类型
   */
  type: "file" | "folder";

  /**
   * 文件字节；文件夹 = readdir+stat 当前层懒统计累计
   * （仅一层直接子文件字节和，嵌套目录不递归深挖）
   */
  size: number;

  /**
   * 更新时间（ISO）
   */
  updatedAt: string;

  /**
   * 扩展名：小写无点，仅文件；文件夹 null
   */
  ext: string | null;
}

/**
 * 批量上传结果（projectAsset:upload 返回，Task 4 实现）
 */
export interface AssetUploadResult {
  /**
   * 上传成功的条目名
   */
  uploaded: string[];

  /**
   * 上传失败的条目名
   */
  failed: string[];
}

/**
 * 资产空间用量（projectAsset:storage 返回，Task 4 实现；quota 恒 5*1024^3）
 */
export interface AssetStorage {
  /**
   * 已用字节
   */
  usedBytes: number;

  /**
   * 配额字节
   */
  quotaBytes: number;
}

/**
 * 资产空间软配额（5GiB）：仅 UI 用量提示，上传不做硬拦截（spec §4）
 */
export const ASSET_QUOTA_BYTES = 5 * 1024 ** 3;
