/**
 * 项目记忆纯函数单测（批8 P0，设计文档 §6 P0）：
 * - 条目渲染形态：标记行锚定 + 本地时间标题 + 摘要 + 产出物索引；
 *   内容字段剥离标记前缀（防摘要正文伪造条目边界拆段）
 * - 文件合并：首建含固定头、追加在尾（时间序）、超上限裁最旧
 * - 正文提取（system 注入用）：剥固定头、空归 null、
 *   超字符预算从最旧整段丢弃（至少保最新一段）
 */
import { describe, expect, it } from "vitest";
import {
  extractMemoryBody,
  MEMORY_ENTRY_MARKER_PREFIX,
  MEMORY_FILE,
  MEMORY_HEADER,
  MEMORY_MAX_ENTRIES,
  MEMORY_PROMPT_CHAR_LIMIT,
  mergeMemoryContent,
  parseMemorySections,
  renderMemoryEntry,
} from "../../electron/domains/project/project-memory";

const AT = new Date("2026-11-05T06:30:00.000Z");

describe("renderMemoryEntry", () => {
  it("标记行在段首 + 本地时间标题 + 摘要 + 产出物索引", () => {
    const markdown = renderMemoryEntry(
      {
        title: "项目交接",
        summary: "## 关键结论\n已敲定方案",
        artifacts: ["attachments/spec.pdf", "docs/设计.md"],
      },
      AT,
    );
    // 本地时区相关：仅断言日期段格式与标题，不断言绝对时刻
    expect(markdown.startsWith(MEMORY_ENTRY_MARKER_PREFIX)).toBe(true);
    expect(markdown).toContain("2026-11-05");
    expect(markdown).toMatch(/## \[2026-11-05 [0-9]{2}:[0-9]{2}\] 项目交接/);
    expect(markdown).toContain("## 关键结论\n已敲定方案");
    expect(markdown).toContain("产出物：");
    expect(markdown).toContain("- attachments/spec.pdf");
    expect(markdown).toContain("- docs/设计.md");
  });

  it("无摘要/无产出物 → 仅标题行；空白产出物被过滤", () => {
    const markdown = renderMemoryEntry(
      { title: "空产出", summary: "", artifacts: ["  ", ""] },
      AT,
    );
    expect(markdown).toContain("] 空产出");
    expect(markdown).not.toContain("产出物：");
  });

  it("内容字段含标记前缀 → 被剥离（防伪造条目边界）", () => {
    const malicious = `${MEMORY_ENTRY_MARKER_PREFIX}2099-01-01T00:00:00.000Z -->\n## 假条目`;
    const markdown = renderMemoryEntry(
      { title: malicious, summary: malicious },
      AT,
    );
    const sections = parseMemorySections(markdown);
    expect(sections).toHaveLength(1);
    expect(markdown).toContain("假条目"); // 内容保留（仅边界失效）
    // 段首标记行唯一（伪造前缀不再成段）
    expect(markdown.match(/^<!-- tianshu:memory-entry /gm)).toHaveLength(1);
  });
});

describe("mergeMemoryContent", () => {
  it("首建：固定头 + 单条目", () => {
    const content = mergeMemoryContent(
      null,
      { title: "首次", summary: "结论" },
      AT,
    );
    expect(content).toContain("# 项目记忆");
    expect(content).toContain("] 首次");
    expect(content).toContain("结论");
    expect(parseMemorySections(content)).toHaveLength(1);
  });

  it("追加在尾（时间序）：旧条目在前、新条目在后", () => {
    const first = mergeMemoryContent(
      null,
      { title: "旧条目", summary: "a" },
      AT,
    );
    const second = mergeMemoryContent(
      first,
      { title: "新条目", summary: "b" },
      AT,
    );
    expect(second.indexOf("旧条目")).toBeLessThan(second.indexOf("新条目"));
    expect(parseMemorySections(second)).toHaveLength(2);
  });

  it("超上限裁最旧：恒保留最新 MEMORY_MAX_ENTRIES 条", () => {
    let content: string | null = null;
    for (let index = 1; index <= MEMORY_MAX_ENTRIES + 2; index += 1) {
      content = mergeMemoryContent(
        content,
        { title: `条目${index}`, summary: "s" },
        AT,
      );
    }
    const sections = parseMemorySections(content);
    expect(sections).toHaveLength(MEMORY_MAX_ENTRIES);
    // 「条目1」为「条目1x」子串：按段首条目标题断言（最旧两条被裁）
    expect(sections[0]).toMatch(/\] 条目3$/m);
    expect(sections[0]).not.toMatch(/\] 条目1 /);
    expect(content).toContain(`条目${MEMORY_MAX_ENTRIES + 2}`);
  });
});

