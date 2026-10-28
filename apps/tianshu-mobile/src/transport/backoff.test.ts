import { describe, expect, it } from "vitest";
import { nextBackoffMs } from "./backoff";

describe("nextBackoffMs", () => {
  it("1s 起步指数增长封顶 30s", () => {
    expect(nextBackoffMs(0)).toBe(1000);
    expect(nextBackoffMs(1)).toBe(2000);
    expect(nextBackoffMs(4)).toBe(16000);
    expect(nextBackoffMs(5)).toBe(30000);
    expect(nextBackoffMs(20)).toBe(30000);
  });
});
