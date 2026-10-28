import { describe, expect, it } from "vitest";

import { parseInline, parseMarkdown } from "./markdown";

describe("parseMarkdown", () => {
  it("空输入返回空数组", () => {
    expect(parseMarkdown("")).toEqual([]);
  });

  it("标题三级：# ## ### 各成节点，#### 不识别回落段落", () => {
    const nodes = parseMarkdown("# 一级\n\n## 二级\n\n### 三级\n\n#### 四级");
    expect(nodes).toEqual([
      { type: "heading", level: 1, text: "一级" },
      { type: "heading", level: 2, text: "二级" },
      { type: "heading", level: 3, text: "三级" },
      { type: "paragraph", text: "#### 四级" },
    ]);
  });

  it("围栏代码块：语言标注与代码体（保留内部空行）", () => {
    const nodes = parseMarkdown("```ts\nconst a = 1;\n\nconst b = 2;\n```");
    expect(nodes).toEqual([
      { type: "code", lang: "ts", code: "const a = 1;\n\nconst b = 2;" },
    ]);
  });

  it("未闭合围栏代码块：容错收至末尾", () => {
    const nodes = parseMarkdown("前文\n\n```\nabc\ndef");
    expect(nodes).toEqual([
      { type: "paragraph", text: "前文" },
      { type: "code", lang: "", code: "abc\ndef" },
    ]);
  });

  it("无序列表：连续行合并单节点，空行隔断成组", () => {
    const nodes = parseMarkdown("- 甲\n- 乙\n\n- 丙");
    expect(nodes).toEqual([
      {
        type: "list",
        ordered: false,
        items: [
          { text: "甲", indent: 0 },
          { text: "乙", indent: 0 },
        ],
      },
      { type: "list", ordered: false, items: [{ text: "丙", indent: 0 }] },
    ]);
  });

  it("有序列表：1. 起始连续编号合并", () => {
    const nodes = parseMarkdown("1. 第一\n2. 第二\n10. 第三");
    expect(nodes).toEqual([
      {
        type: "list",
        ordered: true,
        items: [
          { text: "第一", indent: 0 },
          { text: "第二", indent: 0 },
          { text: "第三", indent: 0 },
        ],
      },
    ]);
  });

  it("引用：连续 > 行合并单节点（> 后空格可缺省）", () => {
    const nodes = parseMarkdown("> 引用一\n>引用二");
    expect(nodes).toEqual([{ type: "quote", text: "引用一\n引用二" }]);
  });

  it("段落：连续普通行合并（保留换行），行内标记原样进文本", () => {
    const nodes = parseMarkdown("第一行\n第二行");
    expect(nodes).toEqual([{ type: "paragraph", text: "第一行\n第二行" }]);
  });

  it("混合文档：标题/段落/列表/代码/引用按序分块", () => {
    const nodes = parseMarkdown(
      "# 标题\n\n段落一\n\n- 项 A\n- 项 B\n\n> 提示\n\n结尾段",
    );
    expect(nodes.map((n) => n.type)).toEqual([
      "heading",
      "paragraph",
      "list",
      "quote",
      "paragraph",
    ]);
  });

  it("表格：表头+分隔行+数据行解析", () => {
    const nodes = parseMarkdown(
      "| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |\n| 香蕉 | 5 |",
    );
    expect(nodes).toEqual([
      {
        type: "table",
        headers: ["名称", "数量"],
        rows: [
          ["苹果", "3"],
          ["香蕉", "5"],
        ],
      },
    ]);
  });

  it("表格：冒号对齐语法与单元格空白容错", () => {
    const nodes = parseMarkdown("|  a  | b |\n| :--- | ---: |\n| 1 | 2 |");
    expect(nodes).toEqual([
      { type: "table", headers: ["a", "b"], rows: [["1", "2"]] },
    ]);
  });

  it("表格：单元格行内标记原样保留（渲染层二次解析）", () => {
    const nodes = parseMarkdown("| x |\n| --- |\n| **粗** `c` |");
    expect(nodes).toEqual([
      { type: "table", headers: ["x"], rows: [["**粗** `c`"]] },
    ]);
  });

  it("表格：无分隔行降级段落（GFM 行为）", () => {
    const nodes = parseMarkdown("| 名称 | 数量 |\n| 苹果 | 3 |");
    expect(nodes).toEqual([
      { type: "paragraph", text: "| 名称 | 数量 |\n| 苹果 | 3 |" },
    ]);
  });

  it("表格：表体遇空行或非 | 行截止，后文独立成块", () => {
    const nodes = parseMarkdown("| a |\n| --- |\n| 1 |\n\n段落");
    expect(nodes).toEqual([
      { type: "table", headers: ["a"], rows: [["1"]] },
      { type: "paragraph", text: "段落" },
    ]);
  });

  it("表格：段落后紧跟表格不吞表头（段落止于表格开头）", () => {
    const nodes = parseMarkdown("前文\n| a |\n| --- |\n| 1 |");
    expect(nodes.map((n) => n.type)).toEqual(["paragraph", "table"]);
  });
});

