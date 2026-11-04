// tests/ai/prompt-highlight.test.ts
/**
 * 高亮分段纯函数：合法变量占位符高亮（非法 {{...}} 不高亮）、prompt
 * 语言无代码着色、bash/python/nodejs 关键字·字符串·注释·数字分段、
 * 分段拼回原文完整（不丢字/不重叠）、未闭合字符串宽匹配。
 */
import { describe, expect, it } from "vitest";
import { highlightSegments } from "@/domains/ai/orchestration/lib/prompt-highlight";

const joined = (text: string, lang: Parameters<typeof highlightSegments>[1]) =>
  highlightSegments(text, lang)
    .map((seg) => seg.text)
    .join("");

describe("highlightSegments 变量表达式", () => {
  it("合法占位符高亮为 variable；非法 {{...}} 保持 plain", () => {
    const segs = highlightSegments(
      "主题 {{input.topic}} 上游 {{nodes.collect.output}} {{date}} {{nope}}",
      "prompt",
    );
    expect(segs).toContainEqual({ text: "{{input.topic}}", kind: "variable" });
    expect(segs).toContainEqual({
      text: "{{nodes.collect.output}}",
      kind: "variable",
    });
    expect(segs).toContainEqual({ text: "{{date}}", kind: "variable" });
    expect(segs.find((s) => s.text.includes("nope"))?.kind).toBe("plain");
  });

  it("prompt 语言不做代码着色（echo 等保持 plain）", () => {
    const segs = highlightSegments("echo 'x' # c", "prompt");
    expect(
      segs.every((seg) => seg.kind === "variable" || seg.kind === "plain"),
    ).toBe(true);
  });
});

describe("highlightSegments 代码语言", () => {
  it("bash：关键字/字符串/注释/变量并存分段", () => {
    const segs = highlightSegments(
      'if [ -f x ]; then echo "hi {{input.name}}"; fi # tail',
      "bash",
    );
    expect(segs).toContainEqual({ text: "if", kind: "keyword" });
    expect(segs).toContainEqual({ text: "then", kind: "keyword" });
    expect(segs).toContainEqual({ text: "echo", kind: "keyword" });
    expect(segs.find((s) => s.text.startsWith('"hi'))?.kind).toBe("string");
    expect(segs.find((s) => s.text.startsWith("# tail"))?.kind).toBe("comment");
    expect(segs.find((s) => s.text === "{{input.name}}")?.kind).toBe(
      "variable",
    );
  });

  it("python：def/import/数字；nodejs：const/模板串/块注释行", () => {
    const py = highlightSegments("def run(n):\n  return n + 3.5", "python");
    expect(py).toContainEqual({ text: "def", kind: "keyword" });
    expect(py).toContainEqual({ text: "return", kind: "keyword" });
    expect(py).toContainEqual({ text: "3.5", kind: "number" });

    const js = highlightSegments(
      "const s = `v=${x}`; // note\nimport fs from 'node:fs';",
      "nodejs",
    );
    expect(js).toContainEqual({ text: "const", kind: "keyword" });
    expect(js).toContainEqual({ text: "import", kind: "keyword" });
    expect(js).toContainEqual({ text: "'node:fs'", kind: "string" });
    expect(js.find((s) => s.text.startsWith("// note"))?.kind).toBe("comment");
  });

  it("未闭合字符串宽匹配到串尾不丢字；未闭合跨行截到行尾", () => {
    expect(joined('echo "unclosed', "bash")).toBe('echo "unclosed');
    expect(joined('x = "a\nb', "python")).toBe('x = "a\nb');
  });

  it("分段拼回原文完整（含中文/表情/连续符号）", () => {
    for (const lang of ["prompt", "bash", "python", "nodejs"] as const) {
      const text = "汇总 {{input.topic}}！let's ${x} 100% `t` #注\n\tend";
      expect(joined(text, lang)).toBe(text);
    }
  });

  it("空串返回空数组", () => {
    expect(highlightSegments("", "bash")).toEqual([]);
  });
});
