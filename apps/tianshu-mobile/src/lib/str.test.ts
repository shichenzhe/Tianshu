import { describe, expect, it } from "vitest";

import { cap, kebabToPascal } from "./str";

describe("str 工具", () => {
  it("cap：首字母大写，空串安全", () => {
    expect(cap("invalid")).toBe("Invalid");
    expect(cap("timeout")).toBe("Timeout");
    expect(cap("")).toBe("");
  });

  it("kebabToPascal：四类 reason → reasonXxx i18n key 驼峰段", () => {
    expect(kebabToPascal("invalid-config")).toBe("InvalidConfig");
    expect(kebabToPascal("invalid-token")).toBe("InvalidToken");
    expect(kebabToPascal("unreachable")).toBe("Unreachable");
    expect(kebabToPascal("timeout")).toBe("Timeout");
  });

  it("kebabToPascal：六态 state → stateXxx i18n key 驼峰段", () => {
    expect(kebabToPascal("idle")).toBe("Idle");
    expect(kebabToPascal("reconnecting")).toBe("Reconnecting");
    expect(kebabToPascal("invalid-token")).toBe("InvalidToken");
  });
});