describe("parseMarkdown 缩进容错与水平分隔线", () => {
  it("缩进无序列表：嵌套层级归并单节点，indent 随空白宽度保留", () => {
    const nodes = parseMarkdown("- 甲\n  - 乙\n    - 丙");
    expect(nodes).toEqual([
      {
        type: "list",
        ordered: false,
        items: [
          { text: "甲", indent: 0 },
          { text: "乙", indent: 1 },
          { text: "丙", indent: 2 },
        ],
      },
    ]);
  });

  it("有序项下挂缩进无序子项：分型各自成节点（嵌套 indent 保留）", () => {
    const nodes = parseMarkdown("1. **项**\n   - **子项**\n     - 孙项");
    expect(nodes).toEqual([
      { type: "list", ordered: true, items: [{ text: "**项**", indent: 0 }] },
      {
        type: "list",
        ordered: false,
        items: [
          { text: "**子项**", indent: 1 },
          { text: "孙项", indent: 2 },
        ],
      },
    ]);
  });

  it("缩进引用与缩进标题：行首空白容错", () => {
    expect(parseMarkdown("  > 提示一\n>提示二")).toEqual([
      { type: "quote", text: "提示一\n提示二" },
    ]);
    expect(parseMarkdown("  ### 深层标题")).toEqual([
      { type: "heading", level: 3, text: "深层标题" },
    ]);
  });

  it("水平分隔线：--- / ***（含尾随空白）成 hr 节点，- 仍为列表", () => {
    const nodes = parseMarkdown("---\n*** \n- 项");
    expect(nodes).toEqual([
      { type: "hr" },
      { type: "hr" },
      { type: "list", ordered: false, items: [{ text: "项", indent: 0 }] },
    ]);
  });

  it("纯缩进普通文本仍进段落（容错仅限块级标记行）", () => {
    expect(parseMarkdown("    普通缩进文本")).toEqual([
      { type: "paragraph", text: "    普通缩进文本" },
    ]);
  });

  it("段落终止于缩进列表行（不吞入段落文本）", () => {
    expect(parseMarkdown("段落文本\n  - 缩进项")).toEqual([
      { type: "paragraph", text: "段落文本" },
      { type: "list", ordered: false, items: [{ text: "缩进项", indent: 1 }] },
    ]);
  });

  it("msg241 真机样例骨架：嵌套列表全部入 list 节点，段落无原始标记残留", () => {
    const sample = [
      "根据当前上下文，总结如下：",
      "",
      "---",
      "",
      "### 核心要点速览",
      "1. **身份与职责**  ",
      "   - **安全运维工程师**（厦门本地）：  ",
      "     - 主要处理**Spring/Tomcat漏洞评估**，",
      "     - **当前紧急任务**：调试 `code_permission_denied` 权限错误。",
      "",
      "2. **关键痛点**  ",
      "   - **优先级**：需立即解决，否则将阻塞 Basic Auth 自动化流程。",
      "",
      "--- ",
      "",
      "> ✨ **提示**：建议今晚内完成验证。",
    ].join("\n");
    const nodes = parseMarkdown(sample);
    expect(nodes.map((n) => n.type)).toEqual([
      "paragraph",
      "hr",
      "heading",
      "list",
      "list",
      "list",
      "list",
      "hr",
      "quote",
    ]);
    for (const node of nodes) {
      if (node.type !== "paragraph") continue;
      for (const line of node.text.split("\n")) {
        expect(/^\s*(-\s|\d+\.\s)/.test(line), line).toBe(false);
      }
    }
  });
});

describe("parseInline", () => {
  it("行内混合：粗体/斜体/代码按出现位置切分", () => {
    const spans = parseInline("a **b** c *d* e `f` g");
    expect(spans).toEqual([
      { type: "text", text: "a " },
      { type: "bold", text: "b" },
      { type: "text", text: " c " },
      { type: "italic", text: "d" },
      { type: "text", text: " e " },
      { type: "code", text: "f" },
      { type: "text", text: " g" },
    ]);
  });

  it("未闭合标记按字面文本输出", () => {
    expect(parseInline("x *y")).toEqual([{ type: "text", text: "x *y" }]);
    expect(parseInline("**粗体没关")).toEqual([
      { type: "text", text: "**粗体没关" },
    ]);
  });

  it("代码_span 内含星号不误判粗斜体；空串与纯文本单 span", () => {
    expect(parseInline("`*`")).toEqual([{ type: "code", text: "*" }]);
    expect(parseInline("")).toEqual([]);
    expect(parseInline("普通文本")).toEqual([{ type: "text", text: "普通文本" }]);
  });

  it("标记跨行不生效（parseInline 只处理单行片段）", () => {
    expect(parseInline("*a\nb*")).toEqual([{ type: "text", text: "*a\nb*" }]);
  });

  it("链接：http 完整解析为 link span", () => {
    expect(parseInline("见 [天枢](https://tianshu.dev) 文档")).toEqual([
      { type: "text", text: "见 " },
      { type: "link", text: "天枢", href: "https://tianshu.dev" },
      { type: "text", text: " 文档" },
    ]);
  });

  it("链接：与粗体混排保序", () => {
    expect(parseInline("**重点** [链接](http://a.b/c)")).toEqual([
      { type: "bold", text: "重点" },
      { type: "text", text: " " },
      { type: "link", text: "链接", href: "http://a.b/c" },
    ]);
  });

  it("链接：非 http(s) 协议按字面文本", () => {
    expect(parseInline("[邮件](mailto:x@y.z)")).toEqual([
      { type: "text", text: "[邮件](mailto:x@y.z)" },
    ]);
  });

  it("链接：未闭合方括号按字面文本", () => {
    expect(parseInline("[裸文本 (https://a.b)")).toEqual([
      { type: "text", text: "[裸文本 (https://a.b)" },
    ]);
  });
});
