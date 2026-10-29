import { describe, expect, it } from "vitest";

import {
  buildInjectedContent,
  fileRefBasename,
  splitFileRefPrefix,
} from "./file-refs";

describe("buildInjectedContent（LT-T4，对齐桌面注入语义）", () => {
  it("无引用原样返回；单引用前缀块 + \\n\\n 分隔原文", () => {
    expect(buildInjectedContent("你好", [])).toBe("你好");
    expect(
      buildInjectedContent("你好", [{ path: "a.ts", content: "内容A" }]),
    ).toBe("[引用文件 a.ts]\n内容A\n\n你好");
  });

  it("多引用块间 \\n\\n 分隔，整体与原文 \\n\\n 分隔", () => {
    expect(
      buildInjectedContent("问", [
        { path: "a.ts", content: "A" },
        { path: "sub/b.md", content: "B" },
      ]),
    ).toBe("[引用文件 a.ts]\nA\n\n[引用文件 sub/b.md]\nB\n\n问");
  });

  it("技能引用 kind 语义前缀（对齐桌面 referencePrefix），与文件混排保序", () => {
    expect(
      buildInjectedContent("跑", [
        { path: "pdf-extract", content: "技能体", kind: "skill" },
      ]),
    ).toBe("[引用技能 pdf-extract]\n技能体\n\n跑");
    expect(
      buildInjectedContent("跑", [
        { path: "a.ts", content: "A" },
        { path: "pdf-extract", content: "技能体", kind: "skill" },
      ]),
    ).toBe("[引用文件 a.ts]\nA\n\n[引用技能 pdf-extract]\n技能体\n\n跑");
  });

  it("工作空间引用式 kind fileRef：只注路径 + read 指示，不注内容", () => {
    expect(
      buildInjectedContent("看下", [
        { path: "src/main.ts", content: "", kind: "fileRef" },
      ]),
    ).toBe(
      "[引用文件 src/main.ts]（请用 read 工具读取该文件后处理）\n\n看下",
    );
    // content 忽略（引用式不注内容——即便误传）
    expect(
      buildInjectedContent("看下", [
        { path: "a.ts", content: "不该出现", kind: "fileRef" },
        { path: "s", content: "技能体", kind: "skill" },
      ]),
    ).toBe(
      "[引用文件 a.ts]（请用 read 工具读取该文件后处理）\n\n" +
        "[引用技能 s]\n技能体\n\n看下",
    );
  });
});

