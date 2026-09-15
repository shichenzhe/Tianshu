import { describe, expect, it } from "vitest";
import {
  stableStringify,
  computeEntryHash,
  verifyChain,
} from "../../electron/domains/security/audit/hash-chain";

describe("stableStringify", () => {
  it("对象 key 顺序无关，结果稳定", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(
      stableStringify({ b: 2, a: 1 }),
    );
  });
  it("剔除 undefined 值", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });
  it("嵌套对象递归排序", () => {
    expect(stableStringify({ x: { b: 1, a: 2 } })).toBe('{"x":{"a":2,"b":1}}');
  });
  it("Date 实例与等价 ISO 串序列化一致（Prisma 读回 createdAt 为 Date）", () => {
    const iso = "2026-09-15T08:00:00.000Z";
    expect(stableStringify({ createdAt: new Date(iso) })).toBe(
      stableStringify({ createdAt: iso }),
    );
  });
});

describe("computeEntryHash", () => {
  it("同一 prevHash + 同内容 → 同 hash", () => {
    const e = { sequence: 1, category: "config", hash: "旧值应被忽略" };
    expect(computeEntryHash(e, null)).toBe(
      computeEntryHash({ ...e, hash: "另一个旧值" }, null),
    );
  });
  it("prevHash 不同 → hash 不同（链式依赖）", () => {
    const e = { sequence: 1, eventType: "audit.cleared" };
    expect(computeEntryHash(e, null)).not.toBe(computeEntryHash(e, "abc"));
  });
  it("库端自增 id 不参与 hash：含 id 复算与不含一致", () => {
    const entry = {
      sequence: 1,
      category: "config",
      createdAt: "2026-09-15T00:00:00.000Z",
    };
    expect(computeEntryHash({ id: 42, ...entry }, null)).toBe(
      computeEntryHash(entry, null),
    );
  });
});

describe("verifyChain", () => {
  const mk = (
    seq: number,
    prevHash: string | null,
    e: Record<string, unknown> = {},
  ) => {
    const entry = { sequence: seq, category: "config", ...e, prevHash };
    return { ...entry, hash: computeEntryHash(entry, prevHash) };
  };
  it("合法链返回 true", () => {
    const e1 = mk(1, null);
    const e2 = mk(2, e1.hash);
    expect(verifyChain([e1, e2])).toBe(true);
  });
  it("断链（prevHash 不接续）返回 false", () => {
    const e1 = mk(1, null);
    const e3 = mk(3, "伪造hash");
    expect(verifyChain([e1, e3])).toBe(false);
  });
  it("被篡改内容（hash 与重算不符）返回 false", () => {
    const e1 = mk(1, null);
    const tampered = { ...e1, eventType: "被改了" };
    expect(verifyChain([tampered])).toBe(false);
  });
  it("已落库形状（含自增 id + Date createdAt）整链复算通过", () => {
    // 写入侧以 ISO 串编 hash，读回/导出行含库端 id 且 createdAt 为 Date
    const mkDbRow = (seq: number, prevHash: string | null) => {
      const writeRow = {
        sequence: seq,
        eventType: "audit.cleared",
        createdAt: "2026-09-15T00:00:00.000Z",
        prevHash,
      };
      const hash = computeEntryHash(writeRow, prevHash);
      return {
        id: seq * 100,
        ...writeRow,
        createdAt: new Date(writeRow.createdAt),
        hash,
      };
    };
    const e1 = mkDbRow(1, null);
    const e2 = mkDbRow(2, e1.hash);
    expect(verifyChain([e1, e2])).toBe(true);
  });
});
