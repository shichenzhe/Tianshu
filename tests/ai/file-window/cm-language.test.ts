/**
 * cm-language（T24，spec §14 项 1/4）：扩展名 → CM6 语言映射（未收录回落
 * text）+ 语言包懒加载（text 无扩展）。
 */
import { describe, expect, it } from "vitest";

import {
  cmLanguageOfPath,
  loadCmLanguage,
} from "../../../src-react/domains/ai/file-window/lib/cm-language";

describe("cmLanguageOfPath", () => {
  it("按扩展名映射（含目录路径/大小写）", () => {
    const cases: Array<[string, string]> = [
      ["a.md", "markdown"],
      ["README.markdown", "markdown"],
      ["dir/sub/x.md", "markdown"],
      ["cfg.JSON", "json"],
      ["i.html", "html"],
      ["j.htm", "html"],
      ["App.vue", "html"],
      ["s.css", "css"],
      ["t.scss", "css"],
      ["m.js", "javascript"],
      ["m.mjs", "javascript"],
      ["a.ts", "javascript"],
      ["b.tsx", "javascript"],
      ["c.jsx", "javascript"],
      ["t.py", "python"],
    ];
    for (const [path, lang] of cases) {
      expect(cmLanguageOfPath(path), path).toBe(lang);
    }
  });

  it("未收录扩展/无扩展回落 text", () => {
    expect(cmLanguageOfPath("notes.txt")).toBe("text");
    expect(cmLanguageOfPath("big.log")).toBe("text");
    expect(cmLanguageOfPath("Makefile")).toBe("text");
    expect(cmLanguageOfPath("")).toBe("text");
  });

  it("loadCmLanguage：text → null；语言包真身懒加载", async () => {
    expect(await loadCmLanguage("text")).toBeNull();
    expect(await loadCmLanguage("markdown")).toBeTruthy();
    expect(await loadCmLanguage("python")).toBeTruthy();
  });
});
