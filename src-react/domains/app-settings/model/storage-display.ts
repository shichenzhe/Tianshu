/**
 * 存储占用展示辅助：字节格式化 + 三段进度条占比计算
 */

import type { StorageInfo } from "../api/settings.api";

/** 字节单位（逐级 1024 进位） */
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

/** 自动选单位：B 取整；1KB-10TB 保留 1 位小数（≥10 值取整避免 "10.0" 尾零） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const text =
    unitIndex === 0 || value >= 10
      ? String(Math.round(value))
      : value.toFixed(1);
  return `${text} ${BYTE_UNITS[unitIndex]}`;
}

/** 进度条段：cache 应用缓存 / other 磁盘其他占用 / free 可用 */
export interface StorageSegment {
  kind: "cache" | "other" | "free";
  bytes: number;
  ratio: number;
}

/**
 * 三段占比（总和为磁盘总量）：缓存 + 其他占用 + 可用。
 * 磁盘信息缺失（statfs 失败 diskTotal=0）时退化为单一缓存段；
 * 全为 0 返回空数组（不渲染条）。
 */
export function buildBarSegments(info: StorageInfo): StorageSegment[] {
  const diskUsed = Math.max(info.diskTotal - info.diskFree, 0);
  const otherBytes = Math.max(diskUsed - info.cacheBytes, 0);
  const total = info.diskTotal > 0 ? info.diskTotal : info.cacheBytes;
  if (total <= 0) {
    return [];
  }
  return [
    { kind: "cache", bytes: info.cacheBytes, ratio: info.cacheBytes / total },
    { kind: "other", bytes: otherBytes, ratio: otherBytes / total },
    { kind: "free", bytes: info.diskFree, ratio: info.diskFree / total },
  ];
}
