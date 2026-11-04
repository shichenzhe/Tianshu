import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  appendEntry,
  ESTIMATE_COUNT_LIMIT,
  orphanedHashes,
  selectEvictions,
  snapshotName,
  totalSize,
  type BackupEntry,
} from "../../electron/domains/security/backup-policy";

const entry = (over: Partial<BackupEntry> = {}): BackupEntry => ({
  path: "/tmp/ws/a.ts",
  hash: "h1",
  at: 1000,
  size: 100,
  ...over,
});

describe("snapshotName", () => {
  it("sha256 前 32 hex，同内容稳定", () => {
    const expectHex = createHash("sha256")
      .update("hello")
      .digest("hex")
      .slice(0, 32);
    expect(snapshotName(Buffer.from("hello"))).toBe(expectHex);
    expect(snapshotName(Buffer.from("hello"))).toBe(
      snapshotName(Buffer.from("hello")),
    );
    expect(snapshotName(Buffer.from("world"))).not.toBe(expectHex);
  });
});

describe("appendEntry / totalSize", () => {
  it("追加不改原数组（不可变）；totalSize 求和", () => {
    const a = [entry()];
    const next = appendEntry(a, entry({ hash: "h2", size: 50 }));
    expect(a).toHaveLength(1);
    expect(next).toHaveLength(2);
    expect(totalSize(next)).toBe(150);
  });
});

describe("selectEvictions", () => {
  it("未超配额返回空；超则按 at 升序淘汰最旧直至达标", () => {
    const es = [
      entry({ hash: "new", at: 3000, size: 100 }),
      entry({ hash: "old", at: 1000, size: 100 }),
      entry({ hash: "mid", at: 2000, size: 100 }),
    ];
    expect(selectEvictions(es, 300)).toEqual([]);
    expect(selectEvictions(es, 250)).toEqual([
      entry({ hash: "old", at: 1000, size: 100 }),
    ]);
    expect(selectEvictions(es, 150)).toEqual([
      entry({ hash: "old", at: 1000, size: 100 }),
      entry({ hash: "mid", at: 2000, size: 100 }),
    ]);
  });
  it("maxBytes=0 全淘汰；空表返回空", () => {
    const es = [entry({ hash: "a" }), entry({ hash: "b" })];
    expect(selectEvictions(es, 0)).toHaveLength(2);
    expect(selectEvictions([], 0)).toEqual([]);
  });
});

describe("orphanedHashes", () => {
  it("被淘汰 hash 仍被剩余引用则不删；evicted 内去重", () => {
    const remaining = [entry({ path: "/x", hash: "shared" })];
    const evicted = [
      entry({ path: "/y", hash: "shared" }),
      entry({ path: "/z", hash: "gone" }),
      entry({ path: "/w", hash: "gone" }),
    ];
    expect(orphanedHashes(remaining, evicted)).toEqual(["gone"]);
    expect(orphanedHashes([], [])).toEqual([]);
  });
});

describe("常量", () => {
  it("单文件 100MB / 预估上限 10000", () => {
    expect(ESTIMATE_COUNT_LIMIT).toBe(10000);
  });
});
