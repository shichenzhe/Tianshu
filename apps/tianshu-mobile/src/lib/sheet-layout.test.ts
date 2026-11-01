import { describe, expect, it } from "vitest";

import { sheetBottomPadding } from "./sheet-layout";

describe("sheetBottomPadding", () => {
  it("无底部安全区时保留 16pt 视觉留白", () => {
    expect(sheetBottomPadding(0)).toBe(16);
  });

  it("有 Home Indicator 时在安全区之外再留 8pt", () => {
    expect(sheetBottomPadding(34)).toBe(42);
  });
});
