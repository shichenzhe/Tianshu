/**
 * splitFileRefPrefix/fileRefBasename 纯函数单测：与
 * build-injected-content（tests/ai/build-injected-content.test.ts）的
 * [引用文件] 前缀产出互为正逆——发送拼装的前缀段渲染层可无损拆回。
 * 覆盖引用式（fileRef）与内容注入式两种形态。
 */
import { describe, expect, it } from "vitest";

import {
  fileRefBasename,
  splitFileRefPrefix,
} from "@/domains/ai/chat/lib/file-ref-lines";

const REF = (path: string) =>
  `[引用文件 ${path}]（请用 read_file 工具读取该文件后处理）`;
const INJECTED = (path: string, content: string) =>
  `[引用文件 ${path}]\n${content}`;

describe("splitFileRefPrefix", () => {
  it("头部连续引用式段全部拆出，余文原样保留", () => {
    expect(
      splitFileRefPrefix(`${REF("src/a.ts")}\n\n${REF("docs/b.md")}\n\n正文`),
    ).toEqual({ refs: ["src/a.ts", "docs/b.md"], rest: "正文" });
  });

  it("内容注入式段拆出路径头，注入全文不进气泡余文", () => {
    expect(
      splitFileRefPrefix(`${INJECTED("/tmp/a.md", "AAA")}\n\n正文`),
    ).toEqual({ refs: ["/tmp/a.md"], rest: "正文" });
  });

  it("引用式与内容注入式混排：逐段拆出保序，技能段留在余文", () => {
    expect(
      splitFileRefPrefix(
        `${REF("src/a.ts")}\n\n${INJECTED("/tmp/b.md", "BBB")}\n\n` +
          "[引用技能 s]\nSSS\n\n正文",
      ),
    ).toEqual({
      refs: ["src/a.ts", "/tmp/b.md"],
      rest: "[引用技能 s]\nSSS\n\n正文",
    });
  });

  it("无引用原样返回（rest 即原文）", () => {
    expect(splitFileRefPrefix("正文")).toEqual({ refs: [], rest: "正文" });
    expect(splitFileRefPrefix("")).toEqual({ refs: [], rest: "" });
  });

  it("首个不匹配段即止：正文中段的同款行不拆（防误伤）", () => {
    const text = `请看：\n\n${REF("a.ts")}`;
    expect(splitFileRefPrefix(text)).toEqual({ refs: [], rest: text });
    const mid = `开头\n\n${INJECTED("a.ts", "AAA")}`;
    expect(splitFileRefPrefix(mid)).toEqual({ refs: [], rest: mid });
  });

  it("技能/待办前缀不拆，保持原样显示", () => {
    expect(splitFileRefPrefix("[引用技能 联网搜索]\nBBB\n\n正文")).toEqual({
      refs: [],
      rest: "[引用技能 联网搜索]\nBBB\n\n正文",
    });
    expect(splitFileRefPrefix("[引用待办 待办#5]\n摘要\n\n正文")).toEqual({
      refs: [],
      rest: "[引用待办 待办#5]\n摘要\n\n正文",
    });
  });

  it("仅引用无正文：余文为空串（含尾随分隔空行产物）", () => {
    expect(splitFileRefPrefix(REF("a.ts"))).toEqual({
      refs: ["a.ts"],
      rest: "",
    });
    expect(splitFileRefPrefix(`${REF("a.ts")}\n\n`)).toEqual({
      refs: ["a.ts"],
      rest: "",
    });
    expect(splitFileRefPrefix(INJECTED("a.ts", "AAA"))).toEqual({
      refs: ["a.ts"],
      rest: "",
    });
  });

  it("路径含空格/方括号可完整提取", () => {
    expect(splitFileRefPrefix(`${REF("my file [v2].ts")}\n\n正文`)).toEqual({
      refs: ["my file [v2].ts"],
      rest: "正文",
    });
    expect(
      splitFileRefPrefix(`${INJECTED("my file [v2].ts", "AAA")}\n\n正文`),
    ).toEqual({ refs: ["my file [v2].ts"], rest: "正文" });
  });

  it("正文自身多段空行结构保留", () => {
    expect(splitFileRefPrefix(`${REF("a.ts")}\n\n第一段\n\n第二段`)).toEqual({
      refs: ["a.ts"],
      rest: "第一段\n\n第二段",
    });
  });

  it("与 buildInjectedContent 正逆闭环：两种形态注入产物拆回引用与正文", () => {
    expect(
      splitFileRefPrefix(
        `${REF("src/a.ts")}\n\n${INJECTED("docs/b.md", "B")}\n\n正文`,
      ),
    ).toEqual({ refs: ["src/a.ts", "docs/b.md"], rest: "正文" });
  });
});

describe("fileRefBasename", () => {
  it("取末段（正/反斜杠分隔）", () => {
    expect(fileRefBasename("src/components/a.tsx")).toBe("a.tsx");
    expect(fileRefBasename("src\\components\\a.tsx")).toBe("a.tsx");
    expect(fileRefBasename("README.md")).toBe("README.md");
  });

  it("尾部分隔符/空路径兜底", () => {
    expect(fileRefBasename("src/")).toBe("src");
    expect(fileRefBasename("")).toBe("");
  });
});
