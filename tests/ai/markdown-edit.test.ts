import { describe, expect, it } from "vitest";
import {
  continueList,
  indentSelection,
  insertCodeBlock,
  insertHr,
  insertLink,
  insertTable,
  toggleHeading,
  toggleLinePrefix,
  toggleWrap,
} from "../../src-react/domains/ai/library/lib/markdown-edit";

describe("toggleWrap", () => {
  it("无选中：插入包裹占位并选中占位", () => {
    expect(toggleWrap("ab", 1, 1, "**", "文本")).toEqual({
      text: "a**文本**b",
      selection: [3, 5],
    });
  });
  it("有选中：包裹并保持选中内容", () => {
    expect(toggleWrap("a bc d", 2, 4, "*", "文本")).toEqual({
      text: "a *bc* d",
      selection: [3, 5],
    });
  });
  it("选区两侧已包裹：去包裹", () => {
    expect(toggleWrap("a **bc** d", 4, 6, "**", "文本")).toEqual({
      text: "a bc d",
      selection: [2, 4],
    });
  });
  it("空选中不误判已有包裹（仅补占位）", () => {
    expect(toggleWrap("****", 2, 2, "**", "文本")).toEqual({
      text: "****文本****",
      selection: [4, 6],
    });
  });
});

describe("toggleLinePrefix", () => {
  it("加前缀（多行选中各行独立加）", () => {
    expect(toggleLinePrefix("a\nb\nc", 0, 9, "> ")).toEqual({
      text: "> a\n> b\n> c",
      selection: [0, 11],
    });
  });
  it("已全带前缀：删除", () => {
    expect(toggleLinePrefix("- a\n- b", 0, 7, "- ")).toEqual({
      text: "a\nb",
      selection: [0, 3],
    });
  });
  it("有序前缀：逐行编号；已有有序则剥离", () => {
    const add = toggleLinePrefix("x\ny", 0, 3, (row) => `${row + 1}. `);
    expect(add.text).toBe("1. x\n2. y");
    const remove = toggleLinePrefix(
      "1. x\n2. y",
      0,
      9,
      (row) => `${row + 1}. `,
    );
    expect(remove.text).toBe("x\ny");
  });
});

describe("toggleHeading", () => {
  it("无级 → 加级；已有他级 → 换级", () => {
    expect(toggleHeading("标题", 0, 2, 2).text).toBe("## 标题");
    expect(toggleHeading("# 标题", 0, 4, 3).text).toBe("### 标题");
  });
  it("同级再点 → 移除", () => {
    expect(toggleHeading("## 标题", 0, 5, 2).text).toBe("标题");
  });
});

describe("insertSnippet 系", () => {
  it("链接：选中文字作标签，url 占位被选中", () => {
    expect(insertLink("看 这里", 1, 3)).toEqual({
      text: "看[ 这](url)里",
      selection: [6, 9],
    });
  });
  it("链接：无选中用占位标签", () => {
    const result = insertLink("ab", 1, 1);
    expect(result.text).toBe("a[链接](url)b");
    expect(result.selection).toEqual([6, 9]);
  });
  it("代码块：上下文非行首/行尾自动补换行，光标停围栏内空行（光标后内容保留）", () => {
    const result = insertCodeBlock("a|b", 1);
    expect(result.text).toBe("a\n```\n\n```\n|b");
    expect(result.selection).toEqual([6, 6]);
  });
  it("表格：3 列模板，光标停首列表头", () => {
    const result = insertTable("x", 1);
    expect(result.text).toBe(
      "x\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n|  |  |  |",
    );
    expect(result.selection).toEqual([4, 6]);
  });
  it("分隔线：block 自带尾换行不补双空行，光标停下一行行首", () => {
    const result = insertHr("ab", 1);
    expect(result.text).toBe("a\n---\nb");
    expect(result.selection).toEqual([6, 6]);
  });
});

describe("continueList（Enter 续行）", () => {
  it("无序列表行尾回车：续同标记", () => {
    const result = continueList("- 一", 4);
    expect(result).toEqual({
      text: "- 一\n- ",
      selection: [7, 7],
    });
  });
  it("有序列表行尾回车：序号 +1（多位数）", () => {
    const result = continueList("12. 项", 5);
    expect(result?.text).toBe("12. 项\n13. ");
  });
  it("缩进保留：嵌套列表续行带同缩进", () => {
    const result = continueList("  - 子项", 6);
    expect(result?.text).toBe("  - 子项\n  - ");
    expect(result?.selection).toEqual([11, 11]);
  });
  it("空项回车：删标记退出列表", () => {
    expect(continueList("- ", 2)).toEqual({ text: "", selection: [0, 0] });
  });
  it("空有序项/空引用回车退出", () => {
    expect(continueList("1. ", 3)?.text).toBe("");
    expect(continueList("> ", 2)?.text).toBe("");
  });
  it("引用非空行尾回车：续 >（规范带空格）", () => {
    const result = continueList("> 引用", 4);
    expect(result?.text).toBe("> 引用\n> ");
  });
  it("光标在行中间：内容带下行（不误删）", () => {
    const result = continueList("> 引用文字", 4);
    expect(result?.text).toBe("> 引用\n> 文字");
  });
  it("非列表/引用行：返回 null（默认回车）", () => {
    expect(continueList("普通文本", 4)).toBeNull();
  });
});

describe("indentSelection", () => {
  it("单点 Tab：光标处插两空格", () => {
    expect(indentSelection("ab", 1, 1, false)).toEqual({
      text: "a  b",
      selection: [3, 3],
    });
  });
  it("单行选区 Tab：仍按选区起点插空格", () => {
    expect(indentSelection("ab", 0, 1, false).text).toBe("  ab");
  });
  it("跨行选区 Tab：逐行行首加两空格", () => {
    const result = indentSelection("a\nb\nc", 0, 5, false);
    expect(result.text).toBe("  a\n  b\n  c");
  });
  it("Shift+Tab：涉及行行首删最多两空格", () => {
    expect(indentSelection("  a\n    b\nc", 0, 10, true).text).toBe(
      "a\n  b\nc",
    );
  });
});
