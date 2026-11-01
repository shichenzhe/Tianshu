import { describe, expect, it } from "vitest";

import {
  DEFAULT_TEMPLATE_KEY,
  PROJECT_TEMPLATES,
  getTemplate,
} from "./project-templates";

describe("PROJECT_TEMPLATES（批②：对齐桌面同源四模版）", () => {
  it("四模版 key 唯一，与桌面 key 集一致（wire templateKey 判别）", () => {
    expect(PROJECT_TEMPLATES.map((t) => t.key)).toEqual([
      "prd-workflow",
      "market-research",
      "bug-tracking",
      "blank",
    ]);
  });

  it("getTemplate 命中回模板、未命中 undefined；默认 = 空白（prompt 空）", () => {
    expect(getTemplate("bug-tracking")?.name).toBe("Bug 跟踪");
    expect(getTemplate("nope")).toBeUndefined();
    expect(DEFAULT_TEMPLATE_KEY).toBe("blank");
    expect(getTemplate(DEFAULT_TEMPLATE_KEY)?.prompt).toBe("");
  });

  it("非空白模版 prompt/welcome 非空（create 上送两字段的载荷前提）", () => {
    for (const tpl of PROJECT_TEMPLATES) {
      if (tpl.key === "blank") continue;
      expect(tpl.prompt.length).toBeGreaterThan(0);
      expect(tpl.welcome.length).toBeGreaterThan(0);
    }
  });
});
