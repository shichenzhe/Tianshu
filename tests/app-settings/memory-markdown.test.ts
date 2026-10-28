import { describe, expect, it } from "vitest";

import {
  MEMORY_PROFILE_LIMIT,
  buildMemoryMarkdown,
  hasMemoryHeadings,
  mergeMemoryMarkdown,
  parseMemoryMarkdown,
  sortRecentEntries,
  stripCodeFence,
  truncateMemoryMarkdown,
} from "../../src-react/domains/app-settings/model/memory-markdown";

const FULL = [
  "## 工作背景",
  "用户参与 Tianshu 项目",
  "",
  "## 个人背景",
  "用户位于福建厦门",
  "",
  "## 当前关注",
  "[2026-09-08] - UI 界面复刻",
  "",
  "## 近期动态",
  "[2026-09-08] - 推进 Tianshu 工作",
  "[2026-09-07] - 查询厦门天气",
].join("\n");

describe("stripCodeFence", () => {
  it("剥离 ``` 围栏保留内部", () => {
    expect(stripCodeFence("```\n## 工作背景\nx\n```")).toBe("## 工作背景\nx");
  });
  it("无围栏原样返回", () => {
    expect(stripCodeFence("## 工作背景")).toBe("## 工作背景");
  });
});

describe("hasMemoryHeadings", () => {
  it("含四节标题行（含无空格/行首空白写法）", () => {
    expect(hasMemoryHeadings("## 近期动态\nx")).toBe(true);
    expect(hasMemoryHeadings("##工作背景")).toBe(true);
    expect(hasMemoryHeadings("  ## 个人背景")).toBe(true);
  });
  it("无任何标题（纯文本/未知标题/空）为 false", () => {
    expect(hasMemoryHeadings("只是一段文本")).toBe(false);
    expect(hasMemoryHeadings("## 其他\nb")).toBe(false);
    expect(hasMemoryHeadings("")).toBe(false);
  });
});

describe("parseMemoryMarkdown", () => {
  it("四节标准切分", () => {
    const s = parseMemoryMarkdown(FULL);
    expect(s.work).toBe("用户参与 Tianshu 项目");
    expect(s.personal).toBe("用户位于福建厦门");
    expect(s.current).toBe("[2026-09-08] - UI 界面复刻");
    expect(s.recent).toBe(
      "[2026-09-08] - 推进 Tianshu 工作\n[2026-09-07] - 查询厦门天气",
    );
  });
  it("缺节为空串", () => {
    const s = parseMemoryMarkdown("## 个人背景\n厦门");
    expect(s.work).toBe("");
    expect(s.personal).toBe("厦门");
  });
  it("完全无标题 → 全部进 work", () => {
    expect(parseMemoryMarkdown("只是一段文本").work).toBe("只是一段文本");
  });
  it("未知标题行视为普通文本留在当前节", () => {
    const s = parseMemoryMarkdown("## 工作背景\na\n## 其他\nb");
    expect(s.work).toBe("a\n## 其他\nb");
  });
  it("空输入四节皆空", () => {
    expect(parseMemoryMarkdown("")).toEqual({
      work: "",
      personal: "",
      current: "",
      recent: "",
    });
  });
});

describe("buildMemoryMarkdown", () => {
  it("固定节序拼接、空节跳过", () => {
    expect(
      buildMemoryMarkdown({
        work: "a",
        personal: "",
        current: "c",
        recent: "r",
      }),
    ).toBe("## 工作背景\na\n\n## 当前关注\nc\n\n## 近期动态\nr");
  });
});

describe("truncateMemoryMarkdown", () => {
  it("超限从头部截断保尾部", () => {
    const md = "a".repeat(100);
    expect(truncateMemoryMarkdown(md, 10)).toHaveLength(10);
    expect(truncateMemoryMarkdown(md, 10)).toBe(md.slice(90));
  });
  it("未超限原样返回", () => {
    expect(truncateMemoryMarkdown("abc", 10)).toBe("abc");
  });
  it("默认限长 MEMORY_PROFILE_LIMIT", () => {
    expect(MEMORY_PROFILE_LIMIT).toBe(8000);
    expect(truncateMemoryMarkdown("x".repeat(9000)).length).toBe(
      MEMORY_PROFILE_LIMIT,
    );
  });
});

describe("sortRecentEntries", () => {
  it("按日期倒序、无日期行沉底且保序", () => {
    const text = ["无日期行", "[2026-09-07] - b", "[2026-09-08] - a"].join(
      "\n",
    );
    expect(sortRecentEntries(text)).toBe(
      "[2026-09-08] - a\n[2026-09-07] - b\n无日期行",
    );
  });
});

describe("mergeMemoryMarkdown", () => {
  it("三节追加、近期动态合并按日期倒序", () => {
    const merged = mergeMemoryMarkdown(
      FULL,
      "## 个人背景\n新条目\n\n## 近期动态\n[2026-09-09] - 新动态",
    );
    expect(merged).toContain("用户位于福建厦门");
    expect(merged).toContain("新条目");
    expect(parseMemoryMarkdown(merged).recent.split("\n")[0]).toBe(
      "[2026-09-09] - 新动态",
    );
  });
  it("incoming 无标题 → 全部并入 work", () => {
    const merged = mergeMemoryMarkdown(FULL, "散装文本");
    expect(parseMemoryMarkdown(merged).work).toContain("散装文本");
  });
});