describe("splitFileRefPrefix（渲染层拆分，与注入互为正逆——对齐桌面 file-ref-lines）", () => {
  it("头部连续引用式段全部拆出，余文原样保留", () => {
    expect(
      splitFileRefPrefix(
        "[引用文件 src/a.ts]（请用 read 工具读取该文件后处理）\n\n" +
          "[引用文件 docs/b.md]（请用 read 工具读取该文件后处理）\n\n正文",
      ),
    ).toEqual({
      refs: [
        { path: "src/a.ts", kind: "file" },
        { path: "docs/b.md", kind: "file" },
      ],
      rest: "正文",
    });
  });

  it("无引用原样返回；空文本余文为空串", () => {
    expect(splitFileRefPrefix("正文")).toEqual({ refs: [], rest: "正文" });
    expect(splitFileRefPrefix("")).toEqual({ refs: [], rest: "" });
  });

  it("正文中段的同款行不拆（首个不匹配段即止，防误伤）", () => {
    const text =
      "请看：\n\n[引用文件 a.ts]（请用 read 工具读取该文件后处理）";
    expect(splitFileRefPrefix(text)).toEqual({ refs: [], rest: text });
    const mid = "开头\n\n[引用文件 a.ts]\nAAA";
    expect(splitFileRefPrefix(mid)).toEqual({ refs: [], rest: mid });
  });

  it("内容注入式段拆出路径头（注入全文不进气泡）", () => {
    expect(splitFileRefPrefix("[引用文件 /tmp/a.md]\nAAA\n\n正文")).toEqual({
      refs: [{ path: "/tmp/a.md", kind: "file" }],
      rest: "正文",
    });
  });

  it("纯技能引用拆出技能名（kind skill），技能全文不进 rest", () => {
    expect(
      splitFileRefPrefix("[引用技能 pdf-extract]\n技能全文内容\n\n正文"),
    ).toEqual({
      refs: [{ path: "pdf-extract", kind: "skill" }],
      rest: "正文",
    });
    // 仅技能无正文：余文为空串（纯引用不渲染空气泡）
    expect(splitFileRefPrefix("[引用技能 pdf-extract]\n技能全文")).toEqual({
      refs: [{ path: "pdf-extract", kind: "skill" }],
      rest: "",
    });
  });

  it("正文中段手打技能前缀行不拆（首个不匹配段即止，防误伤）", () => {
    const mid = "请用这个技能：\n\n[引用技能 s]\n技能体";
    expect(splitFileRefPrefix(mid)).toEqual({ refs: [], rest: mid });
    // 无空行分隔的行内同款文本同样不拆（段首行整体匹配才命中）
    const inline = "正文 [引用技能 s]\n技能体";
    expect(splitFileRefPrefix(inline)).toEqual({ refs: [], rest: inline });
  });

  it("引用式与内容注入式混排：逐段拆出保序（file kind）", () => {
    expect(
      splitFileRefPrefix(
        "[引用文件 src/a.ts]（请用 read 工具读取该文件后处理）\n\n" +
          "[引用文件 /tmp/b.md]\nBBB\n\n正文",
      ),
    ).toEqual({
      refs: [
        { path: "src/a.ts", kind: "file" },
        { path: "/tmp/b.md", kind: "file" },
      ],
      rest: "正文",
    });
  });

  it("技能与文件混排逐段拆出保序（file/skill kind 分明）", () => {
    expect(
      splitFileRefPrefix(
        "[引用文件 src/a.ts]（请用 read 工具读取该文件后处理）\n\n" +
          "[引用技能 s]\n技能体\n\n" +
          "[引用文件 /tmp/b.md]\nBBB\n\n正文",
      ),
    ).toEqual({
      refs: [
        { path: "src/a.ts", kind: "file" },
        { path: "s", kind: "skill" },
        { path: "/tmp/b.md", kind: "file" },
      ],
      rest: "正文",
    });
  });

  it("与 buildInjectedContent 正逆闭环：两种形态注入产物拆回引用与正文", () => {
    const injected = buildInjectedContent("正文", [
      { path: "src/a.ts", content: "", kind: "fileRef" },
      { path: "local.md", content: "本地全文" },
    ]);
    expect(splitFileRefPrefix(injected)).toEqual({
      refs: [
        { path: "src/a.ts", kind: "file" },
        { path: "local.md", kind: "file" },
      ],
      rest: "正文",
    });
  });

  it("与 buildInjectedContent 正逆闭环：技能与文件混注拆回 kind 标注引用", () => {
    const injected = buildInjectedContent("正文", [
      { path: "src/a.ts", content: "", kind: "fileRef" },
      { path: "pdf-extract", content: "技能全文", kind: "skill" },
      { path: "local.md", content: "本地全文" },
    ]);
    expect(splitFileRefPrefix(injected)).toEqual({
      refs: [
        { path: "src/a.ts", kind: "file" },
        { path: "pdf-extract", kind: "skill" },
        { path: "local.md", kind: "file" },
      ],
      rest: "正文",
    });
  });

  it("仅引用无正文：余文为空串（含尾随分隔空行产物）", () => {
    const ref = "[引用文件 a.ts]（请用 read 工具读取该文件后处理）";
    expect(splitFileRefPrefix(ref)).toEqual({
      refs: [{ path: "a.ts", kind: "file" }],
      rest: "",
    });
    expect(splitFileRefPrefix(`${ref}\n\n`)).toEqual({
      refs: [{ path: "a.ts", kind: "file" }],
      rest: "",
    });
    expect(splitFileRefPrefix("[引用文件 a.ts]\nAAA")).toEqual({
      refs: [{ path: "a.ts", kind: "file" }],
      rest: "",
    });
  });

  it("路径含空格/方括号可完整提取", () => {
    expect(
      splitFileRefPrefix(
        "[引用文件 my file [v2].ts]（请用 read 工具读取该文件后处理）\n\n正文",
      ),
    ).toEqual({
      refs: [{ path: "my file [v2].ts", kind: "file" }],
      rest: "正文",
    });
  });

  it("与 buildInjectedContent 正逆闭环：注入产物拆回原始引用与正文", () => {
    const injected = buildInjectedContent("正文", [
      { path: "src/a.ts", content: "", kind: "fileRef" },
      { path: "docs/b.md", content: "", kind: "fileRef" },
    ]);
    expect(splitFileRefPrefix(injected)).toEqual({
      refs: [
        { path: "src/a.ts", kind: "file" },
        { path: "docs/b.md", kind: "file" },
      ],
      rest: "正文",
    });
  });
});

describe("fileRefBasename", () => {
  it("取末段（正/反斜杠分隔），尾部分隔符/空路径兜底", () => {
    expect(fileRefBasename("src/components/a.tsx")).toBe("a.tsx");
    expect(fileRefBasename("src\\components\\a.tsx")).toBe("a.tsx");
    expect(fileRefBasename("README.md")).toBe("README.md");
    expect(fileRefBasename("src/")).toBe("src");
    expect(fileRefBasename("")).toBe("");
  });
});
