import { describe, expect, it } from "vitest";
import { detectPseudoToolCallText } from "../../src-react/domains/ai/chat/lib/pseudo-tool-call";

/** 本地推理服务把 Qwen 工具语法泄进正文的真实样本（issue 复现，DB message #68） */
const REAL_SAMPLE =
  "我来读取工作空间内空内容如下：\n\n```markdown\n\n<tool_call>\n<| 1.\n\n<tool_call>\n<function call 好的，让我查看 readme.md 文件内容为空\n\n<tool_call>\n<tool_call>\n<readme 我来读取工作空间内联华子目录结构如下：\n\n<tool_call>\n<read_file(path:thinking 我来帮你读取工作空间内联华！";

describe("detectPseudoToolCallText 伪工具调用碎片检测", () => {
  it("真实复现样本命中", () => {
    expect(detectPseudoToolCallText(REAL_SAMPLE)).toBe(true);
  });

  it("tool_call 字面量出现 2 次及以上命中（重复尝试特征）", () => {
    expect(detectPseudoToolCallText("a <tool_call> b <tool_call> c")).toBe(
      true,
    );
  });

  it("分词器特殊 token 泄漏（<|）命中", () => {
    expect(detectPseudoToolCallText("正常文字 <|im_end|> 泄漏")).toBe(true);
  });

  it("正常正文不命中", () => {
    expect(detectPseudoToolCallText("readme.md 的内容是空的。")).toBe(false);
    expect(detectPseudoToolCallText("")).toBe(false);
  });

  it("仅出现 1 次 tool_call 字样不命中（讨论语法的正常输出）", () => {
    expect(
      detectPseudoToolCallText(
        "Qwen 的工具调用格式是 <tool_call> 包裹 JSON 的语法。",
      ),
    ).toBe(false);
  });
});
