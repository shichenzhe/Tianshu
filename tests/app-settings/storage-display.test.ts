/**
 * 存储展示辅助单测：字节格式化边界 + 三段进度条占比计算
 */

import { describe, expect, it } from "vitest";

import type { StorageInfo } from "../../src-react/domains/app-settings/api/settings.api";
import {
  buildBarSegments,
  formatBytes,
} from "../../src-react/domains/app-settings/model/storage-display";

const GB = 1024 ** 3;

describe("formatBytes", () => {
  it("非正数与非法输入统一为 0 B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });

  it("字节取整无小数", () => {
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("KB 起自动进位，小于 10 保留 1 位小数", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(GB)).toBe("1.0 GB");
  });

  it("大于等于 10 取整（避免 10.0 尾零），到 TB 封顶", () => {
    expect(formatBytes(10 * GB)).toBe("10 GB");
    expect(formatBytes(99.9 * 1024 ** 2)).toBe("100 MB");
    expect(formatBytes(2 * 1024 ** 4)).toBe("2.0 TB");
    expect(formatBytes(5000 * 1024 ** 4)).toBe("5000 TB");
  });
});

describe("buildBarSegments", () => {
  it("三段按 缓存/其他占用/可用 占磁盘总量比例", () => {
    const info: StorageInfo = {
      userDataPath: "/userData",
      cacheBytes: GB,
      diskTotal: 100 * GB,
      diskFree: 20 * GB,
    };
    const segments = buildBarSegments(info);
    expect(segments).toEqual([
      { kind: "cache", bytes: GB, ratio: 0.01 },
      { kind: "other", bytes: 79 * GB, ratio: 0.79 },
      { kind: "free", bytes: 20 * GB, ratio: 0.2 },
    ]);
  });

  it("磁盘信息缺失（statfs 失败）退化为单一缓存段", () => {
    const segments = buildBarSegments({
      userDataPath: "/userData",
      cacheBytes: 2048,
      diskTotal: 0,
      diskFree: 0,
    });
    expect(segments).toEqual([
      { kind: "cache", bytes: 2048, ratio: 1 },
      { kind: "other", bytes: 0, ratio: 0 },
      { kind: "free", bytes: 0, ratio: 0 },
    ]);
  });

  it("全为 0 时返回空数组（不渲染条）", () => {
    expect(
      buildBarSegments({
        userDataPath: "/userData",
        cacheBytes: 0,
        diskTotal: 0,
        diskFree: 0,
      }),
    ).toEqual([]);
  });
});
