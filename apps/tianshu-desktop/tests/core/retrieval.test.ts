// tests/core/retrieval.test.ts
/**
 * 检索纯函数：tokenize（中英混合/专有名词/空串/纯符号）、rankBm25
 * （排序语义/IDF 平滑/零命中剔除/空输入短路）、rrfFuse（同 chunk 累加/
 * rank 重排/空输入）。
 */
import { describe, expect, it } from "vitest";
import {
  tokenize,
  rankBm25,
  rrfFuse,
  BM25_K1,
  BM25_B,
  type Bm25Doc,
  type FusedHit,
} from "@tianshu/core";

const doc = (chunkId: number, text: string): Bm25Doc => ({
  chunkId,
  sourceName: `s${chunkId}`,
  collection: "c",
  text,
});
const hit = (chunkId: number, text: string): FusedHit => ({
  chunkId,
  sourceName: `s${chunkId}`,
  collection: "c",
  text,
  score: 0.9,
  rank: 0,
});

describe("tokenize", () => {
  it("中文按词典切词且词元可拼接", () => {
    const tokens = tokenize("天枢支持混合检索");
    expect(tokens.length).toBeGreaterThan(2);
    expect(tokens.join("")).toBe("天枢支持混合检索");
  });
  it("中英混合与数字保留", () => {
    const tokens = tokenize("SQLite 支持 BM25 排序 v2");
    expect(tokens).toContain("SQLite");
    expect(tokens).toContain("BM25");
    expect(tokens).toContain("v2");
  });
  it("空串与纯符号产出空数组", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("！？…—")).toEqual([]);
  });
});

describe("rankBm25", () => {
  const docs = [
    doc(1, "分布式系统的容错设计与故障恢复"), // 双词都含
    doc(2, "容错相关的其它讨论"), // 单词命中
    doc(3, "前端组件的状态管理最佳实践"), // 零命中
  ];
  it("双词命中 > 单词命中；零命中剔除；限 topK", () => {
    const hits = rankBm25(tokenize("容错 设计"), docs, 2);
    expect(hits[0].chunkId).toBe(1);
    expect(hits.map((h) => h.chunkId)).toEqual([1, 2]); // topK=2 且零命中的 3 剔除
  });
  it("IDF 平滑：高频词单独命中分数为正（+1 平滑防负）", () => {
    const hits = rankBm25(tokenize("容错"), docs, 3);
    expect(hits.length).toBe(2);
    expect(hits.every((h) => h.score > 0)).toBe(true);
  });
  it("空词元或空文档短路返回空数组", () => {
    expect(rankBm25([], docs, 5)).toEqual([]);
    expect(rankBm25(["容错"], [], 5)).toEqual([]);
  });
  it("默认参数为业界值", () => {
    expect(BM25_K1).toBe(1.5);
    expect(BM25_B).toBe(0.75);
  });
});

describe("rrfFuse", () => {
  it("两路同 chunkId 分数累加且排前", () => {
    // brief 原稿 fts 侧为 [hit(3), hit(1)]，与其自身期望矛盾（位置 2 贡献
    // 是 1/62 非 1/61，且 3 的 1/61 会压过 2 的 1/62 得 [1,3,2]）——按期望
    // 数值意图修正为 chunk 1 两路均居首；2/3 并列 1/62 靠稳定排序保序。
    const fused = rrfFuse(
      [hit(1, "a"), hit(2, "b")],
      [hit(1, "a"), hit(3, "c")],
      60,
    );
    expect(fused[0].chunkId).toBe(1);
    expect(fused[0].score).toBeCloseTo(1 / 61 + 1 / 61, 10);
    expect(fused.map((f) => f.chunkId)).toEqual([1, 2, 3]);
  });
  it("融合后 rank 从 1 重编", () => {
    expect(rrfFuse([hit(5, "x")], [], 60)[0].rank).toBe(1);
  });
  it("空输入返回空数组", () => {
    expect(rrfFuse([], [])).toEqual([]);
  });
});
