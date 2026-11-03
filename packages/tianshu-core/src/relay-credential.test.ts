// relay 多租户（spec §5.4）：shouldRenew 续期判断纯函数四态矩阵——
// 刚签发（剩 100%）→ false；剩 49% → true；剩 51% → false；已过期 → true。
// 语义：剩余寿命 < 半个 maxAge 即应续期（严格小于，恰 50% 不续）。
import { describe, expect, it } from "vitest";

import { shouldRenew } from "./relay-credential";

const MAX_AGE_SEC = 3600;
const ISSUED_MS = 1_700_000_000_000;
const EXPIRES_MS = ISSUED_MS + MAX_AGE_SEC * 1000;

describe("shouldRenew（relay 凭据续期判断）", () => {
  it("刚签发（剩 100%）→ false", () => {
    expect(shouldRenew(EXPIRES_MS, MAX_AGE_SEC, ISSUED_MS)).toBe(false);
  });

  it("剩 49% → true", () => {
    // 已消耗 51%，剩余 49% < 50%
    const nowMs = ISSUED_MS + MAX_AGE_SEC * 1000 * 0.51;
    expect(shouldRenew(EXPIRES_MS, MAX_AGE_SEC, nowMs)).toBe(true);
  });

  it("剩 51% → false", () => {
    // 已消耗 49%，剩余 51% ≥ 50%
    const nowMs = ISSUED_MS + MAX_AGE_SEC * 1000 * 0.49;
    expect(shouldRenew(EXPIRES_MS, MAX_AGE_SEC, nowMs)).toBe(false);
  });

  it("已过期 → true", () => {
    expect(shouldRenew(EXPIRES_MS, MAX_AGE_SEC, EXPIRES_MS + 1000)).toBe(true);
  });
});
