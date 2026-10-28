import { describe, expect, it } from "vitest";
import { quickPromptsOf } from "../../../src-react/domains/ai/file-window/lib/quick-prompts";

describe("快捷指令矩阵（spec §6.5）", () => {
  it("md 四条 / text 四条", () => {
    expect(quickPromptsOf("md").map((p) => p.id)).toEqual([
      "summarize",
      "proofread",
      "polish",
      "outline",
    ]);
    expect(quickPromptsOf("text").map((p) => p.id)).toEqual([
      "summarize",
      "proofread",
      "extract",
      "translate",
    ]);
    expect(quickPromptsOf("image").map((p) => p.id)).toEqual([
      "describe",
      "ocr",
      "analyze",
      "qa",
    ]);
    expect(quickPromptsOf("html").map((p) => p.id)).toEqual([
      "summarize",
      "improve",
    ]);
    expect(quickPromptsOf("pdf").map((p) => p.id)).toEqual([
      "summarize",
      "extract",
      "outline",
      "qa",
    ]);
  });

  it("labelKey/promptKey 均落在 fileWindow.prompt.<kind>.*", () => {
    for (const p of quickPromptsOf("md")) {
      expect(p.labelKey).toMatch(/^chat:fileWindow\.prompt\.md\./);
      expect(p.promptKey).toMatch(/^chat:fileWindow\.prompt\.md\./);
    }
  });

  it("未入矩阵的类型（csv/audiovideo）同样无指令", () => {
    expect(quickPromptsOf("csv")).toEqual([]);
    expect(quickPromptsOf("audiovideo")).toEqual([]);
  });
});
