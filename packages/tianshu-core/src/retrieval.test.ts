// packages/tianshu-core/src/retrieval.test.ts
/**
 * chunkText 递归字符切分单测（批2，docs/design/library-rag.md §6 P1-2）：
 * 分隔符层级回退（段落 → 行 → 句 → 词 → 固定窗口兜底）+ 块上限不变量
 * （每块 ≤ size）+ 整段子块重叠携带。tokenizer/rankBm25/rrfFuse 的同源
 * 消费面单测在桌面 tests/core/retrieval.test.ts（alias 源码直跑）。
 */
import { describe, expect, it } from "vitest";
import { chunkText } from "./retrieval";

describe("chunkText 递归字符切分", () => {
  it("空串/纯空白返回空数组；短文本单块（v1 语义保留）", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n  ")).toEqual([]);
    expect(chunkText("短文本")).toEqual(["短文本"]);
  });

  it("段落边界优先：多段文本按 \\n\\n 段组合块，段不拦腰切断", () => {
    const paras = Array.from({ length: 20 }, (_, i) => `第${i}段`.repeat(60)); // 每段 180 字
    const chunks = chunkText(paras.join("\n\n"), 500, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(500);
      expect(chunk.startsWith("第")).toBe(true); // 块以整段起头
    }
  });

  it("换行层级回退：无空行的长文按 \\n 行边界组块", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line${i}`.padEnd(30, "x"));
    const chunks = chunkText(lines.join("\n"), 120, 0);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(120);
      expect(chunk.startsWith("line")).toBe(true); // 每行 30 < 120，行不被切断
    }
  });

  it("重叠携带：次块以首块尾部整段子块起头（不产生跨块拦腰新缝）", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line${i}`.padEnd(30, "x"));
    const chunks = chunkText(lines.join("\n"), 120, 60);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[1].startsWith(lines[2])).toBe(true); // 首块 3 行（92 字），携带末行
  });

  it("中文句号层级：单段无换行长文按句组合块（句长完整）", () => {
    const sentence = "这是一个完整句子的内容".repeat(4); // 44 字/句（句号由分隔符贴回）
    const chunks = chunkText(`${sentence}。`.repeat(30), 500, 0);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(500);
      // 句子不被拦腰：每句拆出后长度恒等
      expect(chunk.split("。").every((s) => s.length === sentence.length)).toBe(
        true,
      );
    }
  });

  it("空格层级回退：无标点英文长串按词组块", () => {
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`);
    const chunks = chunkText(words.join(" "), 120, 0);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(120);
      expect(chunk.startsWith("word")).toBe(true);
      expect(chunk.endsWith(" ")).toBe(false); // 词为整块边界，无悬挂分隔符
    }
  });

  it("无任何分隔符的超长串退固定字符窗口 + 重叠（v1 形态兜底）", () => {
    const text = Array.from(
      { length: 1200 },
      (_, i) => String.fromCharCode(97 + (i % 26)),
    ).join("");
    const chunks = chunkText(text, 500, 100);
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 400]);
    expect(chunks.map((c) => c[0])).toEqual(["a", "k", "u"]); // 偏移 0/400/800
  });

  it("缺省参数 500/100：任意长文本每块 ≤ 500", () => {
    const text = Array.from({ length: 60 }, (_, i) => `段落${i}。`.repeat(20)).join("\n\n");
    for (const chunk of chunkText(text)) {
      expect(chunk.length).toBeLessThanOrEqual(500);
    }
  });
});
