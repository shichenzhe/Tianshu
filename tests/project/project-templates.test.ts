import { describe, expect, it } from "vitest";
import { PROJECT_TEMPLATES, getTemplate } from "../../src-react/domains/project/model/project-templates";

describe("内置模版", () => {
  it("key 唯一", () => {
    const keys = PROJECT_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("含空白项目模版且 prompt 为空串", () => {
    const blank = PROJECT_TEMPLATES.find((t) => t.key === "blank");
    expect(blank?.prompt).toBe("");
    expect(blank?.welcome).not.toBe("");
  });
  it("非空白模版 prompt 与 welcome 非空", () => {
    for (const t of PROJECT_TEMPLATES.filter((x) => x.key !== "blank")) {
      expect(t.prompt.length).toBeGreaterThan(0);
      expect(t.welcome.length).toBeGreaterThan(0);
    }
  });
  it("getTemplate 未知 key 返回 undefined", () => {
    expect(getTemplate("nope")).toBeUndefined();
  });
});
