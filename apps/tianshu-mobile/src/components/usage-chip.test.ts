import { describe, expect, it } from "vitest";

import { usageShort } from "../logic/usage-short";

describe("usageShort（MT-T1）", () => {
  it("千分位缩写：<1000 原样；k/M 一位小数", () => {
    expect(usageShort(999)).toBe("999");
    expect(usageShort(1000)).toBe("1.0k");
    expect(usageShort(1234)).toBe("1.2k");
    expect(usageShort(3_200_000)).toBe("3.2M");
  });
});