describe("extractMemoryBody", () => {
  it("剥固定头返回条目正文；空内容归 null", () => {
    const content = mergeMemoryContent(
      null,
      { title: "条目", summary: "决议" },
      AT,
    );
    const body = extractMemoryBody(content);
    expect(body).not.toContain("# 项目记忆");
    expect(body).toContain("] 条目");
    expect(extractMemoryBody(null)).toBeNull();
    expect(extractMemoryBody("# 项目记忆（AI 沉淀）\n\n> 说明")).toBeNull();
  });

  it("超字符预算：从最旧整段丢弃，至少保最新一段", () => {
    let content: string | null = null;
    for (let index = 1; index <= 5; index += 1) {
      content = mergeMemoryContent(
        content,
        {
          title: `条目${index}`,
          summary: "x".repeat(MEMORY_PROMPT_CHAR_LIMIT / 2),
        },
        AT,
      );
    }
    const body = extractMemoryBody(content);
    // 每段约预算一半 → 至多两段且总量受控；最新必在
    expect(body).toContain("条目5");
    expect(body!.length).toBeLessThanOrEqual(
      MEMORY_PROMPT_CHAR_LIMIT + MEMORY_PROMPT_CHAR_LIMIT / 2 + 64,
    );
    expect(body).not.toContain("条目1");
  });
});

describe("常量", () => {
  it("文件名与上限暴露稳定（消费方引用）", () => {
    expect(MEMORY_FILE).toBe("memory.md");
    expect(MEMORY_MAX_ENTRIES).toBeGreaterThan(0);
  });
});

/* ---------- 修复环 R1：memory.md 人工内容跨 append 保留 ---------- */

describe("mergeMemoryContent 人工内容保留（修复环 R1）", () => {
  const entryOf = (title: string, summary: string) => ({
    title,
    summary,
  });

  it("头部区人工小节跨 append 存活（位置不变，条目照常追加）", () => {
    const base = mergeMemoryContent(null, entryOf("条目一", "a"), AT);
    const edited = [
      MEMORY_HEADER,
      "## 人工小节",
      "自定义备注",
      parseMemorySections(base)[0],
    ].join("\n\n");
    const next = mergeMemoryContent(edited, entryOf("条目二", "b"), AT);
    expect(next).toContain("## 人工小节");
    expect(next).toContain("自定义备注");
    // 头部区仍在条目之前
    expect(next.indexOf("人工小节")).toBeLessThan(next.indexOf("条目一"));
    expect(parseMemorySections(next)).toHaveLength(2);
  });

  it("文末人工补记跨 append 存活（并入末条目段，位于新条目之前）", () => {
    const base = mergeMemoryContent(null, entryOf("条目一", "a"), AT);
    const edited = `${base}\n\n## 文末补记\n手动备注`;
    const next = mergeMemoryContent(edited, entryOf("条目二", "b"), AT);
    expect(next).toContain("文末补记");
    expect(next.indexOf("文末补记")).toBeLessThan(next.indexOf("条目二"));
    expect(parseMemorySections(next)).toHaveLength(2);
  });

  it("删除某条目的标记行：该段正文并入前一节保留，其余条目不清零", () => {
    let content: string | null = null;
    for (const [title, summary] of [
      ["一", "s1"],
      ["二", "s2"],
      ["三", "s3"],
    ] as const) {
      content = mergeMemoryContent(content, entryOf(title, summary), AT);
    }
    const sections = parseMemorySections(content);
    // 用户删掉第二条目的标记行（正文失去自己的段头）
    const orphanBody = sections[1].split("\n").slice(1).join("\n").trim();
    const edited = [MEMORY_HEADER, sections[0], orphanBody, sections[2]].join(
      "\n\n",
    );
    const next = mergeMemoryContent(edited, entryOf("四", "s4"), AT);
    expect(next).toContain("s1");
    expect(next).toContain("s2"); // 被删标记行的正文未清零
    expect(next).toContain("s3");
    expect(parseMemorySections(next)).toHaveLength(3); // 一(含二正文)、三、四
  });

  it("人工改写固定头 → 用户版本胜出（不回落注入标准头）", () => {
    const base = mergeMemoryContent(null, entryOf("一", "a"), AT);
    const edited = base.replace("# 项目记忆（AI 沉淀）", "# 我的项目笔记");
    const next = mergeMemoryContent(edited, entryOf("二", "b"), AT);
    expect(next.startsWith("# 我的项目笔记")).toBe(true);
    expect(next).not.toContain("# 项目记忆（AI 沉淀）");
  });

  it("未编辑的固定头 → 重写仍为单一标准头（不重复注入）", () => {
    const base = mergeMemoryContent(null, entryOf("一", "a"), AT);
    const next = mergeMemoryContent(base, entryOf("二", "b"), AT);
    expect(next.startsWith(MEMORY_HEADER)).toBe(true);
    expect(next.match(/# 项目记忆/g)).toHaveLength(1);
  });
});
